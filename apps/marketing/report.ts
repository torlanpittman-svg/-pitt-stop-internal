/**
 * Weekly executive marketing report — the "don't open five platforms" view. Aggregates real stored
 * data only: Google Ads metrics (marketing_ad_metrics), attribution (marketing_attribution), and
 * leads (marketing_leads). When there's no data the numbers are honest zeros — never invented.
 *
 * Revenue model (kept disjoint to avoid double counting):
 *   • Google Ads attributed revenue lives in marketing_ad_metrics.revenue_cents.
 *   • All other channels' attributed revenue lives in marketing_attribution rows.
 *   • attributedRevenueCents = ads revenue + attribution revenue.
 */
import { adMetricsByCategory, type CategoryAdRollup } from './ads'
import { attributionBySource, leadsBySource } from './attribution'
import { REPORT_CHANNELS, reportChannelForSource, type ReportChannel, type ServiceCategory } from './types'

export interface ServiceLine {
  serviceCategory: string
  spendCents: number
  revenueCents: number
  conversions: number
  roas: number | null
}

export interface ChannelLine {
  channel: ReportChannel
  spendCents: number
  revenueCents: number
  leads: number
}

export interface MarketingReport {
  range: { from: string; to: string }
  spendCents: number
  adRevenueCents: number
  attributionRevenueCents: number
  attributedRevenueCents: number
  roas: number | null
  leads: number
  completedJobs: number
  byService: ServiceLine[]
  byChannel: ChannelLine[]
  bySource: Array<{ source: string; revenueCents: number; direct: number; assisted: number; unknown: number; count: number }>
  isEmpty: boolean
}

function ymd(d: Date): string { return d.toISOString().slice(0, 10) }
function roas(revenue: number, spend: number): number | null {
  if (spend <= 0) return null
  return Math.round((revenue / spend) * 10) / 10
}

/** Compute the report for an explicit date range. */
export async function marketingReport(range: { from: Date; to: Date }): Promise<MarketingReport> {
  const dateRange = { from: ymd(range.from), to: ymd(range.to) }

  const adByCat: CategoryAdRollup[] = await adMetricsByCategory(dateRange)
  const bySource = await attributionBySource(range)
  const leadsSrc = await leadsBySource(range)

  const spendCents = adByCat.reduce((s, r) => s + r.spendCents, 0)
  const adRevenueCents = adByCat.reduce((s, r) => s + r.revenueCents, 0)
  const attributionRevenueCents = bySource.reduce((s, r) => s + r.revenueCents, 0)
  const attributedRevenueCents = adRevenueCents + attributionRevenueCents
  const leads = leadsSrc.reduce((s, r) => s + r.count, 0)
  // Completed jobs = attribution rows that carry revenue + Google Ads conversions.
  const adConversions = adByCat.reduce((s, r) => s + r.conversions, 0)
  const completedJobs = bySource.reduce((s, r) => s + r.count, 0) + adConversions

  const byService: ServiceLine[] = adByCat
    .map((r) => ({ serviceCategory: r.serviceCategory, spendCents: r.spendCents, revenueCents: r.revenueCents, conversions: r.conversions, roas: roas(r.revenueCents, r.spendCents) }))
    .sort((a, b) => b.spendCents - a.spendCents)

  // Channel rollup: ads spend/revenue bucket to google_ads; attribution + leads map by source.
  const channelMap = new Map<ReportChannel, ChannelLine>()
  for (const ch of REPORT_CHANNELS) channelMap.set(ch, { channel: ch, spendCents: 0, revenueCents: 0, leads: 0 })
  const ga = channelMap.get('google_ads')!
  ga.spendCents += spendCents
  ga.revenueCents += adRevenueCents
  for (const s of bySource) {
    const ch = channelMap.get(reportChannelForSource(s.source))!
    ch.revenueCents += s.revenueCents
  }
  for (const l of leadsSrc) {
    const ch = channelMap.get(reportChannelForSource(l.source))!
    ch.leads += l.count
  }
  const byChannel = Array.from(channelMap.values()).filter((c) => c.spendCents || c.revenueCents || c.leads)

  const isEmpty = spendCents === 0 && attributedRevenueCents === 0 && leads === 0 && bySource.length === 0

  return {
    range: dateRange,
    spendCents, adRevenueCents, attributionRevenueCents, attributedRevenueCents,
    roas: roas(attributedRevenueCents, spendCents),
    leads, completedJobs,
    byService, byChannel, bySource,
    isEmpty,
  }
}

/** Start-of-week (Monday) for a given date, at 00:00 local-UTC. */
export function weekStart(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = (date.getUTCDay() + 6) % 7 // 0 = Monday
  date.setUTCDate(date.getUTCDate() - day)
  return date
}

export interface WeeklyReport {
  current: MarketingReport
  previous: MarketingReport
}

/** Current week + previous week for the comparison view. `asOf` defaults to now (pass for tests). */
export async function weeklyReport(asOf: Date): Promise<WeeklyReport> {
  const curStart = weekStart(asOf)
  const curEnd = new Date(curStart.getTime() + 7 * 86_400_000 - 1)
  const prevStart = new Date(curStart.getTime() - 7 * 86_400_000)
  const prevEnd = new Date(curStart.getTime() - 1)
  const [current, previous] = await Promise.all([
    marketingReport({ from: curStart, to: curEnd }),
    marketingReport({ from: prevStart, to: prevEnd }),
  ])
  return { current, previous }
}

export const PREMIUM_SERVICE_CARDS: ServiceCategory[] = ['ceramic', 'paint_correction', 'interior']
