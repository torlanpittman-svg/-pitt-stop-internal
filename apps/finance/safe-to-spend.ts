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
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { getOperatingCash } from './db'
import { finObligations } from './schema'
import { getReservePolicy } from '@/apps/settings/db'

const iso = (d: Date) => d.toISOString().slice(0, 10)
function nextWeekday(from: Date, dow: number): Date { const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); const diff = (dow - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + diff); return d }
function nextDom(from: Date, dom: number): Date { const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), dom)); const t = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); if (d < t) d.setUTCMonth(d.getUTCMonth() + 1); return d }

export type Priority = 'critical' | 'contractual' | 'planned'
export interface DueEvent { label: string; category: string; cents: number; due: string; priority: Priority; committedOnIssue: boolean }

/** Expand confirmed obligations into concrete dated due-events within [now, now+horizon]. */
async function upcomingEvents(horizonDays: number): Promise<DueEvent[]> {
  const db = getDb()
  const now = new Date(); const end = new Date(Date.now() + horizonDays * 86400_000)
  const confirmed = await db.select().from(finObligations).where(eq(finObligations.status, 'confirmed'))
  const events: DueEvent[] = []
  for (const o of confirmed) {
    const cents = o.amountCents ?? o.avgAmountCents ?? 0
    if (!cents) continue
    const priority = (o.priority as Priority) ?? 'contractual'
    const base = { label: o.vendor, category: o.category ?? 'other', cents, priority, committedOnIssue: o.committedOnIssue }
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

export interface Deduction { label: string; cents: number; due: string; priority: Priority }
export interface SafeToSpend {
  availableCents: number | null; asOf: string | null; stale: boolean; horizonDays: number
  critical: Deduction[]; contractual: Deduction[]; planned: Deduction[]
  criticalCents: number; contractualCents: number; plannedCents: number; reservesCents: number
  coreSafeToSpendCents: number | null; afterPlannedCents: number | null
  trustworthy: boolean; disclosures: string[]
}

export async function computeSafeToSpend(horizonDays = 14): Promise<SafeToSpend> {
  const op = await getOperatingCash()
  const reserves = await getReservePolicy()
  const events = await upcomingEvents(horizonDays)
  const toDed = (e: DueEvent): Deduction => ({ label: e.label, cents: e.cents, due: e.due, priority: e.priority })
  const critical = events.filter((e) => e.priority === 'critical').map(toDed)
  const contractual = events.filter((e) => e.priority === 'contractual').map(toDed)
  const planned = events.filter((e) => e.priority === 'planned').map(toDed)
  const sum = (xs: Deduction[]) => xs.reduce((t, x) => t + x.cents, 0)
  const criticalCents = sum(critical), contractualCents = sum(contractual), plannedCents = sum(planned)

  const available = op?.availableCents ?? null
  const core = available == null ? null : available - criticalCents - contractualCents - reserves.totalCents
  const afterPlanned = core == null ? null : core - plannedCents

  const disclosures: string[] = []
  if (!reserves.configured) disclosures.push('Reserve policy is UNCONFIGURED ($0 assumed) — no payroll/tax/operating buffer is protected yet.')
  if (!critical.some((c) => /payroll/i.test(c.label))) disclosures.push('No employee payroll falls within the horizon window (check dates).')
  if (op?.stale) disclosures.push('Operating balance is stale (>24h) — run a sync for a current figure.')
  if (!op) disclosures.push('No verified operating account.')
  disclosures.push('Expected customer/dealer inflows are shown separately and are NOT counted as spendable until they actually land.')

  const trustworthy = Boolean(reserves.configured && op && !op.stale && critical.length > 0)
  return {
    availableCents: available, asOf: op?.asOf ?? null, stale: op?.stale ?? true, horizonDays,
    critical, contractual, planned, criticalCents, contractualCents, plannedCents, reservesCents: reserves.totalCents,
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
  const events = await upcomingEvents(horizonDays)

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
