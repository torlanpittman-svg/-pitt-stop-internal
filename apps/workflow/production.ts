/**
 * Daily Production Log — derived, count-once. A Job appears on the day its single
 * completed_at falls (in the shop timezone). Reopened Jobs (completed_at cleared)
 * drop out until they are truly completed again. Delivered Jobs keep counting on
 * their original completion day. No separate log table.
 */
import { getDb } from '@/platform/db'
import { sql, eq, and, isNotNull, desc } from 'drizzle-orm'
import { serviceOrders, vehicles } from './schema'
import { shopTimezone } from './completion'

export interface ProductionJob {
  orderNumber: string
  customer: string | null
  vehicle: string
  services: string[]
  completedAt: string
  completedBy: string | null
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
  const db = getDb()
  const rows = await db
    .select({
      orderNumber: serviceOrders.orderNumber,
      customer:    serviceOrders.customerName,
      services:    serviceOrders.services,
      completedAt: serviceOrders.completedAt,
      completedBy: serviceOrders.completedBy,
      year:        vehicles.year,
      make:        vehicles.make,
      model:       vehicles.model,
    })
    .from(serviceOrders)
    .leftJoin(vehicles, eq(serviceOrders.vehicleId, vehicles.id))
    .where(and(
      isNotNull(serviceOrders.completedAt),
      sql`(${serviceOrders.completedAt} AT TIME ZONE ${tz})::date = ${date}::date`,
    ))
    .orderBy(desc(serviceOrders.completedAt))

  const jobs: ProductionJob[] = rows.map((r) => ({
    orderNumber: r.orderNumber,
    customer:    r.customer,
    vehicle:     [r.year, r.make, r.model].filter(Boolean).join(' ') || 'Vehicle',
    services:    (r.services as string[] | null) ?? [],
    completedAt: (r.completedAt as Date).toISOString(),
    completedBy: r.completedBy,
  }))

  const byTechMap = new Map<string, number>()
  for (const j of jobs) { const k = j.completedBy || '—'; byTechMap.set(k, (byTechMap.get(k) || 0) + 1) }

  return {
    date, tz,
    count: jobs.length,  // each Job appears once (one completed_at)
    jobs,
    byTech: [...byTechMap].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  }
}

/** Current 'YYYY-MM-DD' in the shop timezone. */
export function shopToday(tz: string = shopTimezone()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}
