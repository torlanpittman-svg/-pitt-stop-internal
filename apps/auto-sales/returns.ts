/**
 * Auto-Sales — smart return matching (PURE, no DB, no side effects → unit-testable).
 *
 * When the AI reads a receipt as a return/refund/credit, this scores it against the vehicle's prior
 * PURCHASES and proposes linking it to the specific original expense/line. It is evidence-based and
 * conservative: it auto-proposes only STRONG matches, asks when AMBIGUOUS, and returns NONE (→ save as
 * unmatched, flagged) rather than inventing a link (never fabricate an original purchase).
 *
 * Evidence, strongest→weakest: exact referenced receipt#  >  same SKU + same vendor  >  same item
 * description + vendor + amount + valid date order  >  same vendor + amount (weak, never auto-linked).
 * Double-return is prevented two ways: event-level `remainingCents` (from the ledger) and line-level
 * `alreadyReturnedKeys` (stable line keys already returned on prior return events).
 */

export interface NormalizedLine {
  key: string | null            // stable line key (li_…) if the source document has one
  description: string
  amountCents: number | null    // line total (absolute)
  quantity: number | null
  unitPriceCents: number | null
  sku: string | null
}
export interface PriorPurchase {
  eventId: string
  vendor: string | null
  eventDate: string             // YYYY-MM-DD
  amountCents: number           // this event's amount assigned to the vehicle
  remainingCents: number        // event-level returnable remaining (ledger guard)
  receiptNumber: string | null  // the original document's own receipt/invoice number
  lineItems: NormalizedLine[]
}
export interface ReturnQuery {
  vendor: string | null
  date: string | null
  totalCents: number | null
  receiptNumber: string | null    // the return document's own number
  originalReference: string | null // the ORIGINAL receipt# the return cites, if any
  lineItems: NormalizedLine[]      // returned lines (already narrowed to `returned` where the doc marked them)
}
export interface ReturnCandidate {
  eventId: string
  score: number
  reasons: string[]
  remainingCents: number
  vendor: string | null
  eventDate: string
  amountCents: number
  matchedLine: NormalizedLine | null
  suggestedReturnCents: number | null
  returnedLineRef: string | null  // stable ref to the matched prior line (double-return guard + audit)
  label: string                 // "O'Reilly · 2026-08-22 · $186.40"
  matchedLineLabel: string | null // "Serpentine Belt — $42.18"
}
export interface ReturnMatchResult {
  classification: 'strong' | 'ambiguous' | 'none'
  candidates: ReturnCandidate[]  // ranked best-first, top few
  returnedAmountCents: number | null
  returnedLabel: string | null   // best returned-line/summary label for the UI
}

const STRONG_THRESHOLD = 70
const AMBIGUOUS_THRESHOLD = 30
const STRONG_MARGIN = 25
const AMOUNT_TOL_CENTS = 100 // within $1.00 counts as "same amount" (OCR rounding)

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
const normRef = (s: string | null | undefined) => (s ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
const normSku = (s: string | null | undefined) => (s ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const STOP = new Set(['the', 'and', 'for', 'with', 'a', 'an', 'of', 'to', 'oem', 'part', 'parts', 'assy', 'kit', 'set'])
function tokens(s: string): Set<string> {
  return new Set(norm(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t)))
}
function descSimilarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter) // Jaccard
}
function amountClose(a: number | null | undefined, b: number | null | undefined): boolean {
  return a != null && b != null && Math.abs(a - b) <= AMOUNT_TOL_CENTS
}
/** Stable reference to a specific prior line (prefers its immutable key; else SKU; else desc+amount).
 *  Used both to exclude already-returned lines and to record what a return consumed (double-return guard). */
export function lineRef(eventId: string, l: NormalizedLine): string {
  return `${eventId}:${l.key ?? (l.sku ? 'sku:' + normSku(l.sku) : 'desc:' + norm(l.description) + ':' + (l.amountCents ?? ''))}`
}

interface LineFit { line: NormalizedLine | null; sku: boolean; strongDesc: boolean; amount: boolean; s: number }
const EMPTY_FIT: LineFit = { line: null, sku: false, strongDesc: false, amount: false, s: 0 }
const fitStrong = (f: LineFit) => f.sku || (f.strongDesc && f.amount)
/** Best line-level match between one returned line and a candidate's prior lines, split into a FRESH
 *  (not-yet-returned) best and an ALREADY-RETURNED best. If the returned item best corresponds to an
 *  already-returned line and no fresh line fits, it's a probable re-scan → the caller downgrades it. */
function matchLines(returnedLine: NormalizedLine, priorLines: NormalizedLine[], alreadyReturnedKeys: Set<string>, eventId: string): { fresh: LineFit; dup: LineFit } {
  let fresh = { ...EMPTY_FIT }, dup = { ...EMPTY_FIT }
  for (const pl of priorLines) {
    const sku = !!(returnedLine.sku && pl.sku && normSku(returnedLine.sku) === normSku(pl.sku))
    const sim = descSimilarity(returnedLine.description, pl.description)
    const amount = amountClose(returnedLine.amountCents, pl.amountCents)
    const s = (sku ? 3 : 0) + sim + (amount ? 1 : 0)
    const fit: LineFit = { line: pl, sku, strongDesc: sim >= 0.5, amount, s }
    if (alreadyReturnedKeys.has(lineRef(eventId, pl))) { if (s > dup.s) dup = fit }
    else if (s > fresh.s) fresh = fit
  }
  return { fresh, dup }
}

export function scoreReturnMatch(query: ReturnQuery, priors: PriorPurchase[], alreadyReturnedKeys: Set<string> = new Set()): ReturnMatchResult {
  const returnedLines = query.lineItems.filter((l) => l.description)
  const returnedAmountCents = query.totalCents ?? (returnedLines.length ? returnedLines.reduce((t, l) => t + (l.amountCents ?? 0), 0) : null)
  const returnedLabel = returnedLines.length === 1 && returnedLines[0].amountCents != null
    ? `${returnedLines[0].description} — ${money(returnedLines[0].amountCents)}`
    : returnedAmountCents != null ? `${money(returnedAmountCents)} returned` : null

  const candidates: ReturnCandidate[] = []
  for (const p of priors) {
    if (p.remainingCents <= 0) continue // fully returned already (event-level double-return guard)
    const reasons: string[] = []
    let score = 0
    const vendorMatch = !!(query.vendor && p.vendor && norm(query.vendor) === norm(p.vendor))

    // Referenced-receipt match — strongest single signal.
    const refMatch = !!(query.originalReference && p.receiptNumber && normRef(query.originalReference) === normRef(p.receiptNumber))
    if (refMatch) { score += 100; reasons.push('Return cites this purchase’s receipt #') }

    // Best line-level match across returned lines. Also detect a re-scan of an ALREADY-returned item.
    let matchedLine: NormalizedLine | null = null
    let matchedLineFlags = { sku: false, strongDesc: false, amount: false }
    let dupItem = false
    for (const rl of (returnedLines.length ? returnedLines : [])) {
      const m = matchLines(rl, p.lineItems, alreadyReturnedKeys, p.eventId)
      if (m.fresh.line && (m.fresh.sku || m.fresh.strongDesc || m.fresh.amount) && !matchedLine) { matchedLine = m.fresh.line; matchedLineFlags = { sku: m.fresh.sku, strongDesc: m.fresh.strongDesc, amount: m.fresh.amount } }
      // Identifiable returned item best corresponds to an already-returned line, with no fresh fit → probable duplicate.
      if (fitStrong(m.dup) && !fitStrong(m.fresh)) dupItem = true
    }
    // Double-return guard: an already-returned specific item cannot be strongly re-matched, even if the
    // return cites the same receipt#. The event may still have remaining for OTHER (fresh) lines.
    if (dupItem && !matchedLine) { score -= 120; reasons.push('⚠ this item appears to have already been returned') }
    if (matchedLine) {
      if (matchedLineFlags.sku && vendorMatch) { score += 90; reasons.push('Same part # (SKU) at the same vendor') }
      else if (matchedLineFlags.sku) { score += 60; reasons.push('Same part # (SKU)') }
      else if (matchedLineFlags.strongDesc && vendorMatch && matchedLineFlags.amount) { score += 65; reasons.push('Same item, vendor and amount') }
      else if (matchedLineFlags.strongDesc && vendorMatch) { score += 45; reasons.push('Same item and vendor') }
      else if (matchedLineFlags.amount && vendorMatch) { score += 30; reasons.push('Same amount and vendor') }
      else if (matchedLineFlags.strongDesc) { score += 20; reasons.push('Similar item') }
    }

    // Event-level amount alignment (return total vs event remaining/amount) — supporting evidence.
    const amountAligns = amountClose(returnedAmountCents, p.remainingCents) || amountClose(returnedAmountCents, p.amountCents)
    if (!refMatch && !matchedLine && vendorMatch && amountAligns) { score += 30; reasons.push('Same vendor and amount') } // weak
    else if (!refMatch && !matchedLine && vendorMatch) { score += 15; reasons.push('Same vendor') }
    else if (amountAligns) { score += 10; reasons.push('Amount matches') }

    // Date order sanity: a return should not predate its purchase.
    if (query.date && p.eventDate) {
      if (query.date >= p.eventDate) score += 5
      else { score -= 20; reasons.push('⚠ return date is before this purchase') }
    }

    const suggested = matchedLine?.amountCents != null ? Math.min(matchedLine.amountCents, p.remainingCents)
      : returnedAmountCents != null ? Math.min(returnedAmountCents, p.remainingCents) : null
    candidates.push({
      eventId: p.eventId, score, reasons, remainingCents: p.remainingCents, vendor: p.vendor, eventDate: p.eventDate, amountCents: p.amountCents,
      matchedLine, suggestedReturnCents: suggested,
      returnedLineRef: matchedLine ? lineRef(p.eventId, matchedLine) : null,
      label: `${p.vendor ?? 'Unknown vendor'} · ${p.eventDate} · ${money(p.amountCents)}`,
      matchedLineLabel: matchedLine ? `${matchedLine.description}${matchedLine.amountCents != null ? ` — ${money(matchedLine.amountCents)}` : ''}` : null,
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  const plausible = candidates.filter((c) => c.score >= AMBIGUOUS_THRESHOLD)
  let classification: ReturnMatchResult['classification'] = 'none'
  if (plausible.length) {
    const best = plausible[0]
    const second = plausible[1]
    if (best.score >= STRONG_THRESHOLD && (!second || best.score - second.score >= STRONG_MARGIN)) classification = 'strong'
    else classification = 'ambiguous'
  }
  return { classification, candidates: plausible.slice(0, 4), returnedAmountCents, returnedLabel }
}
