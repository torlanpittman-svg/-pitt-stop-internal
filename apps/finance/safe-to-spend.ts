/**
 * CFO Phase 2 — Safe-to-Spend v1 (operating *2649) + near-term cash-low projection.
 *
 * Foundation = the bank's OWN available balance (already nets pending) — we never re-derive cash
 * from transactions, so cash movement is never double-counted. We then subtract forward-looking
 * committed obligations due within the horizon, grouped by PRIORITY:
 *   CRITICAL     employee payroll, payroll taxes, required debt
 *   CONTRACTUAL  rent, utilities
 *   PLANNED      owner distribution (deferrable)
 * CORE Safe-to-Spend deducts critical + contractual + reserves. A second line then deducts the
 * planned owner draw, so the CFO can say "payroll clears if the $1,000 draw is deferred."
 *
 * Timing: obligations flagged committed_on_issue (paper payroll checks) reduce economically-available
 * cash on their issue date (Friday) even before the bank clears them. Expected inflows are shown but
 * NOT counted as spendable. Read-only; no money movement.
 */
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { getOperatingCash } from './db'
import { finObligations, finExpectedInflows } from './schema'
import { getReservePolicy } from '@/apps/settings/db'

const iso = (d: Date) => d.toISOString().slice(0, 10)
function nextWeekday(from: Date, dow: number): Date { const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); const diff = (dow - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + diff); return d }
function nextDom(from: Date, dom: number): Date { const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), dom)); const t = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); if (d < t) d.setUTCMonth(d.getUTCMonth() + 1); return d }

export type Priority = 'critical' | 'contractual' | 'planned'
export interface DueEvent {
  label: string; category: string; cents: number; due: string; priority: Priority; committedOnIssue: boolean; accountId: string | null
  // Evidence for the bill calendar: variable bills show a range/estimate, not false precision.
  amountMinCents: number | null; amountMaxCents: number | null; variable: boolean
  needsConfirmation: boolean          // amount not yet authoritative (e.g. active IRS plan, amount unknown)
  confidence: string                  // manual | manual_verified | strongly_inferred | predicted | estimated | …
}

/** The operating (*2649) fin_account id — obligations paid from here reduce operating Safe-to-Spend.
 *  Obligations paid from *5600 (auto-sales) do NOT reduce operating cash. */
async function operatingAccountId(): Promise<string | null> {
  const op = await getOperatingCash(); return op?.finAccountId ?? null
}

/**
 * PROTECTED PAYROLL FLOOR — one normal week of employee payroll, derived DYNAMICALLY from the
 * confirmed weekly payroll obligations (Torlan + Tony + Darryl = $3,040.32 today). This is NOT a
 * bill and never appears on the obligation calendar; it is a liquidity floor held IN ADDITION to
 * the scheduled Friday payroll so that, after every known obligation, Pitt Stop can still run one
 * more payroll. Because it is a separate constant (not a re-listing of the dated payroll event),
 * it does not double-count the scheduled payroll. Owner-confirmed policy.
 */
export async function getPayrollFloorCents(): Promise<number> {
  const db = getDb()
  const rows = await db.select().from(finObligations).where(and(
    eq(finObligations.status, 'confirmed'),
    eq(finObligations.category, 'payroll'),
    eq(finObligations.frequency, 'weekly'),
  ))
  return rows.reduce((t, o) => t + (o.amountCents ?? o.avgAmountCents ?? 0), 0)
}

/** Expand confirmed obligations into concrete dated due-events within [now, now+horizon].
 *  When `accountId` is given, only obligations paid from that account are included. */
async function upcomingEvents(horizonDays: number, accountId?: string | null): Promise<DueEvent[]> {
  const db = getDb()
  const now = new Date(); const end = new Date(Date.now() + horizonDays * 86400_000)
  const confirmed = await db.select().from(finObligations).where(eq(finObligations.status, 'confirmed'))
  const events: DueEvent[] = []
  for (const o of confirmed) {
    if (accountId !== undefined && accountId !== null && o.paymentAccountId !== accountId) continue
    // needsConfirmation: an active obligation whose amount is not yet authoritative (amountCents
    // null but we still forecast a conservative predicted value from avgAmountCents).
    const needsConfirmation = o.amountCents == null && (o.avgAmountCents ?? 0) > 0
    const cents = o.amountCents ?? o.avgAmountCents ?? 0
    if (!cents) continue
    const priority = (o.priority as Priority) ?? 'contractual'
    const variable = o.amountMinCents != null && o.amountMaxCents != null && o.amountMinCents !== o.amountMaxCents
    const base = {
      label: o.vendor, category: o.category ?? 'other', cents, priority, committedOnIssue: o.committedOnIssue, accountId: o.paymentAccountId,
      amountMinCents: o.amountMinCents ?? null, amountMaxCents: o.amountMaxCents ?? null, variable, needsConfirmation, confidence: o.confidence,
    }
    if (o.frequency === 'weekly' && o.dayOfWeek != null) {
      for (let d = nextWeekday(now, o.dayOfWeek); d <= end; d.setUTCDate(d.getUTCDate() + 7)) events.push({ ...base, due: iso(d) })
    } else if (o.frequency === 'biweekly' && o.dayOfWeek != null) {
      for (let d = nextWeekday(now, o.dayOfWeek); d <= end; d.setUTCDate(d.getUTCDate() + 14)) events.push({ ...base, due: iso(d) })
    } else if (o.frequency === 'monthly') {
      const dom = o.dayOfMonth ?? (o.nextDue ? new Date(o.nextDue + 'T00:00:00Z').getUTCDate() : 1)
      for (let d = nextDom(now, dom); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) events.push({ ...base, due: iso(d) })
    } else if (o.nextDue) {
      const d = new Date(o.nextDue + 'T00:00:00Z'); if (d >= now && d <= end) events.push({ ...base, due: iso(d) })
    }
  }
  return events.sort((a, b) => a.due.localeCompare(b.due))
}

// ── Upcoming-obligations CALENDAR (per account, 7/14/30-day) ──
export interface CalendarEvent {
  due: string; label: string; category: string; cents: number; priority: Priority; account: string
  amountMinCents: number | null; amountMaxCents: number | null; variable: boolean; needsConfirmation: boolean; confidence: string
}
export interface ObligationCalendar {
  events: CalendarEvent[]
  window7Cents: number; window14Cents: number; window30Cents: number
  byAccount: { account: string; window7: number; window14: number; window30: number }[]
}
export async function getObligationCalendar(days = 30): Promise<ObligationCalendar> {
  const db = getDb()
  const { finAccounts } = await import('./schema')
  const accts = await db.select().from(finAccounts)
  const nameById = new Map(accts.map((a) => [a.id, a.name]))
  const all = await upcomingEvents(days) // all accounts
  const now = Date.now()
  const within = (e: CalendarEvent, d: number) => new Date(e.due + 'T00:00:00Z').getTime() <= now + d * 86400_000
  const events: CalendarEvent[] = all.map((e) => ({ due: e.due, label: e.label, category: e.category, cents: e.cents, priority: e.priority, account: e.accountId ? (nameById.get(e.accountId) ?? '—') : 'unassigned', amountMinCents: e.amountMinCents, amountMaxCents: e.amountMaxCents, variable: e.variable, needsConfirmation: e.needsConfirmation, confidence: e.confidence }))
  const sum = (xs: CalendarEvent[]) => xs.reduce((t, e) => t + e.cents, 0)
  const acctNames = [...new Set(events.map((e) => e.account))]
  return {
    events,
    window7Cents: sum(events.filter((e) => within(e, 7))),
    window14Cents: sum(events.filter((e) => within(e, 14))),
    window30Cents: sum(events.filter((e) => within(e, 30))),
    byAccount: acctNames.map((account) => {
      const es = events.filter((e) => e.account === account)
      return { account, window7: sum(es.filter((e) => within(e, 7))), window14: sum(es.filter((e) => within(e, 14))), window30: sum(es.filter((e) => within(e, 30))) }
    }),
  }
}

export interface Deduction { label: string; cents: number; due: string; priority: Priority }
export interface SafeToSpend {
  availableCents: number | null; asOf: string | null; stale: boolean; horizonDays: number
  critical: Deduction[]; contractual: Deduction[]; planned: Deduction[]
  criticalCents: number; contractualCents: number; plannedCents: number; reservesCents: number
  payrollFloorCents: number      // protected one-week payroll floor (separate from reserves; NOT a bill)
  coreSafeToSpendCents: number | null; afterPlannedCents: number | null
  trustworthy: boolean; disclosures: string[]
}

/**
 * PURE core Safe-to-Spend arithmetic (unit-tested without a DB). CORE = verified cash − critical −
 * contractual − reserves − protected payroll floor. The scheduled Friday payroll is already inside
 * `criticalCents`; `payrollFloorCents` is a SEPARATE one-week cushion, so the same payroll is only
 * ever subtracted once as an obligation and the floor is an independent liquidity guarantee.
 */
export function computeCoreSafeToSpendCents(input: {
  availableCents: number | null; criticalCents: number; contractualCents: number; reservesCents: number; payrollFloorCents: number
}): number | null {
  if (input.availableCents == null) return null
  return input.availableCents - input.criticalCents - input.contractualCents - input.reservesCents - input.payrollFloorCents
}

export async function computeSafeToSpend(horizonDays = 14): Promise<SafeToSpend> {
  const op = await getOperatingCash()
  const reserves = await getReservePolicy()
  const payrollFloorCents = await getPayrollFloorCents()
  const events = await upcomingEvents(horizonDays, await operatingAccountId())
  const toDed = (e: DueEvent): Deduction => ({ label: e.label, cents: e.cents, due: e.due, priority: e.priority })
  const critical = events.filter((e) => e.priority === 'critical').map(toDed)
  const contractual = events.filter((e) => e.priority === 'contractual').map(toDed)
  const planned = events.filter((e) => e.priority === 'planned').map(toDed)
  const sum = (xs: Deduction[]) => xs.reduce((t, x) => t + x.cents, 0)
  const criticalCents = sum(critical), contractualCents = sum(contractual), plannedCents = sum(planned)

  const available = op?.availableCents ?? null
  // CORE Safe-to-Spend = verified cash − critical − contractual − reserves − PROTECTED PAYROLL FLOOR.
  // The payroll floor is a SEPARATE one-week-payroll cushion held on top of the scheduled payroll
  // obligations (which are already inside `critical`); it is a constant, not a re-listing of the
  // dated payroll event, so the same payroll is never subtracted twice.
  const core = computeCoreSafeToSpendCents({ availableCents: available, criticalCents, contractualCents, reservesCents: reserves.totalCents, payrollFloorCents })
  const afterPlanned = core == null ? null : core - plannedCents

  const disclosures: string[] = []
  disclosures.push('This is STRICT Safe-to-Spend: verified bank cash minus confirmed obligations only. Expected customer/dealer inflows are modeled separately below and are NOT counted here until they land.')
  if (payrollFloorCents > 0) disclosures.push(`A one-week payroll floor of $${(payrollFloorCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} is protected: Safe-to-Spend is only positive when spending it still leaves enough to run one normal payroll after known bills. The floor is a liquidity cushion, NOT a bill on the calendar, and does not double-count the scheduled Friday payroll.`)
  if (!reserves.configured) disclosures.push('Long-term reserve TARGET ($50k) is separate and unfunded — that is a savings goal, not the protected payroll floor.')
  if ((core ?? 0) < 0) disclosures.push('A negative strict number means committed obligations + payroll floor exceed CURRENT verified cash — NOT that payroll cannot be met. See the expected-inflow forecast for whether incoming cash covers it.')
  if (op?.stale) disclosures.push('Operating balance is stale (>24h) — run a sync for a current figure.')
  if (!op) disclosures.push('No verified operating account.')

  const trustworthy = Boolean(op && !op.stale && payrollFloorCents > 0 && critical.length > 0)
  return {
    availableCents: available, asOf: op?.asOf ?? null, stale: op?.stale ?? true, horizonDays,
    critical, contractual, planned, criticalCents, contractualCents, plannedCents, reservesCents: reserves.totalCents,
    payrollFloorCents,
    coreSafeToSpendCents: core, afterPlannedCents: afterPlanned, trustworthy, disclosures,
  }
}

export interface ProjectionPoint { date: string; label: string; category: string; priority: Priority; deltaCents: number; balanceCents: number }
export interface CashProjection {
  startCents: number | null; horizonDays: number; points: ProjectionPoint[]
  lowCents: number | null; lowDate: string | null; overdraftRisk: boolean; overdraftDate: string | null; overdraftCause: string | null
  payrollCovered: boolean | null; payrollDate: string | null; payrollBalanceAfter: number | null
}

/** Conservative near-term projection from available, applying ONLY dated committed obligations
 *  (no assumed new deposits). Answers "will we overdraft / can we make payroll before the low point?" */
export async function projectCashLow(horizonDays = 14): Promise<CashProjection> {
  const op = await getOperatingCash()
  const start = op?.availableCents ?? null
  const events = await upcomingEvents(horizonDays, await operatingAccountId())

  const points: ProjectionPoint[] = []
  let bal = start ?? 0; let low = start; let lowDate = start != null ? iso(new Date()) : null
  let overdraftDate: string | null = null, overdraftCause: string | null = null
  let payrollCovered: boolean | null = null, payrollDate: string | null = null, payrollBalanceAfter: number | null = null

  for (const e of events) {
    bal -= e.cents
    points.push({ date: e.due, label: e.label, category: e.category, priority: e.priority, deltaCents: -e.cents, balanceCents: bal })
    if (start != null && (low == null || bal < low)) { low = bal; lowDate = e.due }
    if (start != null && bal < 0 && !overdraftDate) { overdraftDate = e.due; overdraftCause = e.label }
    // First employee-payroll event (category 'payroll', not 'payroll_tax'): did cash cover it?
    if (e.category === 'payroll' && payrollCovered == null) {
      payrollDate = e.due; payrollBalanceAfter = bal; payrollCovered = bal >= 0
    }
  }
  return {
    startCents: start, horizonDays, points,
    lowCents: low, lowDate, overdraftRisk: low != null && low < 0, overdraftDate, overdraftCause,
    payrollCovered, payrollDate, payrollBalanceAfter,
  }
}

// ── Forecast layer: "are we EXPECTED to meet upcoming obligations?" (adds inflows by confidence) ──
export type Scenario = 'verified_only' | 'high_confidence' | 'all_probable'
export interface ScenarioResult { scenario: Scenario; lowCents: number | null; lowDate: string | null; overdraftRisk: boolean; firstPayrollCovered: boolean | null; firstPayrollDate: string | null; firstPayrollBalance: number | null; endingCents: number | null }
export interface Forecast {
  startCents: number | null; horizonDays: number
  scenarios: ScenarioResult[]
  timeline: { date: string; label: string; kind: 'out' | 'in'; confidence?: string; deltaCents: number; balHigh: number }[]
  criticalBeforeInflowCents: number; expectedHighCents: number; expectedProbableCents: number
}

/** Merge dated obligations (out) + expected inflows (in) and run three inflow scenarios. Inflows are
 *  filtered by confidence per scenario; strict Safe-to-Spend is unaffected. */
export async function forecastWithInflows(horizonDays = 21): Promise<Forecast> {
  const db = getDb()
  const op = await getOperatingCash()
  const start = op?.availableCents ?? null
  const now = new Date(); const endD = iso(new Date(Date.now() + horizonDays * 86400_000))
  const outs = (await upcomingEvents(horizonDays, await operatingAccountId())).map((e) => ({ date: e.due, label: e.label, kind: 'out' as const, cents: -e.cents, confidence: undefined as string | undefined, priority: e.priority }))
  const inflows = await db.select().from(finExpectedInflows)
    .where(and(sql`${finExpectedInflows.status} <> 'dismissed'`, sql`${finExpectedInflows.expectedDate} <= ${endD}`))
  const ins = inflows.map((r) => ({ date: r.expectedDate, label: r.label, kind: 'in' as const, cents: r.amountCents, confidence: r.confidence as string, priority: undefined }))

  const confAllowed: Record<Scenario, Set<string>> = {
    verified_only: new Set(),
    high_confidence: new Set(['high']),
    all_probable: new Set(['high', 'probable']),
  }
  const runScenario = (scn: Scenario): ScenarioResult => {
    const events = [...outs, ...ins.filter((i) => confAllowed[scn].has(i.confidence))].sort((a, b) => a.date.localeCompare(b.date))
    let bal = start ?? 0, low = start, lowDate = start != null ? iso(now) : null
    let fpCov: boolean | null = null, fpDate: string | null = null, fpBal: number | null = null
    for (const e of events) {
      bal += e.cents
      if (start != null && (low == null || bal < low)) { low = bal; lowDate = e.date }
      if (e.kind === 'out' && (e as any).priority && fpCov == null && /Payroll —/i.test(e.label)) { fpCov = bal >= 0; fpDate = e.date; fpBal = bal }
    }
    return { scenario: scn, lowCents: low, lowDate, overdraftRisk: low != null && low < 0, firstPayrollCovered: fpCov, firstPayrollDate: fpDate, firstPayrollBalance: fpBal, endingCents: bal }
  }
  // Timeline uses the high-confidence running balance for display.
  const merged = [...outs, ...ins.filter((i) => confAllowed.high_confidence.has(i.confidence))].sort((a, b) => a.date.localeCompare(b.date))
  let bh = start ?? 0
  const timeline = merged.map((e) => { bh += e.cents; return { date: e.date, label: e.label, kind: e.kind, confidence: e.confidence, deltaCents: e.cents, balHigh: bh } })

  return {
    startCents: start, horizonDays,
    scenarios: [runScenario('verified_only'), runScenario('high_confidence'), runScenario('all_probable')],
    timeline,
    criticalBeforeInflowCents: outs.filter((o) => o.priority === 'critical').reduce((t, o) => t - o.cents, 0),
    expectedHighCents: ins.filter((i) => i.confidence === 'high').reduce((t, i) => t + i.cents, 0),
    expectedProbableCents: ins.filter((i) => i.confidence === 'probable').reduce((t, i) => t + i.cents, 0),
  }
}
