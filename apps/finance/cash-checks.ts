/**
 * Trust checks for the cash numbers — PURE (no DB). Each answers one question the owner would otherwise have
 * to take on faith:
 *   quietBills        — is a bill we still forecast actually still being charged?
 *   outstandingChecks — which checks have we written that the bank has not paid yet? (that cash is already spent)
 *   spendVerdict      — is "safe to spend" dependable enough to show as a number right now?
 * None of these change a bill, a check or a balance. They produce flags and one extra deduction line.
 */
const DAY = 86_400_000
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const days = (later: string, earlier: string) => Math.round((utc(later) - utc(earlier)) / DAY)

// ── Bills that may have ended ────────────────────────────────────────────────────────────────────────
export interface BillInput {
  id: string; vendor: string; discoveryKey?: string | null; frequency: string | null
  amountCents: number | null; avgAmountCents?: number | null; amountMinCents?: number | null; amountMaxCents?: number | null
}
export interface BillTxn { date: string; amountCents: number; name: string | null; merchantName: string | null }
export interface QuietBill {
  id: string; vendor: string; expectedCents: number
  reason: 'no_payment_seen' | 'amount_changed'
  lastDate: string | null; lastCents: number | null; daysSince: number | null
  message: string
}
/** '2026-12-17' → 'Dec 17' */
export const human = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const usd = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Leading words that do not identify a vendor on their own.
const GENERIC = new Set(['the', 'city', 'first', 'rent', 'payroll', 'owner', 'federal', 'mechanic', 'outstanding', 'amex', 'irs', 'us', 'qb', 'bank', 'loan', 'state'])
/** The one distinctive word a bank line must contain to be this vendor's payment (null → cannot be recognised). */
export function vendorToken(vendor: string): string | null {
  const first = vendor.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/)[0] ?? ''
  return first.length >= 3 && !GENERIC.has(first) ? first : null
}

/** Does a bank line contain this vendor word as a WHOLE word? ("payme" must not match "payment".) */
export function hasVendorWord(text: string, token: string): boolean {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).includes(token)
}

/**
 * A confirmed MONTHLY bill (of $50 or more) that the bank no longer shows being paid:
 *   no_payment_seen — nothing at all from that vendor for more than ~6 weeks;
 *   amount_changed  — the vendor's latest charge is more than double the top of the bill's usual range, or under
 *                     half the bottom of it while the usual amount has not been charged this cycle (a final bill, or a new price).
 * Only bills the bank history can recognise by the vendor's own name are judged — a bill paid by transfer or
 * under another name is skipped, not guessed — and nothing is judged while the bank feed itself is behind.
 * The bill STAYS in the forecast; this only raises the question.
 */
export function quietBills(bills: BillInput[], txns: BillTxn[], today: string, feedThrough: string | null): QuietBill[] {
  if (!feedThrough || days(today, feedThrough) > 3) return []
  const out: QuietBill[] = []
  for (const b of bills) {
    if ((b.frequency ?? '').toLowerCase() !== 'monthly') continue
    const expected = b.amountCents ?? b.avgAmountCents ?? 0
    const token = vendorToken(b.vendor)
    if (expected < 5000 || !token) continue
    const mine = txns.filter((t) => hasVendorWord(`${t.merchantName ?? ''} ${t.name ?? ''}`, token)).sort((x, y) => y.date.localeCompare(x.date))
    if (mine.length === 0) continue
    const last = mine[0], sinceLast = days(today, last.date)
    if (sinceLast > 41) {
      out.push({ id: b.id, vendor: b.vendor, expectedCents: expected, reason: 'no_payment_seen', lastDate: last.date, lastCents: last.amountCents, daysSince: sinceLast,
        message: `No payment seen since ${human(last.date)} (${sinceLast} days). If this bill has ended, mark it ended so it stops being forecast.` })
      continue
    }
    // The NEWEST charge is the newest evidence: far outside anything this bill has been (more than double the
    // top of its range, or under half the bottom) means a final invoice or a new price — whatever came before.
    const lo = Math.min(b.amountMinCents ?? Infinity, Math.round(expected * 0.85)), hi = Math.max(b.amountMaxCents ?? 0, Math.round(expected * 1.15))
    // A much SMALLER charge only counts when the usual amount has also gone missing this cycle — many vendors
    // bill a small extra item alongside the regular one.
    const usual = mine.find((t) => t.amountCents >= lo && t.amountCents <= hi) ?? null
    const usualMissing = !usual || days(today, usual.date) > 41
    if (last.amountCents > 2 * hi || (last.amountCents < lo / 2 && usualMissing)) {
      out.push({ id: b.id, vendor: b.vendor, expectedCents: expected, reason: 'amount_changed', lastDate: last.date, lastCents: last.amountCents, daysSince: sinceLast,
        message: `Last charge was ${usd(last.amountCents)} on ${human(last.date)} — not the usual ${usd(expected)}. If that was a final bill, mark this one ended; if the price changed, update it.` })
    }
  }
  return out.sort((a, b) => b.expectedCents - a.expectedCents)
}

// ── Checks written but not yet paid by the bank ──────────────────────────────────────────────────────
export interface WrittenCheck { id: string; checkNumber: number; payeeName: string; amountCents: number; checkDate: string }
export interface ClearedTxn { id: string; date: string; amountCents: number }
export interface OutstandingChecks { checks: (WrittenCheck & { ageDays: number })[]; totalCents: number; oldCents: number }

/**
 * The bank's balance does not drop until a paper check is cashed, so a written check is cash already spent.
 * Each written check is paired one-to-one with a bank check payment of the SAME amount dated from the day
 * before it was written to 60 days after (this bank shows no check numbers); what is left is outstanding.
 * A check dated today or later is left out — today's recurring bills (payroll, the Monday mechanic) are already
 * in the forecast, so counting the check too would subtract the same money twice. A check older than 60 days
 * is reported separately (`oldCents`) and NOT subtracted: it may be lost or void.
 */
export function outstandingChecks(written: WrittenCheck[], cleared: ClearedTxn[], today: string): OutstandingChecks {
  const used = new Set<string>()
  const open: (WrittenCheck & { ageDays: number })[] = []
  for (const c of written.slice().sort((a, b) => a.checkDate.localeCompare(b.checkDate))) {
    const hit = cleared.filter((t) => !used.has(t.id) && t.amountCents === c.amountCents && days(t.date, c.checkDate) >= -1 && days(t.date, c.checkDate) <= 60)
      .sort((a, b) => a.date.localeCompare(b.date))[0]
    if (hit) { used.add(hit.id); continue }
    const age = days(today, c.checkDate)
    if (age >= 1) open.push({ ...c, ageDays: age })
  }
  const recent = open.filter((c) => c.ageDays <= 60)
  return { checks: open, totalCents: recent.reduce((s, c) => s + c.amountCents, 0), oldCents: open.filter((c) => c.ageDays > 60).reduce((s, c) => s + c.amountCents, 0) }
}

// ── Is Safe-to-Spend dependable right now? ───────────────────────────────────────────────────────────
export interface SpendVerdict {
  showNumber: boolean          // false → the page says "can't say" instead of a dollar figure
  blockers: string[]           // why there is no dependable number
  cautions: string[]           // the number stands, but here is what could move it
}
export function spendVerdict(i: {
  hasOperatingAccount: boolean; balanceStale: boolean; bankFailed: boolean
  payrollFloorCents: number; criticalBillCount: number
  unconfirmedAmountBills: string[]; quiet: QuietBill[]; outstandingOldCents: number; cardOwedCents: number | null; cardReservedCents: number
}): SpendVerdict {
  const blockers: string[] = [], cautions: string[] = []
  if (!i.hasOperatingAccount) blockers.push('No verified operating bank account is connected.')
  else if (i.bankFailed) blockers.push('The operating bank connection is failing, so the balance may be out of date.')
  else if (i.balanceStale) blockers.push('The operating balance is more than a day old — sync before deciding.')
  if (i.hasOperatingAccount && (i.payrollFloorCents <= 0 || i.criticalBillCount === 0)) blockers.push('No confirmed payroll or critical bills are on file, so nothing is being held back for them.')
  if (i.unconfirmedAmountBills.length) cautions.push(`${i.unconfirmedAmountBills.join(', ')}: amount not confirmed — an estimate is being held back.`)
  if (i.quiet.length) cautions.push(`${usd(i.quiet.reduce((s, q) => s + q.expectedCents, 0))}/month is held back for ${i.quiet.map((q) => q.vendor).join(', ')}, which may have ended.`)
  if (i.outstandingOldCents > 0) cautions.push(`${usd(i.outstandingOldCents)} of checks older than 60 days were never cashed and are not held back.`)
  if (i.cardOwedCents != null && i.cardOwedCents > i.cardReservedCents) cautions.push(`The credit card balance is ${usd(i.cardOwedCents)}; only the ${usd(i.cardReservedCents)} minimum payment is held back.`)
  return { showNumber: blockers.length === 0, blockers, cautions }
}
