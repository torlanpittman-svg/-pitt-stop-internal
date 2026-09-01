/**
 * Production Log — derived, count-once. A Job appears on the day its single completed_at falls (shop
 * timezone), unless a manual production-date override moves it. Reopened Jobs (completed_at cleared)
 * drop out. Cancelled Jobs never count. No separate log table.
 *
 * ONE canonical production value per Job (never a sum of two prices → double-count impossible):
 *   dealer  = dealer_scans.rate (flat, unchanged)
 *   retail/unknown = retailProductionValueCents precedence:
 *     1. explicit_total_cents  (manager authoritative pre-fee/pre-tax work price)   ← manager override wins
 *     2. itemized non-generated line subtotal (manager itemized)
 *     3. agreed_price_cents    (employee-confirmed EXPECTED value at intake)
 *     4. null → "—"
 * This is the pre-fee/pre-tax WORK value (consistent with the flat dealer rate) — NOT the invoiced
 * total (fees/tax stay in the invoice layer). Daily and Weekly read the SAME rows, so daily totals sum
 * exactly to the week total and retail+dealer+unknown reconcile exactly to it.
 */
import { getDb } from '@/platform/db'
import { sql } from 'drizzle-orm'
import { shopTimezone } from './completion'
import { orderSourceKind } from './fees'

/** ONE retail/unknown production value from the estimate, by precedence. Never sums prices. */
export function retailProductionValueCents(v: { explicitTotalCents: number | null; itemizedSubtotalCents: number | null; agreedPriceCents: number | null }): number | null {
  if (v.explicitTotalCents != null && v.explicitTotalCents > 0) return v.explicitTotalCents
  if (v.itemizedSubtotalCents != null && v.itemizedSubtotalCents > 0) return v.itemizedSubtotalCents
  if (v.agreedPriceCents != null && v.agreedPriceCents > 0) return v.agreedPriceCents
  return null
}

export type ProductionKind = 'retail' | 'dealer' | 'unknown'

export interface ProductionJob {
  id: string
  orderNumber: string
  customer: string | null
  vehicle: string
  services: string[]
  completedAt: string
  completedBy: string | null
  source: ProductionKind
  effectiveDate: string          // shop-calendar production day (override or completed_at day)
  priceCents: number | null      // ONE canonical value (null = unpriced → "—", never $0)
  overridden: boolean
}

/**
 * Effective Production Date (shop calendar day, 'YYYY-MM-DD'): the manual override when set, otherwise
 * the day completed_at falls on in the shop timezone. NEVER changes completed_at. Null when not completed.
 */
export function effectiveProductionDate(override: string | null | undefined, completedAt: Date | string | null | undefined, tz: string = shopTimezone()): string | null {
  if (override) return override
  if (!completedAt) return null
  const d = completedAt instanceof Date ? completedAt : new Date(completedAt)
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d)
}

/**
 * The shared production row set for [from, to] (inclusive, shop-calendar). Identical predicate for daily
 * and weekly so they always reconcile: completed, NOT cancelled, effective date in range, deduped by id.
 */
async function productionRows(from: string, to: string, tz: string): Promise<ProductionJob[]> {
  const db = getDb()
  const result = await db.execute(sql`
    SELECT
      so.id            AS id,
      so.order_number  AS order_number,
      so.customer_name AS customer,
      so.services      AS services,
      so.completed_at  AS completed_at,
      so.completed_by  AS completed_by,
      so.production_date_override AS override_date,
      so.source        AS order_source,
      so.service_type  AS service_type,
      v.year AS year, v.make AS make, v.model AS model,
      je.explicit_total_cents AS explicit_total_cents,
      je.agreed_price_cents   AS agreed_price_cents,
      (SELECT COALESCE(SUM(li.price_cents), 0) FROM job_line_items li
         JOIN job_services js ON js.id = li.job_service_id
        WHERE js.job_estimate_id = je.id AND li.generated = false) AS itemized_subtotal_cents,
      ds.rate AS dealer_rate,
      ds.id   AS scan_id,
      COALESCE(so.production_date_override, (so.completed_at AT TIME ZONE ${tz})::date)::text AS eff_date
    FROM service_orders so
    LEFT JOIN vehicles v ON v.id = so.vehicle_id
    LEFT JOIN job_estimates je ON je.service_order_id = so.id
    LEFT JOIN dealer_scans ds ON ds.service_order_id = so.id
    WHERE so.completed_at IS NOT NULL
      AND so.status <> 'cancelled'
      AND COALESCE(so.production_date_override, (so.completed_at AT TIME ZONE ${tz})::date) BETWEEN ${from}::date AND ${to}::date
    ORDER BY so.completed_at DESC
  `)

  const seen = new Set<string>()
  const jobs: ProductionJob[] = []
  for (const r of result.rows as Record<string, unknown>[]) {
    const id = String(r.id)
    if (seen.has(id)) continue      // a dealer Job could left-join >1 scan
    seen.add(id)
    const kind = orderSourceKind({ source: r.order_source as string | null, serviceType: r.service_type as string | null })
    const priceCents = kind === 'dealer'
      ? (r.dealer_rate != null ? Math.round(Number(r.dealer_rate) * 100) : null)
      : retailProductionValueCents({
          explicitTotalCents: r.explicit_total_cents != null ? Number(r.explicit_total_cents) : null,
          itemizedSubtotalCents: r.itemized_subtotal_cents != null ? Number(r.itemized_subtotal_cents) : null,
          agreedPriceCents: r.agreed_price_cents != null ? Number(r.agreed_price_cents) : null,
        })
    jobs.push({
      id,
      orderNumber: String(r.order_number ?? ''),
      customer: (r.customer as string | null) ?? null,
      vehicle: [r.year, r.make, r.model].filter(Boolean).join(' ') || 'Vehicle',
      services: Array.isArray(r.services) ? (r.services as string[]) : [],
      completedAt: new Date(r.completed_at as string).toISOString(),
      completedBy: (r.completed_by as string | null) ?? null,
      source: kind,
      effectiveDate: String(r.eff_date),
      priceCents,
      overridden: !!r.override_date,
    })
  }
  return jobs
}

export interface DailyProduction {
  date: string
  tz: string
  count: number
  jobs: ProductionJob[]
  byTech: { name: string; count: number }[]
}

/** date: 'YYYY-MM-DD' interpreted in the shop timezone. */
export async function dailyProduction(date: string, tz: string = shopTimezone()): Promise<DailyProduction> {
  const jobs = await productionRows(date, date, tz)
  const byTechMap = new Map<string, number>()
  for (const j of jobs) { const k = j.completedBy || '—'; byTechMap.set(k, (byTechMap.get(k) || 0) + 1) }
  return {
    date, tz,
    count: jobs.length,
    jobs,
    byTech: [...byTechMap].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  }
}

// ── Weekly (Monday → Saturday operational week; Sunday excluded) ──
/** Calendar-day arithmetic on 'YYYY-MM-DD' (UTC noon → DST/tz-boundary safe). */
function addCalDays(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, day + n, 12))
  return dt.toISOString().slice(0, 10)
}
/** ISO weekday 1=Mon..7=Sun for a 'YYYY-MM-DD' (UTC noon → stable). */
function isoWeekday(d: string): number {
  const [y, m, day] = d.split('-').map(Number)
  const wd = new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay()   // 0=Sun..6=Sat
  return wd === 0 ? 7 : wd
}
/** Monday of the operational week containing `date`. */
export function weekStartMonday(date: string): string {
  return addCalDays(date, -(isoWeekday(date) - 1))
}

export interface WeeklyProductionDay { date: string; weekday: string; totalCents: number; count: number; isFuture: boolean }
export interface WeeklyProduction {
  weekStartMon: string
  weekEndSat: string
  tz: string
  days: WeeklyProductionDay[]                 // Mon..Sat (6)
  weekTotalCents: number
  byKind: { retail: number; dealer: number; unknown: number }
  count: number
  jobs: ProductionJob[]
}
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** anchor: any 'YYYY-MM-DD' in the desired week. Returns Mon–Sat totals + retail/dealer/unknown split. */
export async function weeklyProduction(anchor: string, tz: string = shopTimezone()): Promise<WeeklyProduction> {
  const mon = weekStartMonday(anchor)
  const sat = addCalDays(mon, 5)
  const jobs = await productionRows(mon, sat, tz)   // SAME rows as the 6 daily queries combined
  const today = shopToday(tz)

  const dayTotals = new Map<string, { total: number; count: number }>()
  const byKind = { retail: 0, dealer: 0, unknown: 0 }
  let weekTotal = 0
  for (const j of jobs) {
    const v = j.priceCents ?? 0
    weekTotal += v
    byKind[j.source] += v
    const d = dayTotals.get(j.effectiveDate) ?? { total: 0, count: 0 }
    d.total += v; d.count += 1
    dayTotals.set(j.effectiveDate, d)
  }

  const days: WeeklyProductionDay[] = WEEKDAY_LABELS.map((label, i) => {
    const date = addCalDays(mon, i)
    const d = dayTotals.get(date)
    return { date, weekday: label, totalCents: d?.total ?? 0, count: d?.count ?? 0, isFuture: date > today }
  })

  return { weekStartMon: mon, weekEndSat: sat, tz, days, weekTotalCents: weekTotal, byKind, count: jobs.length, jobs }
}

/** Current 'YYYY-MM-DD' in the shop timezone. */
export function shopToday(tz: string = shopTimezone()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}
