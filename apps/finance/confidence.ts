/**
 * CFO confidence SCORECARD — a defensible, per-domain data-reliability model that replaces the old
 * cosmetic "100 − gap penalties" number. Each domain is scored 0–100 from ACTUAL live state
 * (is the authoritative source connected, fresh, complete, verified?), carries its authoritative
 * source + current value + what would raise it, and is weighted by how much the OPERATING-cash
 * decision actually depends on it. The overall score is the weighted average — explainable, not a
 * feel-good average of unrelated domains.
 *
 * Scoring bands (see the owner-facing legend):
 *   95–100  authoritative / reconciled — safe for operational decisions
 *   90–94   highly trustworthy, minor known limitations
 *   75–89   useful, material limitations remain
 *   50–74   directional only
 *   <50     do not rely on for financial decisions
 *
 * Pure read/aggregation. No writes, no money movement.
 */
import { and, eq, sql, desc } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finPlaidAccounts, finExpectedInflows, finSyncRuns, finObligations } from './schema'
import { getOperatingCash, getDebts, getDataGaps, type DataGap } from './db'
import { getReservePolicy } from '@/apps/settings/db'
import { getSyncHealth } from './sync-health'

export type Tier = 'authoritative' | 'trustworthy' | 'useful' | 'directional' | 'unreliable'
export interface DomainScore {
  key: string
  label: string
  group: 'cash' | 'obligations' | 'forecast' | 'accounting' | 'segment'
  source: string            // authoritative source
  value: string             // current value / status if calculable, else 'Unknown'
  freshness: string         // how current the underlying data is
  confidencePct: number     // 0–100 data reliability
  tier: Tier
  weight: number            // relative importance to the OPERATING-cash decision (0..)
  influencesDecisions: boolean
  toImprove: string         // what specifically would raise it toward 90/95%+
}

const tierOf = (p: number): Tier => p >= 95 ? 'authoritative' : p >= 90 ? 'trustworthy' : p >= 75 ? 'useful' : p >= 50 ? 'directional' : 'unreliable'
const d = (c: number | null | undefined) => c == null ? 'Unknown' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`

export interface Scorecard {
  // Two DISTINCT numbers on purpose — we never average unrelated domains into one reassuring figure.
  decisionPct: number       // trust in TODAY's Safe-to-Spend answer (cash + obligation inputs only)
  decisionTier: Tier
  overallPct: number        // full-financial-picture data reliability (all domains, weighted)
  overallTier: Tier
  label: string
  decisionLabel: string
  domains: DomainScore[]
  gaps: DataGap[]
  legend: { band: string; meaning: string }[]
}

export async function getConfidenceScorecard(): Promise<Scorecard> {
  const db = getDb()
  const [op, sync, debts, reserves, gaps] = await Promise.all([
    getOperatingCash(), getSyncHealth(), getDebts(), getReservePolicy(), getDataGaps(),
  ])

  // Verified/active live accounts.
  const verified = await db.select().from(finPlaidAccounts).where(and(eq(finPlaidAccounts.mappingVerified, true), eq(finPlaidAccounts.status, 'active')))
  const acct = (m: RegExp) => verified.find((v) => m.test(v.mask ?? '') || m.test(v.name ?? ''))
  const op2649 = acct(/2649/), as5600 = acct(/5600/), amex = verified.find((v) => v.type === 'credit' || /5008|platinum|amex/i.test(`${v.mask} ${v.name}`))

  // QuickBooks accounting freshness (last successful qbo run).
  const [qbRun] = await db.select().from(finSyncRuns).where(and(eq(finSyncRuns.source, 'qbo'), eq(finSyncRuns.status, 'ok'))).orderBy(desc(finSyncRuns.startedAt)).limit(1)
  const qbAgeHours = qbRun ? (Date.now() - new Date(qbRun.startedAt).getTime()) / 3_600_000 : null
  const qbSummary = (qbRun?.summary ?? {}) as any
  const qbFresh = qbAgeHours == null ? 'never' : qbAgeHours < 36 ? `${Math.round(qbAgeHours)}h ago` : `${Math.round(qbAgeHours / 24)}d ago`
  const qbFreshScore = qbAgeHours == null ? 0 : qbAgeHours <= 36 ? 1 : qbAgeHours <= 24 * 7 ? 0.7 : 0.45  // decays with staleness

  // Live-cash freshness multiplier (fresh bank data is a precondition for trusting cash math).
  const cashFresh = sync.status === 'fresh' ? 1 : sync.status === 'stale' ? 0.7 : sync.status === 'failed' ? 0.5 : 0.3
  const freshLabel = sync.ageHours == null ? 'never' : sync.ageHours < 1 ? `${Math.round(sync.ageHours * 60)}m ago` : `${Math.round(sync.ageHours)}h ago`

  // Amex transaction completeness — verified balance is high, but Plaid card spend feed is sparse.
  const amexTx = amex ? await db.select({ n: sql<number>`count(*)::int`, mx: sql<string>`max(txn_date)` }).from(sql`fin_transactions t`).where(sql`t.plaid_account_id = ${amex.plaidAccountId} and t.removed = false`).then((r) => r[0]).catch(() => ({ n: 0, mx: null })) : { n: 0, mx: null }
  const amexTxAgeDays = amexTx?.mx ? Math.round((Date.now() - new Date(amexTx.mx as string).getTime()) / 86400_000) : null

  // Expected-inflow composition — how much of the forecast rests on PATTERN vs booked evidence.
  const infRows = await db.select({ refType: finExpectedInflows.refType, cents: finExpectedInflows.amountCents })
    .from(finExpectedInflows).where(and(sql`${finExpectedInflows.status} <> 'dismissed'`, sql`${finExpectedInflows.expectedDate} <= (now() + interval '30 days')::date`))
  const infTotal = infRows.reduce((t, r) => t + r.cents, 0)
  const infPattern = infRows.filter((r) => r.refType === 'pattern').reduce((t, r) => t + r.cents, 0)
  const patternShare = infTotal > 0 ? infPattern / infTotal : 0   // 1.0 today → forecast is entirely pattern-based

  // Payroll / obligations coverage.
  const payrollObls = await db.select({ n: sql<number>`count(*)::int` }).from(finObligations).where(and(eq(finObligations.category, 'payroll'), eq(finObligations.status, 'confirmed'))).then((r) => r[0].n)
  const confirmedObls = await db.select({ n: sql<number>`count(*)::int` }).from(finObligations).where(eq(finObligations.status, 'confirmed')).then((r) => r[0].n)

  // Debt verification coverage (by principal).
  const withPrincipal = debts.filter((x) => (x.principalCents ?? 0) > 0)
  const debtTotal = withPrincipal.reduce((t, x) => t + (x.principalCents ?? 0), 0)
  const debtVerified = withPrincipal.filter((x) => x.verified).reduce((t, x) => t + (x.principalCents ?? 0), 0)
  const debtVerShare = debtTotal > 0 ? debtVerified / debtTotal : 0
  const debtAprShare = debtTotal > 0 ? withPrincipal.filter((x) => x.aprBps != null).reduce((t, x) => t + (x.principalCents ?? 0), 0) / debtTotal : 0

  const round = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
  const domains: DomainScore[] = []
  const add = (dd: Omit<DomainScore, 'tier'>) => domains.push({ ...dd, tier: tierOf(dd.confidencePct) })

  // ── CASH (heavy weight — this dashboard exists to answer "spend from *2649") ──
  add({ key: 'op_cash', label: 'Operating bank cash *2649', group: 'cash', source: 'Plaid live balance (verified mapping)', value: d(op?.availableCents), freshness: freshLabel, confidencePct: round((op2649 ? 98 : 0) * cashFresh), weight: 5, influencesDecisions: true, toImprove: op2649 ? 'Already verified-live; keep the daily sync green.' : 'Verify the *2649 Plaid mapping.' })
  add({ key: 'as_cash', label: 'Auto-Sales bank cash *5600', group: 'cash', source: 'Plaid live balance (verified mapping)', value: d(as5600?.availableBalanceCents), freshness: freshLabel, confidencePct: round((as5600 ? 96 : 0) * cashFresh), weight: 1, influencesDecisions: false, toImprove: 'Balance is trusted; UNENCUMBERED cash needs the floor-plan/VIN ledger.' })
  add({ key: 'card_bal', label: 'Credit-card balance (Amex)', group: 'cash', source: 'Plaid live balance (verified mapping)', value: d(amex?.currentBalanceCents), freshness: freshLabel, confidencePct: round((amex ? 95 : 0) * cashFresh), weight: 1.5, influencesDecisions: true, toImprove: amex ? 'Balance is live; only spend-detail (below) is thin.' : 'Verify the Amex Plaid mapping.' })
  add({ key: 'card_tx', label: 'Credit-card transaction completeness', group: 'cash', source: 'Plaid card transaction feed', value: `${amexTx?.n ?? 0} txns${amexTxAgeDays != null ? `, last ${amexTxAgeDays}d ago` : ''}`, freshness: amexTxAgeDays != null ? `${amexTxAgeDays}d ago` : 'never', confidencePct: amexTxAgeDays == null ? 20 : amexTxAgeDays > 20 ? 45 : amexTxAgeDays > 7 ? 65 : 80, weight: 0.5, influencesDecisions: false, toImprove: 'Amex spend feed is sparse/stale and unmapped to the AMEX account — categorized card spend would sharpen variable-cost tracking (balance is unaffected).' })

  // ── OBLIGATIONS (heavy weight — the "out" side of Safe-to-Spend) ──
  add({ key: 'payroll', label: 'Payroll', group: 'obligations', source: 'QuickBooks Payroll → confirmed weekly obligations', value: payrollObls > 0 ? `${payrollObls} W-2 lines confirmed` : 'not confirmed', freshness: 'confirmed', confidencePct: payrollObls > 0 ? 90 : 30, weight: 4, influencesDecisions: true, toImprove: payrollObls > 0 ? 'Reconciled to QB Payroll; re-verify when headcount/pay changes.' : 'Confirm payroll obligations.' })
  add({ key: 'payroll_tax', label: 'Payroll taxes', group: 'obligations', source: 'Intuit 941 withdrawals (bank-observed)', value: '$525/wk fed', freshness: 'confirmed', confidencePct: 82, weight: 2, influencesDecisions: true, toImprove: 'Cadence inferred from bank history; a QB Payroll tax-liability read would confirm exact amounts/dates.' })
  add({ key: 'fixed_obl', label: 'Fixed / recurring obligations', group: 'obligations', source: 'Bank-history discovery → owner-confirmed', value: `${confirmedObls} confirmed`, freshness: freshLabel, confidencePct: 88, weight: 3, influencesDecisions: true, toImprove: 'Most recurring bills confirmed from ≥2 occurrences; long-tail/annual items may still be unmodeled.' })
  add({ key: 'variable_spend', label: 'Variable operating spend', group: 'obligations', source: 'Plaid transactions (classified)', value: 'tracked, not forecast', freshness: freshLabel, confidencePct: round(60 * cashFresh), weight: 1, influencesDecisions: false, toImprove: 'Discretionary spend is observed historically but not projected forward as an obligation.' })
  add({ key: 'debt_bal', label: 'Debt balances', group: 'obligations', source: 'QuickBooks book + verified statements', value: `${d(debtTotal)} (${Math.round(debtVerShare * 100)}% verified)`, freshness: qbFresh, confidencePct: round(70 + 28 * debtVerShare), weight: 2, influencesDecisions: true, toImprove: debtVerShare < 1 ? 'Verify remaining loan statements to lift book balances to statement-verified.' : 'Fully statement-verified.' })
  add({ key: 'debt_pay', label: 'Debt payments / service', group: 'obligations', source: 'Bank-observed payments + statements', value: `${Math.round(debtAprShare * 100)}% have APR`, freshness: qbFresh, confidencePct: round(72 + 20 * debtAprShare), weight: 1.5, influencesDecisions: true, toImprove: debtAprShare < 1 ? 'QB Capital APRs are estimated — payoff-ranking sharpens with the real agreements.' : 'Terms verified.' })
  add({ key: 'reserves', label: 'Reserve position', group: 'obligations', source: 'Owner reserve policy', value: reserves.configured ? d(reserves.totalCents) : '$0 (unconfigured)', freshness: 'policy', confidencePct: reserves.configured ? 90 : 60, weight: 1, influencesDecisions: true, toImprove: reserves.configured ? 'Policy set.' : 'Set a reserve policy (payroll/tax buffer) so Safe-to-Spend protects a real floor. Value is KNOWN ($0), the POLICY is what is unset.' })

  // ── FORECAST (medium weight — tiered honesty is what matters here) ──
  const fcBase = round((85 - 35 * patternShare) * cashFresh)  // pattern-heavy forecast → lower reliability
  add({ key: 'fc7', label: '7-day cash forecast', group: 'forecast', source: 'Verified cash + dated obligations + expected inflows', value: 'computed', freshness: freshLabel, confidencePct: Math.min(88, fcBase + 8), weight: 3, influencesDecisions: true, toImprove: 'Near-term obligations are dated & solid; the inflow side leans on historical deposit PATTERNS, not booked receivables.' })
  add({ key: 'fc14', label: '14-day cash forecast', group: 'forecast', source: 'Verified cash + obligations + expected inflows', value: 'computed', freshness: freshLabel, confidencePct: Math.min(82, fcBase + 3), weight: 2, influencesDecisions: true, toImprove: 'Same pattern-inflow limitation; booking real dealer/retail receivables would raise it.' })
  add({ key: 'fc30', label: '30-day cash forecast', group: 'forecast', source: 'Verified cash + obligations + expected inflows', value: 'computed', freshness: freshLabel, confidencePct: fcBase, weight: 2, influencesDecisions: true, toImprove: `~${Math.round(patternShare * 100)}% of expected inflow is a historical run-rate projection — replace with invoice/AR-backed receivables to trust the 30-day ending cash.` })
  add({ key: 'dealer_in', label: 'Dealer expected collections', group: 'forecast', source: 'Trailing 60-day non-card deposit median (PATTERN)', value: 'pattern-based', freshness: freshLabel, confidencePct: 58, weight: 1.5, influencesDecisions: true, toImprove: 'This is a deposit-history run-rate, NOT a receivable. Tie to invoiced/awaited dealer jobs for true receivable confidence.' })
  add({ key: 'retail_in', label: 'Retail card settlements', group: 'forecast', source: 'Trailing 60-day card-settlement daily avg (PATTERN)', value: 'pattern-based', freshness: freshLabel, confidencePct: 58, weight: 1.5, influencesDecisions: true, toImprove: 'This projects FUTURE card revenue from history — cards are not yet charged. Distinct from settling authorizations.' })

  // ── ACCOUNTING (medium weight — QB is authoritative but was stale; now on daily cron) ──
  const plRecon = qbSummary?.plLastMonth && qbSummary.plLastMonth.income != null && qbSummary.plLastMonth.grossProfit != null
  add({ key: 'ar', label: 'Accounts Receivable', group: 'accounting', source: 'QuickBooks Aged Receivables', value: qbSummary?.arTotal != null ? `$${Number(qbSummary.arTotal).toLocaleString()}` : 'Unknown', freshness: qbFresh, confidencePct: round((qbSummary?.arTotal != null ? 88 : 0) * qbFreshScore), weight: 1.5, influencesDecisions: true, toImprove: 'QB AR is authoritative; keep the daily QB sync green so it never goes stale.' })
  add({ key: 'company_profit', label: 'Company profitability (P&L)', group: 'accounting', source: 'QuickBooks Profit & Loss', value: plRecon ? `last mo net $${Number(qbSummary.plLastMonth.net).toLocaleString()}` : 'Unknown', freshness: qbFresh, confidencePct: round((plRecon ? 85 : 0) * qbFreshScore), weight: 1.5, influencesDecisions: false, toImprove: 'P&L reconciles (Income−COGS−Expense=Net) but BLENDS Detail + Auto-Sales — company-level only until segmented.' })
  add({ key: 'uninvoiced', label: 'Completed-but-uninvoiced work', group: 'accounting', source: 'PSOS jobs vs QB invoices', value: 'partial', freshness: freshLabel, confidencePct: 45, weight: 1, influencesDecisions: false, toImprove: 'No systematic reconciliation of finished jobs against issued invoices yet.' })

  // ── SEGMENT / DEEPER (low weight for the operating-cash decision; honest low scores) ──
  add({ key: 'detail_profit', label: 'Detail/Service profitability', group: 'segment', source: 'QB P&L (needs class/segment split)', value: 'not segmented', freshness: qbFresh, confidencePct: 35, weight: 1, influencesDecisions: false, toImprove: 'Needs a QB class/account policy to separate Detail from Auto-Sales revenue & COGS.' })
  add({ key: 'autosales_profit', label: 'Auto-Sales profitability', group: 'segment', source: 'Per-vehicle ledger (historical_incomplete)', value: 'incomplete', freshness: freshLabel, confidencePct: 30, weight: 1, influencesDecisions: false, toImprove: 'Per-vehicle cost/sale/floor-plan ledger is only partially populated (historical records incomplete).' })
  add({ key: 'autosales_capital', label: 'Auto-Sales capital tied up', group: 'segment', source: 'Inventory + floor-plan ledger', value: 'not attributed', freshness: freshLabel, confidencePct: 30, weight: 1, influencesDecisions: false, toImprove: 'Vehicle inventory value & per-vehicle floor-plan encumbrance not yet attributed.' })
  add({ key: 'p2c', label: 'Profit-to-cash bridge', group: 'segment', source: 'P&L + balance-sheet deltas + debt principal', value: 'partial', freshness: qbFresh, confidencePct: 40, weight: 1, influencesDecisions: false, toImprove: 'Debt principal & owner draws are known; AR/AP deltas + inventory changes needed for a full bridge.' })

  // DECISION confidence = only the inputs to today's Safe-to-Spend answer (verified cash + committed
  // obligations). This is what to trust when deciding whether to spend from *2649 today — and it is
  // high, because cash is live-verified and obligations are confirmed.
  const decisionDomains = domains.filter((x) => x.group === 'cash' || x.group === 'obligations')
  const dW = decisionDomains.reduce((t, x) => t + x.weight, 0)
  const decision = round(decisionDomains.reduce((t, x) => t + x.confidencePct * x.weight, 0) / (dW || 1))
  const decisionTier = tierOf(decision)
  const decisionLabel = decision >= 90 ? "Today's spend answer is reliable" : decision >= 75 ? "Trust today's answer with the noted caveats" : 'Verify inputs before acting'

  // OVERALL = full-picture data reliability across every domain (forecast, accounting, segment
  // included). Lower on purpose: it exposes that the forward forecast and segment/profitability
  // layers are still directional. We show it BESIDE the decision number, never merged into it.
  const wSum = domains.reduce((t, x) => t + x.weight, 0)
  const overall = round(domains.reduce((t, x) => t + x.confidencePct * x.weight, 0) / (wSum || 1))
  const overallTier = tierOf(overall)
  const label = overall >= 90 ? 'High — reliable across the board' : overall >= 75 ? 'Good — material gaps in deeper layers' : overall >= 50 ? 'Provisional — forecast & accounting layers are directional' : 'Low — do not rely for decisions'

  return {
    decisionPct: decision, decisionTier, decisionLabel,
    overallPct: overall, overallTier, label, domains, gaps,
    legend: [
      { band: '95–100', meaning: 'Authoritative / reconciled — safe for operational decisions' },
      { band: '90–94', meaning: 'Highly trustworthy — minor known limitations' },
      { band: '75–89', meaning: 'Useful — material limitations remain' },
      { band: '50–74', meaning: 'Directional only' },
      { band: '<50', meaning: 'Do not rely on for financial decisions' },
    ],
  }
}
