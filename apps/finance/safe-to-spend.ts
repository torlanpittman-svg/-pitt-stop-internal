/**
 * CFO Phase 2 — Safe-to-Spend v1 (operating *2649) + near-term cash-low projection.
 *
 * Foundation = the bank's OWN available balance (already nets pending), so we never re-derive cash
 * from transactions (no double counting). We then subtract only forward-looking committed outflows
 * (confirmed critical obligations due within the horizon) and reserves. Expected customer deposits
 * are shown but NOT counted as spendable. If reserves are unconfigured or payroll unverified, the
 * result is explicitly flagged NOT fully trustworthy. Read-only; no money movement.
 */
import { and, eq, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { getOperatingCash } from './db'
import { finObligations } from './schema'
import { getReservePolicy } from '@/apps/settings/db'

const iso = (d: Date) => d.toISOString().slice(0, 10)
/** Next occurrence of a weekday (0=Sun..6=Sat) on/after `from`. */
function nextWeekday(from: Date, dow: number): Date { const d = new Date(from); const diff = (dow - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + diff); return d }
/** Next day-of-month `dom` on/after `from`. */
function nextDom(from: Date, dom: number): Date { const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), dom)); if (d < from) d.setUTCMonth(d.getUTCMonth() + 1); return d }

export interface Deduction { label: string; cents: number; due?: string; confidence: 'confirmed' | 'estimated' | 'reserve'; note?: string }
export interface SafeToSpend {
  availableCents: number | null; asOf: string | null; stale: boolean
  deductions: Deduction[]; reservesCents: number; safeToSpendCents: number | null
  trustworthy: boolean; disclosures: string[]
}

export async function computeSafeToSpend(horizonDays = 14): Promise<SafeToSpend> {
  const db = getDb()
  const op = await getOperatingCash()
  const reserves = await getReservePolicy()
  const now = new Date(); const horizon = new Date(now.getTime() + horizonDays * 86400_000)
  const disclosures: string[] = []
  const deductions: Deduction[] = []

  // Confirmed critical obligations due within the horizon (payroll/rent/debt the owner confirmed).
  const confirmed = await db.select().from(finObligations).where(and(eq(finObligations.status, 'confirmed'), ne(finObligations.critical, false)))
  for (const o of confirmed) {
    let due: Date | null = o.nextDue ? new Date(o.nextDue + 'T00:00:00Z') : null
    if (!due && o.category === 'payroll' && o.dayOfWeek != null) due = nextWeekday(now, o.dayOfWeek)
    if (!due && o.category === 'rent') due = nextDom(now, 15)
    if (due && due <= horizon) deductions.push({ label: o.vendor, cents: o.amountCents ?? o.avgAmountCents ?? 0, due: iso(due), confidence: 'confirmed', note: o.category ?? undefined })
  }

  // Reserves.
  if (reserves.totalCents > 0) deductions.push({ label: 'Reserves (payroll/tax/buffer)', cents: reserves.totalCents, confidence: 'reserve' })

  // Disclosures — what makes S2S not yet fully trustworthy.
  if (!reserves.configured) disclosures.push('Reserve policy is UNCONFIGURED ($0 assumed) — no payroll/tax/operating buffer is protected yet.')
  const anyPayrollConfirmed = confirmed.some((o) => o.category === 'payroll')
  if (!anyPayrollConfirmed) disclosures.push('Weekly payroll is not yet confirmed — the single biggest recurring outflow is not deducted.')
  if (op?.stale) disclosures.push('Operating balance is stale (>24h) — run a sync.')
  if (!op) disclosures.push('No verified operating account.')

  const available = op?.availableCents ?? null
  const totalDeductions = deductions.reduce((t, d) => t + d.cents, 0)
  const safe = available == null ? null : available - totalDeductions
  const trustworthy = Boolean(reserves.configured && anyPayrollConfirmed && op && !op.stale)

  return { availableCents: available, asOf: op?.asOf ?? null, stale: op?.stale ?? true, deductions, reservesCents: reserves.totalCents, safeToSpendCents: safe, trustworthy, disclosures }
}

export interface ProjectionPoint { date: string; label: string; deltaCents: number; balanceCents: number }
export interface CashProjection { startCents: number | null; horizonDays: number; points: ProjectionPoint[]; lowCents: number | null; lowDate: string | null; overdraftRisk: boolean }

/** Conservative near-term projection: start from available, apply ONLY dated committed outflows
 *  (confirmed obligations + payroll/rent) — no assumed new deposits. Answers "will we overdraft /
 *  can we make payroll before the low point?" */
export async function projectCashLow(horizonDays = 14): Promise<CashProjection> {
  const db = getDb()
  const op = await getOperatingCash()
  const start = op?.availableCents ?? null
  const now = new Date(); const end = new Date(now.getTime() + horizonDays * 86400_000)
  const events: { date: Date; label: string; cents: number }[] = []

  const confirmed = await db.select().from(finObligations).where(eq(finObligations.status, 'confirmed'))
  for (const o of confirmed) {
    // Expand each confirmed obligation across the horizon by its cadence.
    const amt = -(o.amountCents ?? o.avgAmountCents ?? 0)
    if (!amt) continue
    if (o.category === 'payroll' && o.dayOfWeek != null) {
      for (let d = nextWeekday(now, o.dayOfWeek); d <= end; d.setUTCDate(d.getUTCDate() + 7)) events.push({ date: new Date(d), label: o.vendor, cents: amt })
    } else if (o.category === 'rent') {
      for (let d = nextDom(now, 15); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) events.push({ date: new Date(d), label: o.vendor, cents: amt })
    } else if (o.nextDue) {
      const d = new Date(o.nextDue + 'T00:00:00Z'); if (d >= now && d <= end) events.push({ date: d, label: o.vendor, cents: amt })
    }
  }
  events.sort((a, b) => a.date.getTime() - b.date.getTime())

  const points: ProjectionPoint[] = []
  let bal = start ?? 0; let low = start; let lowDate: string | null = start != null ? iso(now) : null
  for (const e of events) {
    bal += e.cents
    points.push({ date: iso(e.date), label: e.label, deltaCents: e.cents, balanceCents: bal })
    if (start != null && (low == null || bal < low)) { low = bal; lowDate = iso(e.date) }
  }
  return { startCents: start, horizonDays, points, lowCents: low, lowDate, overdraftRisk: low != null && low < 0 }
}
