/**
 * Google Ads data layer. V1 holds metrics in marketing_ad_metrics (daily, per service category) and
 * search terms in marketing_search_terms. Rows arrive via manual import now, or a future read-only
 * Google Ads API sync later (providers/index.ts GoogleAdsProvider) — the storage + reporting don't
 * change when that turns on. Revenue here is GOOGLE-ADS-REPORTED (what the platform reports / the
 * owner enters) — NOT Pitt Stop collected cash and NOT canonical completed-job revenue (the report
 * derives that separately from completed service_orders + QB invoices).
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingAdMetrics, marketingSearchTerms } from './schema'
import { logEvent } from './events'

export type AdMetric = typeof marketingAdMetrics.$inferSelect
export type SearchTerm = typeof marketingSearchTerms.$inferSelect

export interface AdMetricInput {
  provider?: string
  serviceCategory: string
  statDate: string            // YYYY-MM-DD
  spendCents?: number
  impressions?: number
  clicks?: number
  conversions?: number
  revenueCents?: number
}

/** Upsert one daily metric row (idempotent on provider+category+date). */
export async function upsertAdMetric(input: AdMetricInput, actor: string | null): Promise<void> {
  const provider = input.provider ?? 'manual'
  await getDb().insert(marketingAdMetrics).values({
    provider,
    serviceCategory: input.serviceCategory,
    statDate: input.statDate,
    spendCents: input.spendCents ?? 0,
    impressions: input.impressions ?? 0,
    clicks: input.clicks ?? 0,
    conversions: input.conversions ?? 0,
    revenueCents: input.revenueCents ?? 0,
    createdBy: actor,
  }).onConflictDoUpdate({
    target: [marketingAdMetrics.provider, marketingAdMetrics.serviceCategory, marketingAdMetrics.statDate],
    set: {
      spendCents: input.spendCents ?? 0,
      impressions: input.impressions ?? 0,
      clicks: input.clicks ?? 0,
      conversions: input.conversions ?? 0,
      revenueCents: input.revenueCents ?? 0,
      updatedAt: new Date(),
    },
  })
  await logEvent('ad_metrics_imported', { entityType: 'ad_metric', actor, meta: { provider, category: input.serviceCategory, date: input.statDate } })
}

export async function listAdMetrics(range: { from: string; to: string }): Promise<AdMetric[]> {
  return getDb().select().from(marketingAdMetrics)
    .where(and(gte(marketingAdMetrics.statDate, range.from), lte(marketingAdMetrics.statDate, range.to)))
    .orderBy(desc(marketingAdMetrics.statDate))
}

export interface CategoryAdRollup {
  serviceCategory: string
  spendCents: number
  impressions: number
  clicks: number
  conversions: number
  revenueCents: number
}

/** Spend/clicks/conversions/revenue rolled up per service category for a range. */
export async function adMetricsByCategory(range: { from: string; to: string }): Promise<CategoryAdRollup[]> {
  return getDb().select({
    serviceCategory: marketingAdMetrics.serviceCategory,
    spendCents: sql<number>`coalesce(sum(${marketingAdMetrics.spendCents}),0)::int`,
    impressions: sql<number>`coalesce(sum(${marketingAdMetrics.impressions}),0)::int`,
    clicks: sql<number>`coalesce(sum(${marketingAdMetrics.clicks}),0)::int`,
    conversions: sql<number>`coalesce(sum(${marketingAdMetrics.conversions}),0)::int`,
    revenueCents: sql<number>`coalesce(sum(${marketingAdMetrics.revenueCents}),0)::int`,
  }).from(marketingAdMetrics)
    .where(and(gte(marketingAdMetrics.statDate, range.from), lte(marketingAdMetrics.statDate, range.to)))
    .groupBy(marketingAdMetrics.serviceCategory)
}

export async function upsertSearchTerm(input: {
  term: string; serviceCategory?: string | null; spendCents?: number; clicks?: number; conversions?: number; revenueCents?: number; statPeriod?: string | null
}): Promise<void> {
  await getDb().insert(marketingSearchTerms).values({
    term: input.term,
    serviceCategory: input.serviceCategory ?? null,
    spendCents: input.spendCents ?? 0,
    clicks: input.clicks ?? 0,
    conversions: input.conversions ?? 0,
    revenueCents: input.revenueCents ?? 0,
    statPeriod: input.statPeriod ?? null,
  })
}

export async function listSearchTerms(period?: string): Promise<SearchTerm[]> {
  const db = getDb()
  const q = db.select().from(marketingSearchTerms).orderBy(desc(marketingSearchTerms.spendCents)).limit(500)
  return period ? q.where(eq(marketingSearchTerms.statPeriod, period)) : q
}
