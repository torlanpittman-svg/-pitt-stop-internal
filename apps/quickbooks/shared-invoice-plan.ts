/**
 * Shared retail invoice — PURE rules (no DB, no QuickBooks calls). See shared-invoice.ts for the orchestration.
 *
 * A shared invoice is ONE QuickBooks invoice billing several retail Jobs of the same customer. Each Job keeps its
 * own estimate, fees, tax and rounding: its lines are built by the SAME per-job payload builder as a single-job
 * invoice (buildRetailWorkPayload, which asserts Σ its lines === its own Invoice Draft total). This module only
 * CONCATENATES those per-job segments under a per-vehicle header and asserts the combined invariant
 *   Σ(all priced lines) === Σ(each Job's draft total)
 * — no amount is recalculated, merged, split or rounded here.
 */
import crypto from 'node:crypto'
import { buildCustomerMemo, buildPrivateNote, type InvoiceVehicle } from './retail-format'
import { RetailTotalMismatchError, type RetailBuiltLine, type RetailFeeKind, type RetailPayload } from './retail-invoice'

// ── Line fingerprint (detects QuickBooks-side edits) ──────────────────────────────────────────────
/** A QuickBooks line reduced to what Pitt Stop owns: priced item lines and description-only header lines. */
export type NormLine = { k: 'item'; item: string; d: string; c: number } | { k: 'text'; d: string }

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Normalize a raw QuickBooks Invoice.Line[] (SubTotal and unknown detail types are ignored). */
export function linesFromRawInvoice(lines: any[] | null | undefined): NormLine[] {
  const out: NormLine[] = []
  for (const l of lines ?? []) {
    if (l?.DetailType === 'SalesItemLineDetail') {
      out.push({ k: 'item', item: String(l.SalesItemLineDetail?.ItemRef?.value ?? ''), d: clean(l.Description), c: Math.round(Number(l.Amount ?? 0) * 100) })
    } else if (l?.DetailType === 'DescriptionOnly') {
      out.push({ k: 'text', d: clean(l.Description) })
    }
  }
  return out
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Normalize the lines Pitt Stop would write. */
export function linesFromPayload(lines: RetailBuiltLine[]): NormLine[] {
  return lines.map((l) => (l.kind === 'text' ? { k: 'text' as const, d: clean(l.description) } : { k: 'item' as const, item: String(l.itemId), d: clean(l.description), c: Math.round(l.amountCents) }))
}

export function linesFingerprint(lines: NormLine[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(lines)).digest('hex')
}

/**
 * Raw QuickBooks line DetailTypes a shared rewrite can safely rebuild: our priced item lines, our
 * DescriptionOnly vehicle headers, and the SubTotal QuickBooks maintains itself (ignored). ANY other type —
 * DiscountLineDetail, GroupLineDetail, or an unknown one — carries money or meaning the line fingerprint
 * (which normalizes only the first two and drops the rest) would silently overwrite, so callers fail closed
 * on it instead. Returns the distinct offending types ([] = safe to rewrite).
 */
const OVERWRITE_SAFE_LINE_TYPES = new Set(['SalesItemLineDetail', 'DescriptionOnly', 'SubTotalLineDetail'])
/* eslint-disable @typescript-eslint/no-explicit-any */
export function overwriteUnsafeLineTypes(lines: any[] | null | undefined): string[] {
  const bad = new Set<string>()
  for (const l of lines ?? []) {
    const t = String(l?.DetailType ?? '').trim()
    if (!OVERWRITE_SAFE_LINE_TYPES.has(t)) bad.add(t || '(unknown)')
  }
  return [...bad]
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** True when two normalized line sets are the same invoice content. */
export function sameLines(a: NormLine[], b: NormLine[]): boolean {
  return linesFingerprint(a) === linesFingerprint(b)
}

// ── Combined payload ──────────────────────────────────────────────────────────────────────────────
/** One Job's slice of a shared invoice: its own payload lines (already Σ === its draft total). */
export interface SharedSegment {
  estimateId: string
  vehicle: InvoiceVehicle
  /** The Job's own Invoice Draft total (the per-job invariant target). */
  totalCents: number
  lines: RetailBuiltLine[]
}

/** "Vehicle 1 of 2 — 2019 Honda Civic · VIN 1HG…" — built from vehicle data only (never generated text). */
export function vehicleHeader(v: InvoiceVehicle, index: number, count: number): string {
  const ymm = [v.year, v.make, v.model].map((x) => clean(x)).filter(Boolean).join(' ') || 'Vehicle'
  const vin = clean(v.vin)
  const plate = clean(v.licensePlate)
  const tail = vin ? ` · VIN ${vin}` : plate ? ` · Plate ${plate}` : ''
  return `Vehicle ${index + 1} of ${count} — ${ymm}${tail}`
}

/**
 * How a multi-vehicle invoice lays its lines out:
 * - `'combined'` (today's presentation): each vehicle's SERVICE lines under its header, then — after every
 *   vehicle section — ONE combined shop-supplies line and ONE combined card-payment line. Each combined fee line
 *   is the exact SUM of the per-job fee cents it aggregates (no re-computation, no re-based percentage, no new
 *   rounding): per-job caps, waivers and rounding have already been applied by each Job's own Invoice Draft.
 * - `'legacy'`: the original per-vehicle layout (every Job's fee lines interleaved right after its services).
 *   Kept ONLY to reconstruct invoices written before the combined layout existed, so the line fingerprint /
 *   `sameLines` tamper guards still recognise those legitimate invoices as Pitt Stop's (see shared-invoice.ts).
 */
export type SharedInvoiceLayout = 'combined' | 'legacy'

/** Fees are aggregated by SEMANTIC identity, not display text: same fee kind AND same item ref AND same label.
 *  A JSON tuple is used (not space-joined) so values that merely concatenate the same can't collide. Different
 *  item refs or labels are never silently merged — each distinct group becomes its own combined line. */
const feeGroupKey = (l: RetailBuiltLine): string => JSON.stringify([l.fee ?? '', l.itemId, clean(l.description)])

/** Canonical fee order on the combined invoice: shop supplies first, then card payment, then anything else. This is
 *  independent of which Job carried each fee first (so a first Job that WAIVED supplies doesn't reorder the lines). */
const FEE_KIND_RANK: Record<string, number> = { shop_supplies: 0, payment: 1 }
const feeKindRank = (f: RetailFeeKind | undefined): number => (f && f in FEE_KIND_RANK ? FEE_KIND_RANK[f] : 2)

/** 'combined': per-vehicle service sections, then the aggregated fee lines (shop supplies, then card payment). */
function combinedLines(segments: SharedSegment[]): RetailBuiltLine[] {
  const lines: RetailBuiltLine[] = []
  segments.forEach((s, i) => {
    lines.push({ kind: 'text', itemId: '', description: vehicleHeader(s.vehicle, i, segments.length), amountCents: 0 })
    // Keep each vehicle's service lines (and any description-only lines) in place; only the fee lines are pulled
    // out and aggregated below — a non-fee line is never silently dropped.
    for (const l of s.lines) if (!l.fee) lines.push({ ...l })
  })
  // Aggregate compatible fees across all vehicles by semantic identity (kind + item ref + label). Incompatible
  // item refs/labels fall into separate groups, never merged. Order: fee-kind rank first (shop supplies before
  // card payment), then first appearance within a kind (keeps distinct same-kind labels deterministic).
  const groups = new Map<string, { line: RetailBuiltLine; seq: number }>()
  let seq = 0
  for (const s of segments) {
    for (const l of s.lines) {
      if (!l.fee) continue
      const key = feeGroupKey(l)
      const g = groups.get(key)
      if (g) g.line.amountCents = Math.round(g.line.amountCents) + Math.round(l.amountCents)
      else groups.set(key, { line: { itemId: l.itemId, description: l.description, amountCents: Math.round(l.amountCents), fee: l.fee }, seq: seq++ })
    }
  }
  const ordered = [...groups.values()].sort((a, b) => feeKindRank(a.line.fee) - feeKindRank(b.line.fee) || a.seq - b.seq)
  for (const g of ordered) lines.push(g.line)
  return lines
}

/** 'legacy': header then every one of the Job's lines (services AND fees) — the original interleaved layout. */
function legacyLines(segments: SharedSegment[]): RetailBuiltLine[] {
  const lines: RetailBuiltLine[] = []
  segments.forEach((s, i) => {
    lines.push({ kind: 'text', itemId: '', description: vehicleHeader(s.vehicle, i, segments.length), amountCents: 0 })
    for (const l of s.lines) lines.push({ ...l })
  })
  return lines
}

/**
 * Combine per-job segments into ONE invoice payload. A single segment returns the ordinary single-job shape
 * (same lines, memo and PSID note — byte-identical to today's invoices, so existing invoices never drift).
 * Several segments: lines per `layout` (default `'combined'`), every vehicle in the memo, and the member PSIDs
 * listed after the anchor PSID in the internal note (the anchor PSID stays first, so the existing identity check
 * — extractPsid — still proves the invoice is the anchor's). No amount is recalculated, merged by value, split or
 * rounded here — fees are only SUMMED per compatible group.
 */
export function combineSharedPayload(anchorEstimateId: string, segments: SharedSegment[], opts: { layout?: SharedInvoiceLayout } = {}): RetailPayload {
  if (segments.length === 0) throw new Error('A shared invoice needs at least one Job.')
  if (segments[0].estimateId !== anchorEstimateId) throw new Error('The anchor Job must be the first segment.')
  const expected = segments.reduce((t, s) => t + Math.round(s.totalCents), 0)
  // Per-job invariant again (defense in depth — the per-job builder already enforces it).
  for (const s of segments) {
    const sum = s.lines.filter((l) => l.kind !== 'text').reduce((t, l) => t + Math.round(l.amountCents), 0)
    if (sum !== Math.round(s.totalCents)) throw new RetailTotalMismatchError(sum, Math.round(s.totalCents))
  }
  if (segments.length === 1) {
    const s = segments[0]
    return { lines: s.lines.map((l) => ({ ...l })), customerMemo: buildCustomerMemo(s.vehicle), privateNote: buildPrivateNote(anchorEstimateId), totalCents: expected }
  }
  const lines = (opts.layout ?? 'combined') === 'legacy' ? legacyLines(segments) : combinedLines(segments)
  const sum = lines.filter((l) => l.kind !== 'text').reduce((t, l) => t + Math.round(l.amountCents), 0)
  if (sum !== expected) throw new RetailTotalMismatchError(sum, expected)
  const customerMemo = segments
    .map((s, i) => { const m = buildCustomerMemo(s.vehicle); return `Vehicle ${i + 1}: ${m || 'Vehicle'}` })
    .join('\n')
    .slice(0, 1000)   // QuickBooks CustomerMemo limit
  const members = segments.slice(1).map((s) => s.estimateId)
  return { lines, customerMemo, privateNote: buildPrivateNote(anchorEstimateId, `PSLINK:${members.join(',')}`), totalCents: expected }
}

// ── QuickBooks money state ────────────────────────────────────────────────────────────────────────
export interface InvoiceMoneyState { totalCents: number; balanceCents: number | null; untouched: boolean; reason: string | null }
/** Money already applied in QuickBooks? Only an untouched invoice (balance === total, no payment / credit linked,
 *  total > 0) may take more Jobs. Voided invoices read as total 0 and are refused here. */
export function invoiceMoneyState(raw: { TotalAmt?: number; Balance?: number; LinkedTxn?: Array<{ TxnType?: string }> }): InvoiceMoneyState {
  const totalCents = Math.round(Number(raw.TotalAmt ?? 0) * 100)
  const balanceCents = raw.Balance == null ? null : Math.round(Number(raw.Balance) * 100)
  const moneyTxn = (raw.LinkedTxn ?? []).some((t) => /^(Payment|ReceivePayment|CreditMemo|JournalEntry|Deposit)$/i.test(String(t.TxnType ?? '')))
  if (totalCents <= 0) return { totalCents, balanceCents, untouched: false, reason: 'The invoice total is $0 (voided or empty).' }
  if (balanceCents == null) return { totalCents, balanceCents, untouched: false, reason: 'QuickBooks did not report a balance.' }
  if (balanceCents === 0) return { totalCents, balanceCents, untouched: false, reason: 'The invoice is paid.' }
  if (balanceCents !== totalCents || moneyTxn) return { totalCents, balanceCents, untouched: false, reason: 'A payment or credit is applied to the invoice.' }
  return { totalCents, balanceCents, untouched: true, reason: null }
}

// ── Local eligibility (the anchor's Pitt Stop state) ─────────────────────────────────────────────
export interface AnchorLocalState {
  qbStatus: string
  qbPaymentStatus: string
  qbPaymentBalanceState: string | null
  qbSyncError: string | null
  orderStatus: string
  isDealer: boolean
}
/** Why this anchor may NOT take another Job right now (null = locally fine). */
export function anchorLocalBlock(a: AnchorLocalState): string | null {
  if (a.isDealer) return 'Dealer invoices are never shared.'
  if (a.orderStatus === 'cancelled') return 'That Job was removed.'
  if (!['created', 'sent'].includes(a.qbStatus)) return a.qbStatus === 'error' ? 'The invoice’s last update failed — fix it first.' : 'The invoice is being changed right now.'
  if (a.qbPaymentStatus !== 'none') return 'A payment was recorded or started on this invoice.'
  if (a.qbPaymentBalanceState && a.qbPaymentBalanceState !== 'unpaid') return 'Money is already applied to this invoice.'
  if (/^needs review/i.test(a.qbSyncError ?? '')) return 'The invoice needs review first.'
  return null
}

/** Why the NEW Job may not join any shared invoice (null = it may). */
export function memberLocalBlock(m: { isDealer: boolean; orderStatus: string; qbInvoiceId: string | null; qbStatus: string; activeMembership: boolean }): { code: string; message: string } | null {
  if (m.isDealer) return { code: 'dealer', message: 'Dealer Jobs are invoiced through Dealer Check-In.' }
  if (m.orderStatus === 'cancelled') return { code: 'cancelled', message: 'This Job was removed.' }
  if (m.orderStatus === 'estimate') return { code: 'estimate', message: 'Move this estimate to the Work Board first.' }
  if (m.qbInvoiceId) return { code: 'has_invoice', message: 'This Job already has its own QuickBooks invoice. Two existing invoices are never merged automatically — reconcile them in QuickBooks.' }
  if (m.activeMembership || m.qbStatus === 'linked') return { code: 'already_linked', message: 'This Job is already on a shared invoice.' }
  if (!['none', 'error'].includes(m.qbStatus)) return { code: 'busy', message: 'An invoice is being created for this Job right now.' }
  return null
}
