/**
 * CFO main view — the few figures the top of /admin/finance shows, each built from an existing source:
 *   bills      → Safe-to-Spend engine (safe-to-spend.ts) + checks written but not cashed + bills that may have ended
 *   profit     → the QuickBooks P&L already synced (fin_sync_runs.summary) − spending QuickBooks has not recorded (provisional.ts)
 *   costs      → the operating bank feed, grouped by what the money was (costs vs cash that is not a cost)
 *   per car    → the Production log (apps/workflow/production.ts), same dates as the bank feed
 *   attention  → one ranked list of what to do, with a link for each
 * READ-ONLY. No new ledger: every number can be traced to rows that already exist. A missing input yields
 * null ("can't say"), never a zero.
 */
import { and, desc, eq, gte, lte, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { checks } from '@/apps/checks/schema'
import { productionSummary, shopToday, type ProductionSummary } from '@/apps/workflow/production'
import { finObligations, finPlaidAccounts, finSyncRuns, finTransactions } from './schema'
import { getOperatingCash } from './db'
import { getProvisionalSpending, type ProvisionalView } from './provisional'
import { human, outstandingChecks, quietBills, spendVerdict, type OutstandingChecks, type QuietBill, type SpendVerdict } from './cash-checks'
import type { SafeToSpend } from './safe-to-spend'
import type { SyncHealth } from './sync-health'

const DAY = 86_400_000
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const prevMonth = (m: string) => iso(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 2, 1)).slice(0, 7)
const monthEnd = (m: string) => iso(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0))

// ── Profit: QuickBooks, then what QuickBooks is missing ──────────────────────────────────────────────
export interface PlSnapshot { income: number | null; cogs?: number | null; grossProfit?: number | null; expenses: number | null; net: number | null; periodStart?: string; periodEnd?: string }
export interface ProfitLine {
  month: string; periodEnd: string | null
  incomeCents: number | null; costsCents: number | null; qbNetCents: number | null       // QuickBooks, as synced
  notInQuickBooksCents: number | null; notInQuickBooksCount: number                    // provisional spending
  estimatedNetCents: number | null                                                     // QuickBooks − provisional
  likelyInQuickBooksCents: number; unclearReceiptCents: number; unclearReceiptCount: number
}
const toCents = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null)

/** PURE. A missing QuickBooks figure stays null — it is never shown as $0 profit. */
export function profitLine(month: string, pl: PlSnapshot | null | undefined, prov: Pick<ProvisionalView, 'provisionalCents' | 'provisionalCount' | 'likelyInQuickBooksCents' | 'unclearCents' | 'unclear'> | null): ProfitLine {
  const income = toCents(pl?.income), net = toCents(pl?.net)
  const costs = income != null && net != null ? income - net : null
  return {
    month, periodEnd: pl?.periodEnd ?? null, incomeCents: income, costsCents: costs, qbNetCents: net,
    notInQuickBooksCents: prov ? prov.provisionalCents : null, notInQuickBooksCount: prov?.provisionalCount ?? 0,
    estimatedNetCents: net != null && prov ? net - prov.provisionalCents : null,
    likelyInQuickBooksCents: prov?.likelyInQuickBooksCents ?? 0, unclearReceiptCents: prov?.unclearCents ?? 0, unclearReceiptCount: prov?.unclear.length ?? 0,
  }
}

// ── Costs: what left the operating account, by what it was ───────────────────────────────────────────
export interface CostTxn { amountCents: number; txnClass: string | null; isExpense: boolean; merchantName: string | null; name: string | null }
export interface CostGroup { key: string; label: string; cents: number; count: number; isCost: boolean; note?: string }
export interface CostDrivers { groups: CostGroup[]; costCents: number; notCostCents: number; topVendors: { label: string; cents: number; count: number }[] }
const GROUPS: { key: string; label: string; isCost: boolean; classes: string[]; note?: string }[] = [
  { key: 'payroll', label: 'Payroll (paychecks)', isCost: true, classes: ['payroll'] },
  { key: 'purchases', label: 'Purchases and bills (card, ACH, checks)', isCost: true, classes: ['expense', 'inventory', 'check', 'fee', 'other'] },
  { key: 'debt', label: 'Loan payments', isCost: false, classes: ['debt_payment'], note: 'Mostly repaying what was borrowed — it uses cash but only the interest is a cost.' },
  { key: 'owner', label: 'Owner draws', isCost: false, classes: ['owner_draw'], note: 'Money taken out by the owner — not a business cost.' },
  { key: 'transfers', label: 'Transfers out', isCost: false, classes: ['transfer'], note: 'Includes the monthly rent transfer to the holding account. Rent IS a cost; other transfers are not.' },
  { key: 'card', label: 'Credit-card payments', isCost: false, classes: ['card_payment'], note: 'The purchases were costs when they were made on the card; paying the card is not a second cost.' },
]
/** PURE. Money OUT of the operating account for a period, split into costs and cash that is not a cost. */
export function costDrivers(txns: CostTxn[]): CostDrivers {
  const groups: CostGroup[] = GROUPS.map((g) => ({ key: g.key, label: g.label, isCost: g.isCost, note: g.note, cents: 0, count: 0 }))
  const vendors = new Map<string, { cents: number; count: number }>()
  for (const t of txns) {
    const cls = t.txnClass ?? 'other'
    const gi = GROUPS.findIndex((g) => g.classes.includes(cls))
    const g = groups[gi >= 0 ? gi : 1]
    g.cents += t.amountCents; g.count++
    if (g.key === 'purchases') {
      const label = (t.merchantName || (cls === 'check' ? 'Paper checks' : t.name) || 'Other').slice(0, 40)
      const v = vendors.get(label) ?? { cents: 0, count: 0 }; v.cents += t.amountCents; v.count++; vendors.set(label, v)
    }
  }
  return {
    groups: groups.filter((g) => g.count > 0),
    costCents: groups.filter((g) => g.isCost).reduce((s, g) => s + g.cents, 0),
    notCostCents: groups.filter((g) => !g.isCost).reduce((s, g) => s + g.cents, 0),
    topVendors: [...vendors.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.cents - a.cents).slice(0, 6),
  }
}

// ── Per car ──────────────────────────────────────────────────────────────────────────────────────────
export interface PerCar {
  from: string; to: string
  cars: number; pricedCars: number; unpricedCars: number
  workValueCents: number; avgValueCents: number | null          // ÷ PRICED cars only
  dealer: { cars: number; avgCents: number | null }; retail: { cars: number; avgCents: number | null }
  directCostCents: number; directCostPerCarCents: number | null   // payroll + purchases from the operating account ÷ ALL cars, same dates
}
/** PURE. Value and cost use the SAME date range and the SAME business (the detail shop's operating account). */
export function perCar(p: ProductionSummary, directCostCents: number): PerCar {
  const avg = (v: number, n: number) => (n > 0 ? Math.round(v / n) : null)
  return {
    from: p.from, to: p.to, cars: p.count, pricedCars: p.pricedCount, unpricedCars: p.unpricedCount,
    workValueCents: p.valueCents, avgValueCents: avg(p.valueCents, p.pricedCount),
    dealer: { cars: p.byKind.dealer.count, avgCents: avg(p.byKind.dealer.valueCents, p.byKind.dealer.pricedCount) },
    retail: { cars: p.byKind.retail.count + p.byKind.unknown.count, avgCents: avg(p.byKind.retail.valueCents + p.byKind.unknown.valueCents, p.byKind.retail.pricedCount + p.byKind.unknown.pricedCount) },
    directCostCents, directCostPerCarCents: avg(directCostCents, p.count),
  }
}

// ── Attention list ───────────────────────────────────────────────────────────────────────────────────
export interface AttentionItem { level: 'now' | 'soon' | 'tidy'; title: string; detail: string; href: string; action: string }
const usd0 = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`

/** PURE. One ranked list — problems that make a number wrong come before housekeeping. */
export function buildAttention(i: {
  health: Pick<SyncHealth, 'status' | 'sources'>; verdict: SpendVerdict; projectedLowCents: number | null; projectedLowDate: string | null
  quiet: QuietBill[]; outstanding: OutstandingChecks; thisMonth: ProfitLine; lastMonth: ProfitLine
  quickBooksCardThrough: string | null; today: string; receiptsNeedingReview: number
}): AttentionItem[] {
  const out: AttentionItem[] = []
  for (const s of i.health.sources.filter((x) => x.state !== 'ok')) {
    out.push({ level: 'now', title: `${s.label}: the bank connection is ${s.state === 'error' ? 'down' : 'out of date'}`, detail: `${s.detail} Anything that depends on this account is out of date.`, href: '#connections', action: s.state === 'error' ? 'Run “Sync now”; if it fails again, reconnect the bank below' : 'Run “Sync now”' })
  }
  for (const b of i.verdict.blockers) if (!out.some((o) => /bank connection is/.test(o.title) && /operating/i.test(b))) out.push({ level: 'now', title: 'Safe-to-spend can’t be trusted right now', detail: b, href: '#connections', action: 'Fix the bank connection' })
  if (i.projectedLowCents != null && i.projectedLowCents < 0) out.push({ level: 'now', title: `Cash is projected to go below zero on ${i.projectedLowDate ? human(i.projectedLowDate) : 'an upcoming day'}`, detail: `The 30-day projection dips to −${usd0(-i.projectedLowCents)} even after the deposits we normally receive.`, href: '#cash-detail', action: 'See which bills land that week' })
  const behindDays = i.quickBooksCardThrough ? Math.round((utc(i.today) - utc(i.quickBooksCardThrough)) / DAY) : null
  if (behindDays == null || behindDays > 21) {
    const missing = (i.thisMonth.notInQuickBooksCents ?? 0) + (i.lastMonth.notInQuickBooksCents ?? 0)
    out.push({ level: 'now', title: 'QuickBooks is behind on card and bank purchases', detail: `${i.quickBooksCardThrough ? `Nothing after ${human(i.quickBooksCardThrough)} has been recorded` : 'No card or bank purchases have been recorded'} for the operating account. About ${usd0(missing)} of spending this month and last is missing from QuickBooks profit.`, href: '#profit-detail', action: 'Ask the bookkeeper to categorise the bank feed' })
  }
  for (const q of i.quiet) out.push({ level: 'soon', title: `Is ${q.vendor} still a bill?`, detail: q.message, href: '#bills-admin', action: 'Mark it ended (ignore) or update the amount' })
  if (i.thisMonth.unclearReceiptCount + i.lastMonth.unclearReceiptCount > 0) out.push({ level: 'soon', title: `${i.thisMonth.unclearReceiptCount + i.lastMonth.unclearReceiptCount} receipts have no clear bank payment`, detail: `${usd0(i.thisMonth.unclearReceiptCents + i.lastMonth.unclearReceiptCents)} is not counted anywhere until someone checks the date, total or payment source.`, href: '#profit-detail', action: 'Review the list' })
  if (i.outstanding.oldCents > 0) out.push({ level: 'soon', title: 'Checks older than 60 days were never cashed', detail: `${usd0(i.outstanding.oldCents)} — void and reissue, or expect them to clear.`, href: '/checks', action: 'Open check history' })
  if (i.receiptsNeedingReview > 0) out.push({ level: 'tidy', title: `${i.receiptsNeedingReview} receipt${i.receiptsNeedingReview === 1 ? ' needs' : 's need'} a manager’s review`, detail: 'Not counted as a filed purchase until reviewed.', href: '/expenses/review', action: 'Open the review queue' })
  const rank = { now: 0, soon: 1, tidy: 2 }
  return out.sort((a, b) => rank[a.level] - rank[b.level])
}

// ── Loader ───────────────────────────────────────────────────────────────────────────────────────────
export interface Dashboard {
  today: string; month: string
  bankThrough: string | null                         // newest posted operating-account transaction
  outstanding: OutstandingChecks
  quiet: QuietBill[]
  cardOwedCents: number | null; cardReservedCents: number
  verdict: SpendVerdict
  safeAfterChecksCents: number | null                // strict Safe-to-Spend − uncashed checks (may be negative)
  profit: { thisMonth: ProfitLine; lastMonth: ProfitLine; quickBooksSyncedAt: string | null; quickBooksThrough: ProvisionalView['quickBooksThrough'] }
  provisional: { thisMonth: ProvisionalView; lastMonth: ProvisionalView }
  costs: { thisMonth: CostDrivers; lastMonth: CostDrivers }
  perCar: PerCar | null
}

export async function getDashboard(input: { s2s: SafeToSpend; health: SyncHealth; month: string }): Promise<Dashboard> {
  const db = getDb()
  const today = shopToday()
  const month = input.month, last = prevMonth(month)
  const op = await getOperatingCash()
  const since = iso(utc(`${last}-01`) - 150 * DAY)
  const [txAll, obligations, written, qboRun, cardAcct, provThis, provLast] = await Promise.all([
    op ? db.select().from(finTransactions).where(and(eq(finTransactions.finAccountId, op.finAccountId), eq(finTransactions.direction, 'out'), eq(finTransactions.removed, false), gte(finTransactions.txnDate, since))) : Promise.resolve([]),
    db.select().from(finObligations).where(eq(finObligations.status, 'confirmed')),
    db.select().from(checks).where(and(ne(checks.qbStatus, 'voided'), eq(checks.qbStatus, 'recorded'), gte(checks.checkDate, iso(utc(today) - 120 * DAY)), lte(checks.checkDate, today))).catch(() => []),
    db.select({ at: finSyncRuns.finishedAt, summary: finSyncRuns.summary }).from(finSyncRuns).where(and(eq(finSyncRuns.source, 'qbo'), eq(finSyncRuns.status, 'ok'))).orderBy(desc(finSyncRuns.startedAt)).limit(1),
    db.select().from(finPlaidAccounts).where(and(eq(finPlaidAccounts.type, 'credit'), eq(finPlaidAccounts.status, 'active'), eq(finPlaidAccounts.mappingVerified, true))),
    getProvisionalSpending(month), getProvisionalSpending(last),
  ])
  const posted = txAll.filter((t) => !t.pending)
  const bankThrough = posted.reduce<string | null>((m, t) => (!m || t.txnDate > m ? t.txnDate : m), null)

  const outstanding = outstandingChecks(
    written.map((c) => ({ id: c.id, checkNumber: c.checkNumber, payeeName: c.payeeName, amountCents: c.amountCents, checkDate: c.checkDate })),
    posted.filter((t) => t.txnClass === 'check' || t.txnClass === 'payroll' || /check/i.test(t.name ?? '')).map((t) => ({ id: t.id, date: t.txnDate, amountCents: t.amountCents })),
    today,
  )
  const opBills = obligations.filter((o) => !op || o.paymentAccountId === op.finAccountId)
  const quiet = quietBills(
    opBills.map((o) => ({ id: o.id, vendor: o.vendor, discoveryKey: o.discoveryKey, frequency: o.frequency, amountCents: o.amountCents, avgAmountCents: o.avgAmountCents, amountMinCents: o.amountMinCents, amountMaxCents: o.amountMaxCents })),
    posted.map((t) => ({ date: t.txnDate, amountCents: t.amountCents, name: t.name, merchantName: t.merchantName })), today, bankThrough,
  )
  const cardOwedCents = cardAcct.length ? cardAcct.reduce((s, a) => s + (a.currentBalanceCents ?? 0), 0) : null
  const cardReservedCents = input.s2s.critical.concat(input.s2s.contractual).filter((d) => /amex|credit card/i.test(d.label)).reduce((s, d) => s + d.cents, 0)
  const opSource = input.health.sources.find((x) => x.operating)
  const verdict = spendVerdict({
    hasOperatingAccount: !!op, balanceStale: input.s2s.stale, bankFailed: opSource?.state === 'error',
    payrollFloorCents: input.s2s.payrollFloorCents, criticalBillCount: input.s2s.critical.length,
    unconfirmedAmountBills: opBills.filter((o) => o.amountCents == null && (o.avgAmountCents ?? 0) > 0).map((o) => o.vendor),
    quiet, outstandingOldCents: outstanding.oldCents, cardOwedCents, cardReservedCents,
  })

  const s = (qboRun[0]?.summary ?? {}) as { plThisMonth?: PlSnapshot; plLastMonth?: PlSnapshot }
  // The stored snapshots are "this month / last month" AS OF the sync; only use one when it is for the month asked.
  const plFor = (m: string) => [s.plThisMonth, s.plLastMonth].find((p) => p?.periodStart?.slice(0, 7) === m) ?? null
  const inMonth = (m: string) => posted.filter((t) => t.txnDate.slice(0, 7) === m)
  const costsThis = costDrivers(inMonth(month)), costsLast = costDrivers(inMonth(last))

  // Per car: production and direct cost over the SAME dates — the month so far, through the last day the bank shows.
  let pc: PerCar | null = null
  const to = bankThrough && bankThrough.slice(0, 7) === month ? bankThrough : null
  if (to) {
    const prod = await productionSummary(`${month}-01`, to).catch(() => null)
    const direct = costDrivers(posted.filter((t) => t.txnDate >= `${month}-01` && t.txnDate <= to)).costCents
    if (prod) pc = perCar(prod, direct)
  }
  return {
    today, month, bankThrough, outstanding, quiet, cardOwedCents, cardReservedCents, verdict,
    safeAfterChecksCents: input.s2s.coreSafeToSpendCents == null ? null : input.s2s.coreSafeToSpendCents - outstanding.totalCents,
    profit: { thisMonth: profitLine(month, plFor(month), provThis), lastMonth: profitLine(last, plFor(last), provLast), quickBooksSyncedAt: qboRun[0]?.at ? new Date(qboRun[0].at).toISOString() : null, quickBooksThrough: provThis.quickBooksThrough },
    provisional: { thisMonth: provThis, lastMonth: provLast },
    costs: { thisMonth: costsThis, lastMonth: costsLast },
    perCar: pc,
  }
}
export { monthEnd }
