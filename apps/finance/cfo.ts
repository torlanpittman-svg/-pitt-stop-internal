/**
 * CFO decision layer — turns the financial MODEL (Safe-to-Spend, forecast, obligations, debts,
 * reserves, inflows) into CONCLUSIONS a business owner can act on: a plain-English headline + health
 * status, a next-danger read, ranked recommendations, a debt summary, a reserve tracker, a money
 * in/out roll-up, a 30-day cash-runway series, and a confidence score. Pure read/aggregation over the
 * existing engine — no new money math invented, no writes, no money movement. When an input is missing
 * we return an honest incomplete state rather than a fabricated number.
 */
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finObligations } from './schema'
import { getOperatingCash, getDebts, getDataGaps, type DataGap } from './db'
import { getReservePolicy } from '@/apps/settings/db'
import { computeSafeToSpend, projectCashLow, forecastWithInflows, getObligationCalendar, type SafeToSpend, type Forecast } from './safe-to-spend'
import { getExpectedInflows } from './expected-inflows'

const c = (n: number | null | undefined) => (n == null ? '—' : `$${Math.round(n / 100).toLocaleString('en-US')}`)
const iso = (d: Date) => d.toISOString().slice(0, 10)

export type Health = 'HEALTHY' | 'WATCH' | 'TIGHT' | 'CRITICAL'

// ── A. CFO headline ──────────────────────────────────────────────────────────
export interface CfoHeadline {
  operatingAvailableCents: number | null
  strictSafeToSpendCents: number | null
  forecastSafeToSpendCents: number | null
  next7InCents: number; next7OutCents: number; next7ProjectedEndingCents: number | null
  status: Health
  statement: string
}

/** The headline the owner reads first: where we stand + are we okay, in plain English. */
export async function getCfoHeadline(): Promise<CfoHeadline> {
  const [op, s2s, forecast, cal, inflows, runway] = await Promise.all([
    getOperatingCash(), computeSafeToSpend(30), forecastWithInflows(30), getObligationCalendar(30), getExpectedInflows(7), getCashRunway(30),
  ])
  const avail = op?.availableCents ?? null
  const strict = s2s.coreSafeToSpendCents
  // Forecast Safe-to-Spend = strict + high-confidence expected inflows over the horizon.
  const forecastS2s = strict == null ? null : strict + forecast.expectedHighCents
  const next7Out = cal.window7Cents
  const next7In = inflows.filter((i) => i.confidence === 'high').reduce((t, i) => t + i.amountCents, 0)
  const next7Ending = avail == null ? null : avail + next7In - next7Out

  // Health from strict Safe-to-Spend + the realistic (end-of-day, high-confidence) runway low.
  const verifiedScn = forecast.scenarios.find((s) => s.scenario === 'verified_only')
  const highScn = forecast.scenarios.find((s) => s.scenario === 'high_confidence')
  let status: Health
  if (runway.overdraft) status = 'CRITICAL'                       // realistic path dips below zero
  else if ((strict ?? 0) < 0 && (runway.lowCents ?? 0) < 300000) status = 'TIGHT'
  else if ((strict ?? 0) < 0) status = 'WATCH'
  else status = 'HEALTHY'

  const stmt = buildStatement({ status, avail, strict, forecastS2s, next7In, next7Out, cal, s2s, highCovered: highScn?.firstPayrollCovered, verifiedCovered: verifiedScn?.firstPayrollCovered, payrollDate: verifiedScn?.firstPayrollDate })
  return { operatingAvailableCents: avail, strictSafeToSpendCents: strict, forecastSafeToSpendCents: forecastS2s, next7InCents: next7In, next7OutCents: next7Out, next7ProjectedEndingCents: next7Ending, status, statement: stmt }
}

function buildStatement(a: { status: Health; avail: number | null; strict: number | null; forecastS2s: number | null; next7In: number; next7Out: number; cal: any; s2s: SafeToSpend; highCovered?: boolean | null; verifiedCovered?: boolean | null; payrollDate?: string | null }): string {
  const avail = a.avail ?? 0
  const criticalNext7 = a.cal.events.filter((e: any) => new Date(e.due + 'T00:00:00Z').getTime() <= Date.now() + 7 * 86400_000 && e.priority === 'critical').reduce((t: number, e: any) => t + e.cents, 0)
  if (a.avail == null) return 'No verified operating balance is connected yet, so Safe-to-Spend cannot be computed. Verify the *2649 bank mapping to turn this on.'
  if (a.status === 'HEALTHY') return `Pitt Stop is in good shape: after all committed obligations for the next 30 days, about ${c(a.strict)} is genuinely safe to spend from operating cash.`
  if (a.status === 'WATCH') return `You have ${c(avail)} in operating cash, but only about ${c(Math.max(0, a.strict ?? 0))} is truly free — payroll, rent and debt in the next 30 days claim most of it. Normal deposits should keep you positive, but there is little slack.`
  // TIGHT / CRITICAL
  const inPart = a.next7In > 0 ? ` Expected high-confidence deposits of about ${c(a.next7In)} in the next 7 days should help cover it if they arrive on schedule.` : ''
  const payrollPart = a.verifiedCovered === false && a.highCovered ? ` Current cash alone does not cover the ${a.payrollDate} payroll, but normal dealer/card receipts are expected to before it hits.` : a.highCovered === false ? ` Even with expected deposits, the ${a.payrollDate} payroll looks at risk — hold cash and confirm incoming payments.` : ''
  return `Cash is tight: ${c(avail)} available, but about ${c(criticalNext7)} of critical obligations (payroll, taxes, debt) are due in the next 7 days, so strict Safe-to-Spend is ${c(a.strict)}.${payrollPart}${inPart}`
}

// ── B/E. Next cash-flow danger ───────────────────────────────────────────────
export interface NextDanger {
  date: string | null
  lowCents: number | null
  overdraft: boolean
  items: { label: string; cents: number; priority: string }[]
  expectedBeforeCents: number
  risk: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL'
  explanation: string
}

export async function getNextDanger(): Promise<NextDanger> {
  // Use the REALISTIC (high-confidence: obligations + expected receipts) path so the danger read
  // matches the runway chart. The verified-only stress is reported as context in the explanation.
  const [runway, projStrict, cal, inflows] = await Promise.all([getCashRunway(30), projectCashLow(30), getObligationCalendar(30), getExpectedInflows(30)])
  const lowDate = runway.lowDate
  if (!lowDate || runway.startCents == null) return { date: null, lowCents: null, overdraft: false, items: [], expectedBeforeCents: 0, risk: 'LOW', explanation: 'No verified cash to project from.' }
  const items = cal.events.filter((e) => e.due === lowDate).map((e) => ({ label: e.label, cents: e.cents, priority: e.priority }))
  const highBefore = inflows.filter((i) => i.confidence === 'high' && i.expectedDate <= lowDate).reduce((t, i) => t + i.amountCents, 0)
  let risk: NextDanger['risk']
  if (runway.overdraft) risk = 'HIGH'                              // realistic path dips below zero
  else if ((runway.lowCents ?? 0) < 300000) risk = 'MODERATE'      // thin cushion (<$3k)
  else risk = 'LOW'
  if (risk === 'HIGH' && (projStrict.lowCents ?? 0) < -2000000) risk = 'CRITICAL' // deep verified-only shortfall
  const stack = items.map((i) => `${i.label} ${c(i.cents)}`).join(' + ')
  const explanation = runway.overdraft
    ? `On ${lowDate}, ${stack || 'stacked obligations'} pull projected cash to ${c(runway.lowCents)} even after expected deposits of ${c(highBefore)} — a real overdraft risk. From verified cash alone (no incoming deposits) the shortfall would be ${c(projStrict.lowCents)}, so this week depends on receipts landing on time. Hold discretionary cash.`
    : `The tightest point in the next 30 days is ${lowDate} at about ${c(runway.lowCents)}${stack ? `, when ${stack} land` : ''}. Expected deposits keep it positive, but a one-week delay in dealer/card receipts would create pressure.`
  return { date: lowDate, lowCents: runway.lowCents, overdraft: runway.overdraft, items, expectedBeforeCents: highBefore, risk, explanation }
}

// ── F. Recommended actions (ranked, explainable) ─────────────────────────────
export interface Recommendation { rank: number; title: string; why: string; tag: 'liquidity' | 'debt' | 'reserve' | 'caution' }

export async function getRecommendations(): Promise<Recommendation[]> {
  const [s2s, proj, debtSummary, reserve, autoGap] = await Promise.all([computeSafeToSpend(30), projectCashLow(30), getDebtSummary(), getReserveStatus(), getDataGaps()])
  const recs: Recommendation[] = []
  const tight = (s2s.coreSafeToSpendCents ?? 0) < 0 || proj.overdraftRisk

  if (tight) {
    recs.push({ rank: 0, title: 'Hold cash — obligations stack ahead', why: `Payroll, taxes, rent and debt over the next 30 days exceed current verified cash by ${c(Math.abs(s2s.coreSafeToSpendCents ?? 0))}. Avoid discretionary spend until expected deposits land.`, tag: 'liquidity' })
    // Deferring the planned owner draw is the cheapest lever.
    if (s2s.plannedCents > 0) recs.push({ rank: 0, title: 'Defer the owner distribution', why: `Deferring the ${c(s2s.plannedCents)} weekly owner draw keeps projected operating cash from falling further and is fully reversible.`, tag: 'liquidity' })
  }
  // Highest-APR debt payoff — only once liquidity is safe.
  if (debtSummary.mostExpensive) {
    const d = debtSummary.mostExpensive
    recs.push({ rank: tight ? 3 : 1, title: `${tight ? 'Once liquidity is safe, target' : 'Target'} ${d.name}`, why: `${d.aprPct != null ? d.aprPct.toFixed(1) + '% APR' : 'highest-cost debt'} on ${c(d.balanceCents)} — the most expensive dollar of debt you carry. Paying it early saves the most interest, but only after minimum operating liquidity is protected.`, tag: 'debt' })
  }
  // Reserve building.
  recs.push({ rank: 4, title: `Build the operating reserve toward ${c(reserve.targetCents)}`, why: reserve.trueReserveCents <= 0 ? `There is no dedicated reserve yet — operating cash barely covers obligations. The first goal is a payroll-sized buffer, then ${c(reserve.targetCents)}.` : `Currently ${c(reserve.trueReserveCents)} (${reserve.pct}%) toward ${c(reserve.targetCents)}. Route a fixed weekly amount of free cash here once Safe-to-Spend is reliably positive.`, tag: 'reserve' })
  // Caution: auto-sales cash is not free.
  if (autoGap.some((g) => g.key === 'autosales_encumbrance')) recs.push({ rank: 5, title: 'Do not backstop operating with auto-sales cash', why: 'Unencumbered *5600 cash is still Unknown — floor-plan curtailments on sold vehicles are not itemized. Treating that balance as free risks a floor-plan shortfall.', tag: 'caution' })

  return recs.sort((a, b) => a.rank - b.rank).map((r, i) => ({ ...r, rank: i + 1 }))
}

// ── G. Reserve tracker ───────────────────────────────────────────────────────
export interface ReserveStatus {
  rawCashCents: number | null      // operating available (all of it)
  obligations30Cents: number       // committed out over 30d (what cash is spoken for)
  trueReserveCents: number         // free cash above near-term obligations (>= 0)
  targetCents: number; nextTargetCents: number; pct: number
  configured: boolean
  note: string
}

export async function getReserveStatus(): Promise<ReserveStatus> {
  const [op, cal, reserves] = await Promise.all([getOperatingCash(), getObligationCalendar(30), getReservePolicy()])
  const raw = op?.availableCents ?? null
  const oblig30 = cal.byAccount.find((a) => /2649|Detail/.test(a.account))?.window30 ?? cal.window30Cents
  const target = 5_000_000, next = 10_000_000 // $50k first milestone, $100k long-term
  const trueReserve = raw == null ? 0 : Math.max(0, raw - oblig30)
  const pct = Math.round((trueReserve / target) * 100)
  return {
    rawCashCents: raw, obligations30Cents: oblig30, trueReserveCents: trueReserve, targetCents: target, nextTargetCents: next, pct,
    configured: reserves.configured,
    note: trueReserve <= 0
      ? 'No dedicated reserve yet — operating cash is fully claimed by the next 30 days of obligations. Reserve building starts once Safe-to-Spend is reliably positive.'
      : 'True reserve = operating cash above the next 30 days of committed obligations (payroll/rent/taxes are NOT reserve).',
  }
}

// ── I. Debt command center ───────────────────────────────────────────────────
export interface DebtLine { name: string; kind: string; balanceCents: number; aprPct: number | null; paymentCents: number | null; account: string | null; verified: boolean; highInterest: boolean }
export interface DebtSummary {
  totalCents: number; highInterestCents: number; monthlyServiceCents: number; weightedAprPct: number | null
  mostExpensive: DebtLine | null
  lines: DebtLine[]
}

export async function getDebtSummary(): Promise<DebtSummary> {
  const debts = await getDebts()
  const lines: DebtLine[] = debts.filter((d) => (d.principalCents ?? 0) > 0).map((d) => {
    const apr = d.aprBps != null ? d.aprBps / 100 : null
    // monthly-equivalent service
    const pf = d.paymentFrequency
    const monthly = d.paymentCents == null ? null : pf === 'weekly' ? Math.round(d.paymentCents * 52 / 12) : pf === 'biweekly' ? Math.round(d.paymentCents * 26 / 12) : d.paymentCents
    return { name: d.name, kind: d.kind, balanceCents: d.principalCents ?? 0, aprPct: apr, paymentCents: monthly, account: null, verified: d.verified, highInterest: (apr ?? 0) >= 20 }
  })
  const total = lines.reduce((t, l) => t + l.balanceCents, 0)
  const highInterest = lines.filter((l) => l.highInterest).reduce((t, l) => t + l.balanceCents, 0)
  const monthlyService = lines.reduce((t, l) => t + (l.paymentCents ?? 0), 0)
  const withApr = lines.filter((l) => l.aprPct != null)
  const weightedApr = withApr.length && withApr.reduce((t, l) => t + l.balanceCents, 0) > 0
    ? withApr.reduce((t, l) => t + l.balanceCents * (l.aprPct as number), 0) / withApr.reduce((t, l) => t + l.balanceCents, 0)
    : null
  const mostExpensive = withApr.slice().sort((a, b) => (b.aprPct as number) - (a.aprPct as number))[0] ?? null
  return { totalCents: total, highInterestCents: highInterest, monthlyServiceCents: monthlyService, weightedAprPct: weightedApr, mostExpensive, lines: lines.sort((a, b) => (b.aprPct ?? 0) - (a.aprPct ?? 0)) }
}

// ── C. 30-day cash runway (daily series for the chart) ───────────────────────
export interface RunwayPoint { date: string; balanceCents: number; events: { label: string; cents: number; kind: 'in' | 'out'; priority?: string }[] }
export interface CashRunway {
  startCents: number | null; points: RunwayPoint[]
  lowCents: number | null; lowDate: string | null; overdraft: boolean
  minCents: number; maxCents: number
}

/** Daily projected *2649 balance for `days` using verified cash + committed obligations (out) +
 *  high-confidence expected inflows (in). Built DIRECTLY from the forecast timeline's own running
 *  balance (balHigh) so the chart is guaranteed to match the high-confidence scenario exactly. */
export async function getCashRunway(days = 30): Promise<CashRunway> {
  const [op, forecast] = await Promise.all([getOperatingCash(), forecastWithInflows(days)])
  const start = op?.availableCents ?? null
  if (start == null) return { startCents: null, points: [], lowCents: null, lowDate: null, overdraft: false, minCents: 0, maxCents: 0 }
  const today = new Date()
  // End-of-day balance (from the timeline's own balHigh) + that day's events, keyed by date. Using the
  // END-OF-DAY balance (not a per-event low) nets same-day deposits against same-day obligations, so a
  // payroll Friday that also receives the dealer deposit isn't shown as an artificial intra-day dip.
  const endOfDay = new Map<string, number>()
  const evsByDay = new Map<string, { label: string; cents: number; kind: 'in' | 'out' }[]>()
  for (const e of forecast.timeline) {
    endOfDay.set(e.date, e.balHigh)                     // last event of a day wins → end-of-day balance
    const arr = evsByDay.get(e.date) ?? []; arr.push({ label: e.label, cents: e.deltaCents, kind: e.kind }); evsByDay.set(e.date, arr)
  }
  const points: RunwayPoint[] = []
  let carry = start, low = start, lowDate = iso(today), min = start, max = start
  for (let i = 0; i <= days; i++) {
    const d = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i)))
    if (endOfDay.has(d)) carry = endOfDay.get(d) as number   // step to the day's ending balance; else carry forward
    if (carry < low) { low = carry; lowDate = d }
    min = Math.min(min, carry); max = Math.max(max, carry)
    points.push({ date: d, balanceCents: carry, events: (evsByDay.get(d) ?? []).map((e) => ({ label: e.label, cents: Math.abs(e.cents), kind: e.kind, priority: undefined })) })
  }
  return { startCents: start, points, lowCents: low, lowDate, overdraft: low < 0, minCents: min, maxCents: max }
}

// ── D. Money in / money out roll-up ──────────────────────────────────────────
export interface MoneyFlow {
  in7Cents: number; in30Cents: number; out7Cents: number; out30Cents: number
  inByCat: { label: string; cents: number; confidence: string }[]
  outByCat: { category: string; cents: number; priority: string }[]
}

export async function getMoneyFlow(): Promise<MoneyFlow> {
  const [cal, inflows30] = await Promise.all([getObligationCalendar(30), getExpectedInflows(30)])
  const now = Date.now()
  const within = (dateStr: string, d: number) => new Date(dateStr + 'T00:00:00Z').getTime() <= now + d * 86400_000
  const in7 = inflows30.filter((i) => within(i.expectedDate, 7)).reduce((t, i) => t + i.amountCents, 0)
  const in30 = inflows30.reduce((t, i) => t + i.amountCents, 0)
  // Out — operating (*2649) only, grouped by category.
  const opEvents = cal.events.filter((e) => /2649|Detail/.test(e.account))
  const out7 = opEvents.filter((e) => within(e.due, 7)).reduce((t, e) => t + e.cents, 0)
  const out30 = opEvents.reduce((t, e) => t + e.cents, 0)
  const catMap = new Map<string, { cents: number; priority: string }>()
  for (const e of opEvents.filter((e) => within(e.due, 30))) {
    const cur = catMap.get(e.category) ?? { cents: 0, priority: e.priority }
    cur.cents += e.cents
    catMap.set(e.category, cur)
  }
  const inMap = new Map<string, { cents: number; confidence: string }>()
  for (const i of inflows30) {
    const key = i.label.replace(/\s*—.*$/, '').replace(/\d+/g, '').trim() || i.label
    const cur = inMap.get(key) ?? { cents: 0, confidence: i.confidence }
    cur.cents += i.amountCents
    inMap.set(key, cur)
  }
  return {
    in7Cents: in7, in30Cents: in30, out7Cents: out7, out30Cents: out30,
    inByCat: [...inMap.entries()].map(([label, v]) => ({ label, cents: v.cents, confidence: v.confidence })).sort((a, b) => b.cents - a.cents),
    outByCat: [...catMap.entries()].map(([category, v]) => ({ category, cents: v.cents, priority: v.priority })).sort((a, b) => b.cents - a.cents),
  }
}

// ── L. CFO confidence + gaps ─────────────────────────────────────────────────
export interface CfoConfidence { pct: number; label: string; gaps: DataGap[] }

export async function getCfoConfidence(): Promise<CfoConfidence> {
  const gaps = await getDataGaps()
  // Weight: high gap -12, medium -6, low -2 from 100. Floor 40.
  let score = 100
  for (const g of gaps) score -= g.severity === 'high' ? 12 : g.severity === 'medium' ? 6 : 2
  score = Math.max(40, Math.min(100, score))
  const label = score >= 85 ? 'High confidence' : score >= 70 ? 'Good — some gaps' : 'Provisional — key gaps open'
  return { pct: score, label, gaps }
}

// ── H. Needs-verification obligations (paused, e.g. IRS back-tax) ─────────────
export interface NeedsVerification { vendor: string; category: string | null; amountCents: number | null; frequency: string | null; notes: string | null }
export async function getNeedsVerification(): Promise<NeedsVerification[]> {
  const rows = await getDb().select().from(finObligations).where(eq(finObligations.status, 'paused'))
  return rows.map((o) => ({ vendor: o.vendor, category: o.category, amountCents: o.amountCents ?? o.avgAmountCents, frequency: o.frequency, notes: o.notes }))
}
