/**
 * Reconciliation view — READ-ONLY review queues across the money sources that describe a purchase:
 *
 *   receipt (business_receipts)  ·  bank/card transaction (fin_transactions, Plaid)  ·  job / overhead
 *   allocation (expense_allocations)  ·  sales-inventory vehicle ledger (vehicle_financial_events)  ·
 *   expected recurring bill (fin_obligations)  ·  QuickBooks expense record (NOT available — see below)
 *
 * Every queue is a list of things to LOOK AT, not proof of an error. Each item says which kind it is:
 *   timing              — legitimately not there yet (e.g. the bank has not posted it)
 *   source_unavailable  — the other side cannot be checked from here (cash, an unconnected account, QuickBooks)
 *   to_review           — a person should decide
 *   discrepancy         — the records disagree (e.g. assigned more than the purchase total)
 *
 * Nothing here writes, merges, matches or deletes. A bank match is only ever made by a person (the existing
 * confirmReceiptMatch on the CFO page); a duplicate is only ever resolved by a person.
 */
import { and, desc, eq, gte, inArray, isNotNull, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finObligations, finReceiptMatches, finSyncRuns, finTransactions } from '@/apps/finance/schema'
import { getSyncHealth } from '@/apps/finance/sync-health'
import { expectsReceipt, isPurchaseTxnClass } from '@/apps/finance/txn-class'
import { liveLinks } from '@/apps/finance/purchase-links'
import { rankCandidates } from '@/apps/finance/receipts-cfo'
import { vehicleFinancialEvents } from '@/apps/auto-sales/schema'
import { jobParts } from '@/apps/parts/schema'
import { businessReceipts, expenseAllocations } from './schema'
import { isCompleteStatus } from './types'
import { summarizeAllocations } from './allocations'
import { duplicateEvidence, sameVendor } from './checks'
import { receiptPaymentLabel, isCreditSettledRef } from './payment'

const DAY_MS = 86_400_000
const toUtc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayGap = (a: string, b: string) => Math.round((toUtc(a) - toUtc(b)) / DAY_MS)

export type ReviewKind = 'timing' | 'source_unavailable' | 'to_review' | 'discrepancy'
export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  timing: 'Not yet observable — the source does not reach this date',
  source_unavailable: 'Can’t be checked from here',
  to_review: 'To review',
  discrepancy: 'Records disagree',
}
export interface QueueItem {
  id: string; title: string; detail: string; amountCents: number | null; date: string | null
  kind: ReviewKind; why: string; href?: string
}
export interface Queue {
  key: string; title: string; explain: string
  count: number; totalCents: number | null
  byKind: Partial<Record<ReviewKind, number>>
  items: QueueItem[]          // the first LIST_LIMIT, most recent first
  restricted?: boolean        // bank/bill detail withheld from a non-admin viewer (count still shown as null)
}
export interface SourceStatus { key: string; label: string; state: 'ok' | 'stale' | 'unavailable' | 'partial'; detail: string }
export interface Reconciliation { today: string; windowStart: string; days: number; sources: SourceStatus[]; queues: Queue[] }

const LIST_LIMIT = 25
function queue(key: string, title: string, explain: string, all: QueueItem[], sumAmounts = true): Queue {
  const byKind: Queue['byKind'] = {}
  for (const i of all) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1
  return {
    key, title, explain, count: all.length, byKind,
    totalCents: sumAmounts ? all.reduce((s, i) => s + (i.amountCents ?? 0), 0) : null,
    items: all.slice(0, LIST_LIMIT),
  }
}

// ── Pure classifiers (exported for tests) ────────────────────────────────────────────────────────────
export interface UnmatchedReceiptFacts { receiptDate: string | null; funding: string; accountRef: string | null; paymentMethod: string | null }
/**
 * Why might a filed receipt have no bank transaction yet?
 *   - cash / personal / unpaid / an unclassified "Other" source → the bank feed will never show it
 *   - dated on or after the last day the bank feed covers (minus a 3-day posting lag) → timing
 *   - otherwise it should be in the bank by now → to review
 */
export function classifyUnmatchedReceipt(r: UnmatchedReceiptFacts, bankThrough: string | null): { kind: ReviewKind; why: string } {
  if (r.funding === 'personal') return { kind: 'source_unavailable', why: 'Paid with personal money — it will not appear in a business account.' }
  if (r.funding === 'unpaid') return { kind: 'timing', why: 'Not paid yet — there is no payment to match.' }
  if (r.paymentMethod === 'cash' || r.accountRef === 'cash') return { kind: 'source_unavailable', why: 'Paid in cash — there is no bank transaction to match.' }
  if (r.accountRef?.startsWith('other:')) return { kind: 'source_unavailable', why: 'Paid from a source that is not one of the connected accounts.' }
  if (!bankThrough) return { kind: 'source_unavailable', why: 'No bank transactions are loaded.' }
  if (!r.receiptDate) return { kind: 'to_review', why: 'The receipt has no date, so it cannot be lined up with the bank.' }
  if (dayGap(r.receiptDate, bankThrough) >= -3) {
    return { kind: 'timing', why: `Not yet observable: the bank feed only shows transactions through ${bankThrough}, so it cannot say whether a ${r.receiptDate} purchase has posted.` }
  }
  return { kind: 'to_review', why: isCreditSettledRef(r.accountRef) ? 'Expected on the card statement by now — match it on the CFO page.' : 'Expected in the bank by now — match it on the CFO page.' }
}

/** Does this receipt look like it was bought for a specific customer car but carries no job? Evidence only:
 *  a Detail & Service parts / outside-labor purchase, or a note that names a job. Never auto-assigned. */
export function looksJobSpecific(r: { entity: string; category: string; memo: string | null; filingNote: string | null }): string | null {
  const text = `${r.memo ?? ''} ${r.filingNote ?? ''}`
  if (/\/orders\/[0-9a-f-]{8,}|\bSO-\d{6,}/i.test(text) || /\bcustomer(?:'s)?\s+(?:job|car|vehicle)\b/i.test(text)) return 'A note on this receipt mentions a customer job.'
  if (r.entity === 'detail' && (r.category === 'parts' || r.category === 'subcontractor')) {
    return r.category === 'parts' ? 'Parts bought under Detail & Service are usually for one customer’s car.' : 'Outside labor under Detail & Service is usually for one customer’s car.'
  }
  return null
}

const PERIOD_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 31, quarterly: 92, annual: 366, yearly: 366 }
export interface ObligationFacts { vendor: string; category: string | null; frequency: string | null; amountCents: number | null; amountMinCents: number | null; amountMaxCents: number | null; avgAmountCents: number | null; discoveryKey: string | null }
export interface TxnFacts { id: string; amountCents: number; txnDate: string; name: string | null; merchantName: string | null; txnClass: string | null }
export type ObligationMatch =
  | { state: 'seen'; txn: TxnFacts }
  | { state: 'not_seen'; lookbackDays: number }
  | { state: 'cannot_check'; reason: string }

const tokens = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 4)
function nameHit(ob: ObligationFacts, t: TxnFacts): boolean {
  if (sameVendor(ob.vendor, t.merchantName) || sameVendor(ob.vendor, t.name)) return true
  const want = new Set([...tokens(ob.vendor), ...tokens(ob.discoveryKey)])
  if (want.size === 0) return false
  return [...tokens(t.merchantName), ...tokens(t.name)].some((x) => want.has(x))
}
/**
 * Has an EXPECTED recurring bill been paid within its own period (+5 days grace)? An expected bill is a
 * forecast; the bank transaction is the actual. A hit means "this actual IS that expected bill" — the two are
 * one payment, never added together. Matching is by vendor name (or, for payroll / loan bills, the bank's own
 * class) and — when the bill has an amount — an amount inside its range or within 15%.
 */
export function matchObligation(ob: ObligationFacts, txns: readonly TxnFacts[], today: string): ObligationMatch {
  const period = PERIOD_DAYS[(ob.frequency ?? '').toLowerCase()]
  if (!period) return { state: 'cannot_check', reason: ob.frequency ? `A “${ob.frequency}” bill has no fixed period to check against.` : 'No frequency is set for this bill.' }
  const lookbackDays = period + 5
  const since = iso(toUtc(today) - lookbackDays * DAY_MS)
  const expected = ob.amountCents ?? ob.avgAmountCents
  const lo = ob.amountMinCents ?? (expected != null ? Math.round(expected * 0.85) : null)
  const hi = ob.amountMaxCents ?? (expected != null ? Math.round(expected * 1.15) : null)
  const cat = (ob.category ?? '').toLowerCase()
  const hits = txns.filter((t) => {
    if (t.txnDate < since || t.txnDate > today) return false
    const byClass = (/payroll/.test(cat) && t.txnClass === 'payroll') || (/debt|loan|floor/.test(cat) && t.txnClass === 'debt_payment')
    if (!nameHit(ob, t) && !byClass) return false
    if (lo != null && hi != null && (t.amountCents < lo || t.amountCents > hi)) return false
    return true
  })
  if (hits.length === 0) return { state: 'not_seen', lookbackDays }
  return { state: 'seen', txn: hits.slice().sort((a, b) => b.txnDate.localeCompare(a.txnDate))[0] }
}

// ── The view ─────────────────────────────────────────────────────────────────────────────────────────
const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`)

/**
 * Build the review queues for the trailing `days`. `includeBank` gates the bank-transaction and expected-bill
 * detail (owner/admin only — managers still see the receipt-side queues).
 */
export async function getReconciliation(opts: { today: string; days?: number; includeBank: boolean }): Promise<Reconciliation> {
  const db = getDb()
  const days = opts.days ?? 60
  const today = opts.today
  const windowStart = iso(toUtc(today) - days * DAY_MS)

  // ---- load (bounded by the window) ----
  const receipts = await db.select().from(businessReceipts)
    .where(and(ne(businessReceipts.status, 'rejected'), gte(businessReceipts.createdAt, new Date(toUtc(windowStart)))))
    .orderBy(desc(businessReceipts.createdAt))
  const ids = receipts.map((r) => r.id)
  const [allocs, matches, txns, health, lastQbo] = await Promise.all([
    ids.length ? db.select().from(expenseAllocations).where(and(inArray(expenseAllocations.receiptId, ids), eq(expenseAllocations.status, 'active'))) : Promise.resolve([]),
    db.select().from(finReceiptMatches),
    db.select({
      id: finTransactions.id, amountCents: finTransactions.amountCents, txnDate: finTransactions.txnDate, name: finTransactions.name,
      merchantName: finTransactions.merchantName, txnClass: finTransactions.txnClass, isExpense: finTransactions.isExpense, pending: finTransactions.pending,
    }).from(finTransactions).where(and(eq(finTransactions.direction, 'out'), eq(finTransactions.removed, false), gte(finTransactions.txnDate, iso(toUtc(windowStart) - 370 * DAY_MS)))),
    getSyncHealth().catch(() => null),
    db.select({ at: finSyncRuns.finishedAt }).from(finSyncRuns).where(and(eq(finSyncRuns.source, 'qbo'), eq(finSyncRuns.status, 'ok'))).orderBy(desc(finSyncRuns.startedAt)).limit(1),
  ])
  // Decisions a person already made (purchase_links): a pair that was confirmed OR dismissed is not raised again.
  const links = await liveLinks().catch(() => [])
  const decidedPair = new Set(links.map((l) => `${l.kind}|${l.aId}|${l.bId}`))
  const explainedTxn = new Set(links.filter((l) => l.status === 'confirmed' && (l.kind === 'check_txn' || l.kind === 'bill_payment')).map((l) => l.bId))
  const matchByReceipt = new Map(matches.map((m) => [m.receiptId, m]))
  const matchedTxnIds = new Set(matches.filter((m) => m.status === 'confirmed' && m.txnId).map((m) => m.txnId as string))
  const bankThrough = txns.length ? txns.reduce((mx, t) => (t.txnDate > mx ? t.txnDate : mx), '0000-00-00') : null
  const complete = receipts.filter((r) => isCompleteStatus(r.status))
  const allocsFor = (id: string) => allocs.filter((a) => a.receiptId === id)
  const receiptTitle = (r: (typeof receipts)[number]) => [r.vendor || 'Vendor not recorded', r.description].filter(Boolean).join(' — ')
  const receiptDetail = (r: (typeof receipts)[number]) => [receiptPaymentLabel(r), r.invoiceNumber && `invoice ${r.invoiceNumber}`, r.status !== 'filed' && r.status !== 'approved' ? 'needs review' : null].filter(Boolean).join(' · ')

  // 5) Expected bills with no actual payment seen (admin detail).
  const obligations = opts.includeBank ? await db.select().from(finObligations).where(eq(finObligations.status, 'confirmed')) : []
  const purchaseTxns = txns.filter((t) => !t.pending)
  const bills: QueueItem[] = []
  const billByTxn = new Map<string, string>()   // bank payment → the expected bill it IS
  for (const ob of obligations) {
    // A payment a person CONFIRMED as this bill (persisted) settles it without re-guessing.
    const confirmedPay = links.filter((l) => l.kind === 'bill_payment' && l.status === 'confirmed' && l.aId === ob.id)
      .map((l) => purchaseTxns.find((t) => t.id === l.bId)).filter((t): t is (typeof purchaseTxns)[number] => !!t)
    for (const t of confirmedPay) billByTxn.set(t.id, ob.vendor)
    const period = PERIOD_DAYS[(ob.frequency ?? '').toLowerCase()]
    if (period && confirmedPay.some((t) => dayGap(today, t.txnDate) <= period + 5)) continue
    const m = matchObligation(ob, purchaseTxns.filter((t) => !decidedPair.has(`bill_payment|${ob.id}|${t.id}`)), today)
    if (m.state === 'seen') {
      billByTxn.set(m.txn.id, ob.vendor)
      bills.push({ id: ob.id, title: ob.vendor, detail: `${ob.frequency} · expected bill`, amountCents: ob.amountCents ?? ob.avgAmountCents, date: m.txn.txnDate, kind: 'to_review', why: `A ${money(m.txn.amountCents)} payment on ${m.txn.txnDate} looks like this bill. Confirm it above so the match is saved.`, href: '/admin/finance/reconcile' })
      continue
    }
    const expected = ob.amountCents ?? ob.avgAmountCents
    if (m.state === 'cannot_check') bills.push({ id: ob.id, title: ob.vendor, detail: `${ob.frequency ?? 'no frequency'} · expected bill`, amountCents: expected, date: ob.nextDue, kind: 'source_unavailable', why: m.reason, href: '/admin/finance' })
    else bills.push({
      id: ob.id, title: ob.vendor, detail: `${ob.frequency} · expected bill`, amountCents: expected, date: ob.nextDue,
      kind: bankThrough && dayGap(today, bankThrough) > 3 ? 'timing' : 'to_review',
      why: bankThrough && dayGap(today, bankThrough) > 3
        ? `Not yet observable: the bank feed only shows transactions through ${bankThrough}.`
        : `No matching payment in the last ${m.lookbackDays} days of bank activity (matched by vendor name${expected != null ? ' and amount' : ''}). It may be paid from another account, renamed by the bank, or genuinely unpaid.`,
      href: '/admin/finance',
    })
  }

  // 1) Bank/card purchases with no receipt (admin detail).
  const windowTxns = txns.filter((t) => t.txnDate >= windowStart)
  const noReceipt: QueueItem[] = windowTxns
    .filter((t) => t.isExpense && expectsReceipt(t.txnClass) && !t.pending && !matchedTxnIds.has(t.id) && !explainedTxn.has(t.id))
    .sort((a, b) => b.txnDate.localeCompare(a.txnDate))
    .map((t) => ({
      id: t.id, title: t.merchantName || t.name || 'Bank transaction', detail: `bank class: ${t.txnClass ?? 'unclassified'}`,
      amountCents: t.amountCents, date: t.txnDate, kind: 'to_review' as const, href: '/admin/finance',
      why: billByTxn.has(t.id)
        ? `This is the payment for the expected bill “${billByTxn.get(t.id)}” — one payment, not an extra expense. A recurring bill often has no receipt.`
        : 'No receipt is matched to this payment.',
    }))

  // 2) Filed receipts with no confirmed bank/card transaction.
  const RECONCILABLE = (f: string) => f !== 'personal' && f !== 'unpaid'
  const candidates = windowTxns.filter((t) => !t.pending && isPurchaseTxnClass(t.txnClass) && !matchedTxnIds.has(t.id))
  const unmatched: QueueItem[] = complete
    .filter((r) => { const m = matchByReceipt.get(r.id); return !(m && (m.status === 'confirmed' || m.status === 'dismissed')) })
    .map((r) => {
      // A posted purchase of the same amount, close in date, with a matching name is very likely this receipt —
      // that is something to CONFIRM (a person does it on the CFO page), not a timing gap. Never auto-linked.
      const likely = RECONCILABLE(r.funding)
        ? rankCandidates({ totalCents: r.totalCents, receiptDate: r.receiptDate, vendor: r.vendor }, candidates, 1).find((x) => x.strength === 'strong')
        : undefined
      const c = likely
        ? { kind: 'to_review' as const, why: opts.includeBank
            ? `A bank payment of ${money(likely.txn.amountCents)} on ${likely.txn.txnDate} (${likely.txn.merchantName || likely.txn.name || 'bank transaction'}) looks like this purchase — confirm the match on the CFO page.`
            : 'A bank payment that looks like this purchase has posted — the owner can confirm the match on the finance page.' }
        : classifyUnmatchedReceipt(r, bankThrough)
      return { id: r.id, title: receiptTitle(r), detail: receiptDetail(r), amountCents: r.totalCents, date: r.receiptDate, kind: c.kind, why: c.why, href: opts.includeBank && likely ? '/admin/finance' : '/expenses/review?status=filed' }
    })

  // 3) Likely job purchases with no job.
  const noJob: QueueItem[] = complete
    .filter((r) => !r.inventoryVehicleId && allocsFor(r.id).length === 0)
    .map((r) => ({ r, why: looksJobSpecific(r) }))
    .filter((x): x is { r: (typeof receipts)[number]; why: string } => x.why !== null)
    .map(({ r, why }) => ({ id: r.id, title: receiptTitle(r), detail: receiptDetail(r), amountCents: r.totalCents, date: r.receiptDate, kind: 'to_review' as const, why, href: '/expenses/review?status=filed' }))

  // 4) Potential duplicates (never merged here).
  const dups: QueueItem[] = []
  for (let i = 0; i < receipts.length; i++) {
    for (let j = i + 1; j < receipts.length; j++) {
      const ev = duplicateEvidence(receipts[i], receipts[j])
      if (ev.strength === 'none') continue
      const a = receipts[i], b = receipts[j]
      dups.push({
        id: `${a.id}:${b.id}`, title: `${a.vendor ?? 'Receipt'} ${money(a.totalCents)} ↔ ${b.vendor ?? 'receipt'} ${money(b.totalCents)}`,
        detail: `Two receipts: ${ev.reasons.join(', ')}`, amountCents: b.totalCents, date: a.receiptDate,
        kind: 'to_review', why: ev.strength === 'likely' ? 'Likely the same purchase filed twice. If so, reject one — do not count both.' : 'Possibly the same purchase (e.g. a receipt and an emailed invoice).',
        href: '/expenses/review?status=filed',
      })
    }
  }
  // …a receipt tagged to a sales-inventory car that ALSO sits in that car's own ledger (two systems, one purchase).
  const vehicleReceipts = receipts.filter((r) => r.inventoryVehicleId && r.totalCents != null)
  if (vehicleReceipts.length) {
    const events = await db.select({
      id: vehicleFinancialEvents.id, inventoryVehicleId: vehicleFinancialEvents.inventoryVehicleId, amountCents: vehicleFinancialEvents.amountCents,
      eventDate: vehicleFinancialEvents.eventDate, vendor: vehicleFinancialEvents.vendor, status: vehicleFinancialEvents.status, reversesEventId: vehicleFinancialEvents.reversesEventId,
    }).from(vehicleFinancialEvents).where(inArray(vehicleFinancialEvents.inventoryVehicleId, [...new Set(vehicleReceipts.map((r) => r.inventoryVehicleId as string))]))
    // Only LIVE lines: a line that was removed/corrected (reversed) and the correcting entry itself no longer count.
    const reversedIds = new Set(events.filter((e) => e.reversesEventId && e.status !== 'void').map((e) => e.reversesEventId as string))
    for (const r of vehicleReceipts) {
      const hit = events.find((e) => e.inventoryVehicleId === r.inventoryVehicleId && e.status !== 'void' && !e.reversesEventId && !reversedIds.has(e.id) && e.amountCents === r.totalCents
        && (!r.receiptDate || !e.eventDate || Math.abs(dayGap(r.receiptDate, e.eventDate)) <= 3))
      if (hit && !decidedPair.has(`receipt_vehicle_event|${r.id}|${hit.id}`)) dups.push({
        id: `${r.id}:veh:${hit.id}`, title: `${receiptTitle(r)} ${money(r.totalCents)}`, detail: `Also entered on the vehicle’s own ledger (${hit.vendor ?? 'same amount'}, ${hit.eventDate ?? 'no date'})`,
        amountCents: r.totalCents, date: r.receiptDate, kind: 'to_review',
        why: 'The same amount is on this car in Auto Sales and in Receipts. If it is one purchase, the owner confirms the match on the finance reconcile page so it is counted once.',
        href: opts.includeBank ? '/admin/finance/reconcile' : '/expenses/review?status=filed',
      })
    }
  }
  // …a job part line whose typed cost equals an attached receipt but is not tied to it.
  const jobAllocs = allocs.filter((a) => a.target === 'job' && a.serviceOrderId)
  if (jobAllocs.length) {
    const orderIds = [...new Set(jobAllocs.map((a) => a.serviceOrderId as string))]
    const parts = await db.select({ id: jobParts.id, serviceOrderId: jobParts.serviceOrderId, description: jobParts.description, quantity: jobParts.quantity, unitCostCents: jobParts.unitCostCents })
      .from(jobParts).where(and(inArray(jobParts.serviceOrderId, orderIds), ne(jobParts.status, 'cancelled'), isNotNull(jobParts.unitCostCents)))
    const tied = new Set(jobAllocs.map((a) => a.jobPartId).filter(Boolean) as string[])
    for (const p of parts) {
      if (tied.has(p.id) || !p.unitCostCents) continue
      const cost = Math.round(p.unitCostCents * (Number(p.quantity) || 1))
      const a = jobAllocs.find((x) => x.serviceOrderId === p.serviceOrderId && receipts.some((r) => r.id === x.receiptId && (r.subtotalCents === cost || r.totalCents === cost)))
      if (a) dups.push({
        id: `${a.receiptId}:part:${p.id}`, title: `${p.description} ${money(cost)}`, detail: 'A part cost typed on the job matches a receipt attached to the same job',
        amountCents: cost, date: null, kind: 'to_review', why: 'Probably one purchase. Tie the receipt to the part on the job’s Expenses section so the two are reconciled.', href: `/orders/${p.serviceOrderId}`,
      })
    }
  }

  // 6) Purchases whose job/overhead split does not reconcile to the receipt total.
  const incomplete: QueueItem[] = []
  for (const r of receipts) {
    const s = summarizeAllocations(r.totalCents, allocsFor(r.id))
    if (s.state === 'partial') incomplete.push({ id: r.id, title: receiptTitle(r), detail: receiptDetail(r), amountCents: s.unallocatedCents, date: r.receiptDate, kind: 'to_review', why: `${money(s.unallocatedCents)} of ${money(s.totalCents)} is not assigned to a job or to overhead.`, href: '/expenses/review?status=filed' })
    else if (s.state === 'over') incomplete.push({ id: r.id, title: receiptTitle(r), detail: receiptDetail(r), amountCents: s.overCents, date: r.receiptDate, kind: 'discrepancy', why: `Assigned ${money(s.overCents)} MORE than the ${money(s.totalCents)} purchase.`, href: '/expenses/review?status=filed' })
    else if (s.state === 'unknown_total') incomplete.push({ id: r.id, title: receiptTitle(r), detail: receiptDetail(r), amountCents: null, date: r.receiptDate, kind: 'to_review', why: 'Assigned to a job, but the receipt total is not entered yet.', href: '/expenses/review' })
  }

  const restricted = (q: Queue): Queue => (opts.includeBank ? q : { ...q, restricted: true, count: 0, totalCents: null, byKind: {}, items: [] })
  const queues: Queue[] = [
    restricted(queue('txn_no_receipt', 'Bank and card purchases with no receipt', 'Money that left an account as a purchase or check, with no receipt matched to it. Card payments, transfers, payroll, loan payments and owner draws are left out — they are cash movements, not purchases.', noReceipt)),
    queue('receipt_no_txn', 'Receipts not matched to a bank or card payment', 'Filed receipts that no bank or card transaction has been matched to yet. Matching is done by a person on the CFO page; it links the two, it never adds an expense. “Not yet observable” means the bank feed does not reach that date — it is not a statement that the purchase has not posted.', unmatched),
    queue('no_job', 'Likely job purchases with no job', 'Receipts that look like they were bought for one customer’s car but are not attached to a job.', noJob),
    queue('duplicates', 'Potential duplicates', 'Records that may describe the same purchase. Nothing is merged automatically.', dups, false),
    restricted(queue('bill_no_payment', 'Expected bills not yet matched to a payment', 'Confirmed recurring bills are forecasts. This lists the ones with no CONFIRMED payment inside their own period — including ones where a likely payment is waiting for you to confirm. A confirmed payment IS that bill: the forecast and the payment are never added together.', bills)),
    queue('split', 'Purchases with an incomplete split', 'A purchase split across jobs or overhead must add up to the receipt total.', incomplete),
  ]

  const exportReady = complete.filter((r) => r.qbSyncStatus !== 'synced')
  const sources: SourceStatus[] = [
    {
      key: 'bank', label: 'Bank and card feed (Plaid)',
      state: !bankThrough ? 'unavailable' : health?.status === 'fresh' ? 'ok' : 'stale',
      detail: bankThrough ? `Transactions through ${bankThrough}. ${health?.message ?? ''}`.trim() : 'No bank transactions are loaded.',
    },
    { key: 'receipts', label: 'Receipts', state: 'ok', detail: `${complete.length} filed in the last ${days} days · ${receipts.length - complete.length} still need review. Only purchases someone captured are here — it is not a full ledger.` },
    {
      key: 'qb', label: 'QuickBooks expense records', state: 'partial',
      detail: `Read-only: QuickBooks purchases and bills are read by the daily sync and can be matched to receipts, checks and bank payments on the owner’s finance reconcile page. Receipts are never posted to QuickBooks — ${exportReady.length} filed receipt${exportReady.length === 1 ? ' is' : 's are'} “export ready” only.${lastQbo[0]?.at ? ` Last QuickBooks sync ${new Date(lastQbo[0].at).toISOString().slice(0, 10)}.` : ''}`,
    },
    { key: 'vehicle', label: 'Sales-inventory vehicle ledger', state: 'partial', detail: 'A separate per-car list with its own totals. Not linked to Receipts or the bank; overlaps are flagged under Potential duplicates.' },
    { key: 'bills', label: 'Expected recurring bills', state: opts.includeBank ? 'partial' : 'unavailable', detail: opts.includeBank ? `${obligations.length} confirmed. Checked against bank payments by vendor name and amount — a best-effort match, not a stored link.` : 'Visible to the owner/admin.' },
  ]
  return { today, windowStart, days, sources, queues }
}
