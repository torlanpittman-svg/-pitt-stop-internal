/**
 * Report rollup for the self-reported "How did you hear about us?" answer captured at retail intake.
 * Counts Jobs created in the window by referral_source. Deliberately NOT merged with click attribution
 * (gclid/utm on bookings → marketing_attribution): the report shows both, side by side.
 */
import { and, gte, lte, ne, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { serviceOrders } from '@/apps/workflow/schema'
import { referralSourceLabel } from './referral-source'

export interface ReferralSourceLine { source: string | null; label: string; jobs: number }

export async function referralSourceBreakdown(range: { from: Date; to: Date }): Promise<{ lines: ReferralSourceLine[]; answered: number; total: number }> {
  const rows = await getDb()
    .select({ source: serviceOrders.referralSource, jobs: sql<number>`count(*)::int` })
    .from(serviceOrders)
    .where(and(gte(serviceOrders.createdAt, range.from), lte(serviceOrders.createdAt, range.to), ne(serviceOrders.status, 'cancelled')))
    .groupBy(serviceOrders.referralSource)
  const lines = rows
    .map((r) => ({ source: r.source, label: r.source ? referralSourceLabel(r.source) : 'Not asked / not answered', jobs: Number(r.jobs) }))
    .sort((a, b) => (a.source === null ? 1 : b.source === null ? -1 : b.jobs - a.jobs))
  const total = lines.reduce((n, l) => n + l.jobs, 0)
  const answered = lines.filter((l) => l.source !== null).reduce((n, l) => n + l.jobs, 0)
  return { lines, answered, total }
}
