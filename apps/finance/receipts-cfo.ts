/**
 * CFO × Receipts — the read/service layer that makes employee-filed expense receipts visible to the CFO
 * WITHOUT letting them distort the cash math.
 *
 * Design guarantees (why this is safe):
 *   - Receipts are an INFORMATIONAL COVERAGE layer. Nothing here feeds Safe-to-Spend, bank balances, or
 *     obligations, and no obligation is ever auto-created from a receipt. Unmatched receipts are shown as
 *     unmatched — never subtracted from any balance.
 *   - Purchases (what was bought, per receipt) are kept distinct from cash actually paid. Business-funded,
 *     personal-reimbursement, and unpaid receipts are reported in separate buckets.
 *   - Reconciliation to a bank transaction is a HUMAN decision. Candidate matches are computed on the fly as
 *     SUGGESTIONS (scoreCandidate) and NEVER auto-applied — two equal amounts never silently link. Only a
 *     confirmed decision is persisted (fin_receipt_matches). A confirmed receipt is treated as already
 *     represented by its bank transaction, so it is NEVER counted as a second expense on top of the txn.
 *   - Operational categories (shop_supplies/parts/…) stay separate from any accounting classification — we
 *     invent no chart-of-accounts mapping here.
 *
 * Money is integer cents; dates are plain 'YYYY-MM-DD' (no timezone), consistent with the finance module.
 */
import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { businessReceipts } from '@/apps/expenses/schema'
import { isCompleteStatus, isBusinessDate, inBusinessMonth } from '@/apps/expenses/types'
import { monthlyExpenseReport } from '@/apps/expenses/db'
import { currentReportMonth } from '@/apps/auto-sales/report-db'
import { finTransactions, finReceiptMatches, finEvents } from './schema'

// ── Pure candidate scoring (unit-tested; no DB) ───────────────────────────────────────────────────────
export interface ScoreReceipt { totalCents: number | null; receiptDate: string | null; vendor: string | null }
export interface ScoreTxn { amountCents: number; txnDate: string; name: string | null; merchantName: string | null }
export interface CandidateScore {
  amountDeltaCents: number | null
  dateDeltaDays: number | null
  nameOverlap: boolean
  strength: 'strong' | 'possible' | 'none'
  rank: number // lower is better (for ordering); Infinity when 'none'
}

/** Whole-day distance between two 'YYYY-MM-DD' dates, or null if either is not a valid business date. */
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!isBusinessDate(a) || !isBusinessDate(b)) return null
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))
  return Math.round(Math.abs(da - db) / 86_400_000)
}

function tokens(s: string | null | undefined): Set<string> {
  return new Set((s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3))
}
function overlaps(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = tokens(a); if (ta.size === 0) return false
  for (const t of tokens(b)) if (ta.has(t)) return true
  return false
}

/** Amount tolerance for a "possible" match: the greater of 50¢ or 1% of the receipt total. */
export function amountToleranceCents(totalCents: number): number { return Math.max(50, Math.round(totalCents * 0.01)) }

/**
 * Score a receipt against ONE candidate bank transaction. This produces a SUGGESTION signal only — it never
 * decides a link. 'strong' = exact amount + close date + vendor/name overlap; 'possible' = amount within a
 * small tolerance and a plausible date; otherwise 'none'. Equal amounts alone are at most 'possible', and
 * even 'strong' still requires an explicit human confirm before anything is persisted.
 */
export function scoreCandidate(receipt: ScoreReceipt, txn: ScoreTxn): CandidateScore {
  if (receipt.totalCents == null || receipt.totalCents <= 0) {
    return { amountDeltaCents: null, dateDeltaDays: null, nameOverlap: false, strength: 'none', rank: Infinity }
  }
  const amountDeltaCents = Math.abs(txn.amountCents - receipt.totalCents) // txn out-amount is positive (Plaid)
  const dateDeltaDays = daysBetween(receipt.receiptDate, txn.txnDate)
  const nameOverlap = overlaps(receipt.vendor, txn.merchantName) || overlaps(receipt.vendor, txn.name)
  const tol = amountToleranceCents(receipt.totalCents)
  let strength: CandidateScore['strength'] = 'none'
  if (amountDeltaCents === 0 && dateDeltaDays != null && dateDeltaDays <= 5 && nameOverlap) strength = 'strong'
  else if (amountDeltaCents <= tol && (dateDeltaDays == null || dateDeltaDays <= 14)) strength = 'possible'
  const rank = strength === 'none' ? Infinity : amountDeltaCents * 1000 + (dateDeltaDays ?? 999)
  return { amountDeltaCents, dateDeltaDays, nameOverlap, strength, rank }
}

export interface RankedCandidate extends CandidateScore { txnId: string; txn: ScoreTxn }
/** Rank a receipt's plausible candidates best-first (strong before possible, then closeness). Returns at
 *  most `limit`. Purely a suggestion list — no side effects, no auto-linking. */
export function rankCandidates(receipt: ScoreReceipt, txns: (ScoreTxn & { id: string })[], limit = 3): RankedCandidate[] {
  const scored = txns
    .map((t) => ({ txnId: t.id, txn: t, ...scoreCandidate(receipt, t) }))
    .filter((c) => c.strength !== 'none')
  const order = { strong: 0, possible: 1, none: 2 } as const
  scored.sort((a, b) => order[a.strength] - order[b.strength] || a.rank - b.rank)
  return scored.slice(0, limit)
}

// ── DB read models ────────────────────────────────────────────────────────────────────────────────────
export type ReceiptMatchRow = typeof finReceiptMatches.$inferSelect
async function matchMap(receiptIds: string[]): Promise<Map<string, ReceiptMatchRow>> {
  const m = new Map<string, ReceiptMatchRow>()
  if (receiptIds.length === 0) return m
  const rows = await getDb().select().from(finReceiptMatches).where(inArray(finReceiptMatches.receiptId, receiptIds))
  for (const r of rows) m.set(r.receiptId, r)
  return m
}

const RECONCILABLE_FUNDING = (f: string) => f !== 'personal' && f !== 'unpaid' // business + legacy unknown

export interface ReceiptCoverage {
  month: string
  completeCount: number
  purchasesTotalCents: number
  byBusiness: Record<string, { count: number; totalCents: number }>
  byCategory: Record<string, { count: number; totalCents: number }>
  // Reconcilable pool (business + legacy-unknown funding) split by whether a bank match is CONFIRMED.
  reconcilableCents: number
  reconciledCents: number            // already represented by a bank transaction — never a second expense
  unreconciledCents: number          // receipt-only coverage, not yet seen in the bank (NOT subtracted anywhere)
  reconciledCount: number
  unreconciledCount: number
  dismissedCount: number
  // Kept distinct from cash actually paid.
  personalReimbursableCents: number  // employee out-of-pocket — a reimbursement review, NOT business cash
  unpaidCents: number                // not yet paid — a payment review, NOT cash spent, NOT an auto-obligation
  // Informational attention (unresolved receipts a manager still needs to look at).
  needsReviewCount: number
  processingFailedCount: number
  uncategorizedCount: number
}

/**
 * Month coverage summary for the CFO receipt section. Purchases are counted once each (filed ∪ legacy
 * approved); reconciled receipts are flagged as already-in-bank so a reader never double counts them with
 * the bank transactions. Personal and unpaid totals are surfaced separately and never treated as business
 * cash. Nothing here changes Safe-to-Spend or any balance.
 */
export async function getReceiptCoverage(month: string = currentReportMonth()): Promise<ReceiptCoverage> {
  const rep = await monthlyExpenseReport(month)
  // Reconcilable pool = COMPLETE (filed ∪ approved) receipts that are business-account purchases.
  const reconcilable = rep.complete.filter((r) => RECONCILABLE_FUNDING(r.funding))
  const matches = await matchMap(reconcilable.map((r) => r.id))
  let reconcilableCents = 0, reconciledCents = 0, reconciledCount = 0, dismissedCount = 0
  for (const r of reconcilable) {
    const amt = r.totalCents ?? 0
    reconcilableCents += amt
    const m = matches.get(r.id)
    if (m?.status === 'confirmed') { reconciledCents += amt; reconciledCount++ }
    else if (m?.status === 'dismissed') dismissedCount++
  }
  const reconcilablePoolCount = reconcilable.length
  // Personal / unpaid receipts stay in the "needs attention" exception queue (they are NOT clean filings),
  // but the CFO must still SEE them as a reimbursement review / payment review. Sum them across all
  // non-rejected receipts in the month by funding — informational only; never business cash, never an
  // auto-created obligation, never subtracted from anything.
  const all = await getDb().select({ status: businessReceipts.status, funding: businessReceipts.funding, total: businessReceipts.totalCents, date: businessReceipts.receiptDate })
    .from(businessReceipts).where(ne(businessReceipts.status, 'rejected'))
  let personal = 0, unpaid = 0
  for (const r of all) {
    if (!inBusinessMonth(r.date, month)) continue
    if (r.funding === 'personal') personal += r.total ?? 0
    else if (r.funding === 'unpaid') unpaid += r.total ?? 0
  }
  return {
    month,
    completeCount: rep.completeCount,
    purchasesTotalCents: rep.purchasesTotalCents,
    byBusiness: rep.byEntity,
    byCategory: rep.byCategory,
    reconcilableCents,
    reconciledCents,
    unreconciledCents: reconcilableCents - reconciledCents,
    reconciledCount,
    unreconciledCount: reconcilablePoolCount - reconciledCount - dismissedCount,
    dismissedCount,
    personalReimbursableCents: personal,
    unpaidCents: unpaid,
    needsReviewCount: rep.needsReviewCount,
    processingFailedCount: rep.processingFailedCount,
    uncategorizedCount: rep.uncategorizedCount,
  }
}

export interface ReconRow {
  receiptId: string
  vendor: string | null
  receiptDate: string | null
  totalCents: number | null
  entity: string
  category: string
  funding: string
  accountRef: string | null
  paymentMethod: string | null
  paymentLast4: string | null        // the card ending — lets the CFO label distinguish the two AMB cards
  imageUrl: string | null            // gated, manager/admin-only retrieval route (never a raw blob URL)
  suggestions: { txnId: string; amountCents: number; txnDate: string; label: string; strength: 'strong' | 'possible'; amountDeltaCents: number | null; dateDeltaDays: number | null }[]
}
export interface ReceiptReconciliation {
  month: string
  unreconciled: ReconRow[]           // complete, reconcilable, no decision yet — with on-the-fly suggestions
  confirmed: { receiptId: string; vendor: string | null; totalCents: number | null; txnId: string; txnLabel: string; txnDate: string | null }[]
  dismissedCount: number
}

/** Month-scoped date bounds (with a ±15d window for candidate transactions that cleared just outside). */
function monthWindow(month: string): { start: string; end: string; winStart: string; winEnd: string } {
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  const start = `${month}-01`
  const endDate = new Date(Date.UTC(y, m, 0)) // last day of month
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const shift = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000)
  return { start, end: iso(endDate), winStart: iso(shift(new Date(Date.UTC(y, m - 1, 1)), -15)), winEnd: iso(shift(endDate, 15)) }
}

/**
 * The reconciliation worklist: each unreconciled reconcilable receipt for the month with its best on-the-fly
 * bank-transaction SUGGESTIONS (never auto-linked), plus the list of already-confirmed matches. A candidate
 * transaction that is already confirm-linked to ANOTHER receipt is excluded, so one bank transaction can
 * back at most one receipt (no double count).
 */
export async function getReceiptReconciliation(month: string = currentReportMonth(), limitReceipts = 40): Promise<ReceiptReconciliation> {
  const db = getDb()
  const { winStart, winEnd } = monthWindow(month)
  // Complete receipts in the month (reuse the expenses report for month membership + completeness).
  const rep = await monthlyExpenseReport(month)
  const reconcilable = rep.complete.filter((r) => RECONCILABLE_FUNDING(r.funding))
  const matches = await matchMap(reconcilable.map((r) => r.id))

  // Bank OUT transactions in the window; exclude ones already confirm-linked to a receipt.
  const outTxns = await db.select({
    id: finTransactions.id, amountCents: finTransactions.amountCents, txnDate: finTransactions.txnDate,
    name: finTransactions.name, merchantName: finTransactions.merchantName,
  }).from(finTransactions).where(and(
    eq(finTransactions.direction, 'out'), eq(finTransactions.removed, false),
    gte(finTransactions.txnDate, winStart), lte(finTransactions.txnDate, winEnd),
  ))
  const confirmedTxnIds = new Set(
    (await db.select({ txnId: finReceiptMatches.txnId }).from(finReceiptMatches)
      .where(eq(finReceiptMatches.status, 'confirmed'))).map((r) => r.txnId).filter(Boolean) as string[],
  )
  const available = outTxns.filter((t) => !confirmedTxnIds.has(t.id))
  const txnById = new Map(outTxns.map((t) => [t.id, t]))
  const txnLabel = (t: { merchantName: string | null; name: string | null; amountCents?: number }) => (t.merchantName || t.name || 'Bank transaction')

  const unreconciled: ReconRow[] = []
  const confirmed: ReceiptReconciliation['confirmed'] = []
  let dismissedCount = 0
  for (const r of reconcilable) {
    const decision = matches.get(r.id)
    if (decision?.status === 'confirmed') {
      const t = decision.txnId ? txnById.get(decision.txnId) : null
      confirmed.push({ receiptId: r.id, vendor: r.vendor, totalCents: r.totalCents, txnId: decision.txnId ?? '', txnLabel: t ? txnLabel(t) : 'Matched transaction', txnDate: t?.txnDate ?? null })
      continue
    }
    if (decision?.status === 'dismissed') { dismissedCount++; continue }
    if (unreconciled.length >= limitReceipts) continue
    const ranked = rankCandidates({ totalCents: r.totalCents, receiptDate: r.receiptDate, vendor: r.vendor }, available)
    unreconciled.push({
      receiptId: r.id, vendor: r.vendor, receiptDate: r.receiptDate, totalCents: r.totalCents,
      entity: r.entity, category: r.category, funding: r.funding, accountRef: r.accountRef, paymentMethod: r.paymentMethod, paymentLast4: r.paymentLast4,
      imageUrl: r.storage !== 'none' && r.storageRef ? `/api/expenses/receipt/${r.id}/image` : null,
      suggestions: ranked.filter((c) => c.strength !== 'none').map((c) => ({
        txnId: c.txnId, amountCents: c.txn.amountCents, txnDate: c.txn.txnDate, label: txnLabel(c.txn),
        strength: c.strength as 'strong' | 'possible', amountDeltaCents: c.amountDeltaCents, dateDeltaDays: c.dateDeltaDays,
      })),
    })
  }
  return { month, unreconciled, confirmed, dismissedCount }
}

// ── Reconciliation decisions (human-confirmed; the ONLY thing persisted) ──────────────────────────────
async function audit(action: string, receiptId: string, actor: string | null, after: unknown) {
  await getDb().insert(finEvents).values({ actor, action, entity: 'receipt_match', entityId: receiptId, after: after as object, source: 'manual' }).catch(() => {})
}

export interface MatchResult { ok: boolean; error?: string }

/**
 * CONFIRM that a filed receipt corresponds to a specific bank transaction. Validates that the receipt is a
 * complete, reconcilable (business/unknown-funded) receipt and that the transaction is a real money-OUT
 * transaction not already claimed by a different receipt. Idempotent (receiptId PK → upsert). This records
 * a reconciliation fact ONLY — it moves no money and changes no balance; the bank transaction remains the
 * authoritative cash figure, so the receipt is never counted as a second expense.
 */
export async function confirmReceiptMatch(receiptId: string, txnId: string, actor: string | null): Promise<MatchResult> {
  const db = getDb()
  const [receipt] = await db.select().from(businessReceipts).where(eq(businessReceipts.id, receiptId)).limit(1)
  if (!receipt) return { ok: false, error: 'Receipt not found.' }
  if (!isCompleteStatus(receipt.status)) return { ok: false, error: 'Only a filed/approved receipt can be reconciled.' }
  if (!RECONCILABLE_FUNDING(receipt.funding)) return { ok: false, error: 'Personal and unpaid receipts are not business-account transactions.' }
  const [txn] = await db.select({
    id: finTransactions.id, amountCents: finTransactions.amountCents, txnDate: finTransactions.txnDate,
    name: finTransactions.name, merchantName: finTransactions.merchantName,
  }).from(finTransactions).where(and(eq(finTransactions.id, txnId), eq(finTransactions.direction, 'out'), eq(finTransactions.removed, false))).limit(1)
  if (!txn) return { ok: false, error: 'That bank transaction is not available to match.' }
  // A transaction may back at most one receipt (no double count): reject if already confirmed elsewhere.
  const clash = await db.select({ receiptId: finReceiptMatches.receiptId }).from(finReceiptMatches)
    .where(and(eq(finReceiptMatches.txnId, txnId), eq(finReceiptMatches.status, 'confirmed'), ne(finReceiptMatches.receiptId, receiptId))).limit(1)
  if (clash.length > 0) return { ok: false, error: 'That transaction is already matched to another receipt.' }
  const evidence = scoreCandidate(
    { totalCents: receipt.totalCents, receiptDate: receipt.receiptDate, vendor: receipt.vendor },
    { amountCents: txn.amountCents, txnDate: txn.txnDate, name: txn.name, merchantName: txn.merchantName },
  )
  const value = { txnId, status: 'confirmed' as const, amountCents: receipt.totalCents, matchedBy: actor, matchedAt: new Date(), evidence }
  await db.insert(finReceiptMatches).values({ receiptId, ...value })
    .onConflictDoUpdate({ target: finReceiptMatches.receiptId, set: { txnId, status: 'confirmed', amountCents: receipt.totalCents, matchedBy: actor, matchedAt: new Date(), evidence } })
  await audit('confirm', receiptId, actor, { txnId, evidence })
  return { ok: true }
}

/** DISMISS a receipt from the worklist as "no bank match" (e.g. cash, or paid from an unconnected account).
 *  Records the decision only; creates no obligation and subtracts nothing. Idempotent. */
export async function dismissReceiptMatch(receiptId: string, actor: string | null): Promise<MatchResult> {
  const db = getDb()
  const [receipt] = await db.select({ id: businessReceipts.id, total: businessReceipts.totalCents }).from(businessReceipts).where(eq(businessReceipts.id, receiptId)).limit(1)
  if (!receipt) return { ok: false, error: 'Receipt not found.' }
  await db.insert(finReceiptMatches).values({ receiptId, txnId: null, status: 'dismissed', amountCents: receipt.total, matchedBy: actor, matchedAt: new Date() })
    .onConflictDoUpdate({ target: finReceiptMatches.receiptId, set: { txnId: null, status: 'dismissed', matchedBy: actor, matchedAt: new Date() } })
  await audit('dismiss', receiptId, actor, {})
  return { ok: true }
}

/** Undo a prior confirm/dismiss so the receipt returns to the worklist. */
export async function clearReceiptMatch(receiptId: string, actor: string | null): Promise<MatchResult> {
  await getDb().delete(finReceiptMatches).where(eq(finReceiptMatches.receiptId, receiptId))
  await audit('clear', receiptId, actor, {})
  return { ok: true }
}
