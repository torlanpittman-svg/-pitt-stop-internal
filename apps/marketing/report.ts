/**
 * Weekly executive marketing report — the "don't open five platforms" view. Aggregates real stored
 * data only. When there's no data the numbers are honest zeros — never invented.
 *
 * Revenue model (CANONICAL, honest, disjoint):
 *   • Completed jobs + revenue come from completed `service_orders` + `job_estimates`
 *     (attribution.attributedCompletedJobs): one row per DISTINCT completed order that carries an
 *     active marketing touch. First/last + direct/assisted never double-count; unverified touches never
 *     fabricate a job; superseded lead links are excluded.
 *   • `invoicedRevenueCents` counts ONLY QB-anchored invoices. A completed job with no invoice yet has
 *     unknown invoiced value (it's simply not added) — never asserted as zero and never the draft quote.
 *   • `quotedJobValueCents` is the separate estimated/quoted value of completed jobs (pipeline context),
 *     explicitly NOT invoiced and NOT collected.
 *   • `collectedRevenueCents` is null — we have no QB paid status locally and never invent one.
 *   • `byService` is CANONICAL (jobs classified by their own `service_orders.services`), merged with
 *     Google Ads spend for ROAS. Ad spend + the platform's own reported revenue/conversions are shown
 *     separately and never counted as completed jobs.
 *   • Google Ads figures flow through `loadAdReporting` (live API when configured, else manual rows).
 *     When the API is configured but the fetch fails, ad spend/ROAS/reported numbers are `null`
 *     (UNAVAILABLE) — never a fabricated zero, and never a silent fall-back to manual data.
 */
import { type CategoryAdRollup } from './ads'
import { loadAdReporting, type AdDataMeta } from './ads-reporting'
import { attributedCompletedJobs, rollupBySource, leadsBySource, type AttributedOrder, type SourceAttribution } from './attribution'
import { REPORT_CHANNELS, reportChannelForSource, type ReportChannel, type ServiceCategory } from './types'

export type { AdDataMeta } from './ads-reporting'

export interface ServiceLine {
  serviceCategory: string
  completedJobs: number                 // canonical (classified from the job's own services)
  invoicedRevenueCents: number          // canonical, QB-anchored
  quotedJobValueCents: number           // canonical estimated value (not invoiced)
  spendCents: number | null             // Google Ads (null = ad data unavailable)
  adReportedRevenueCents: number | null // Google-Ads-reported (null = unavailable)
  adReportedConversions: number | null  // Google-Ads-reported, NOT completed jobs (null = unavailable)
  roas: number | null                   // invoiced revenue / ad spend
}

export interface ChannelLine {
  channel: ReportChannel
  spendCents: number | null             // null = ad spend unavailable
  revenueCents: number
  leads: number
}

/**
 * How the SHOP-side timestamp window relates to the `range` (the Google account-local date strings):
 *   • 'account_local' — shop timestamps were bounded by the SAME account-local calendar days as the
 *     Google query, so shop + ad figures share the displayed period (overview).
 *   • 'utc' — shop timestamps were bounded by UTC instants (weekly/custom legacy boundaries); the
 *     Google figures still use account-local interpretation of the date strings, so the two bases are
 *     NOT identical near midnight. The UI must label this honestly rather than imply one period.
 */
export type PeriodBasis = 'account_local' | 'utc'

export interface MarketingReport {
  range: { from: string; to: string }
  periodBasis: PeriodBasis          // shop-vs-ad period alignment (for honest labeling)
  spendCents: number | null         // Google Ads spend; null = ad data unavailable
  invoicedRevenueCents: number      // QB-anchored; completed jobs without an invoice are NOT added
  quotedJobValueCents: number       // estimated value of completed jobs (not invoiced, not collected)
  collectedRevenueCents: number | null // not tracked locally — null, never invented
  adReportedRevenueCents: number | null // null = ad data unavailable
  adReportedConversions: number | null  // null = ad data unavailable
  roas: number | null               // invoiced revenue / spend
  leads: number
  completedJobs: number             // DISTINCT completed attributed orders
  jobsInvoiced: number              // of those, how many have a QB invoice anchor
  byService: ServiceLine[]
  byChannel: ChannelLine[]
  bySource: SourceAttribution[]
  adData: AdDataMeta                // provenance: live API / manual entry / unavailable
  adByCategory: CategoryAdRollup[]  // active-source ad rollups (empty when unavailable)
  isEmpty: boolean
}

function ymd(d: Date): string { return d.toISOString().slice(0, 10) }
function roas(revenue: number, spend: number | null): number | null {
  if (spend == null || spend <= 0) return null
  return Math.round((revenue / spend) * 10) / 10
}

/**
 * Compute the report for an explicit date range.
 *
 * `range.from`/`range.to` are the SHOP timestamp bounds (inclusive, as `completed_at`/`created_at`
 * are filtered). The Google Ads query uses account-local YYYY-MM-DD strings: pass `range.adRange`
 * explicitly when the shop bounds were derived from account-local days (so we don't re-derive the ad
 * strings from the shop instants' UTC date — which would shift the end day). When `adRange` is
 * omitted the legacy behavior holds: the ad strings come from the shop instants' UTC date, and the
 * period basis is reported as 'utc'.
 */
export async function marketingReport(
  range: { from: Date; to: Date; adRange?: { from: string; to: string }; basis?: PeriodBasis },
): Promise<MarketingReport> {
  const dateRange = range.adRange ?? { from: ymd(range.from), to: ymd(range.to) }
  const periodBasis: PeriodBasis = range.basis ?? (range.adRange ? 'account_local' : 'utc')

  const ad = await loadAdReporting(dateRange)
  const adByCat = ad.byCategory
  const adUnavailable = ad.meta.status === 'unavailable'
  const orders = await attributedCompletedJobs(range)
  const bySource = rollupBySource(orders)
  const leadsSrc = await leadsBySource(range)

  // When the ad API is configured but the fetch failed, ad money is UNAVAILABLE (null) — not zero.
  const spendCents = adUnavailable ? null : adByCat.reduce((s, r) => s + r.spendCents, 0)
  const adReportedRevenueCents = adUnavailable ? null : adByCat.reduce((s, r) => s + r.revenueCents, 0)
  const adReportedConversions = adUnavailable ? null : adByCat.reduce((s, r) => s + r.conversions, 0)
  const invoicedRevenueCents = orders.reduce((s, o) => s + (o.invoicedCents ?? 0), 0)
  const quotedJobValueCents = orders.reduce((s, o) => s + (o.quotedValueCents ?? 0), 0)
  const completedJobs = orders.length
  const jobsInvoiced = orders.filter((o) => o.invoicedCents != null).length
  const leads = leadsSrc.reduce((s, r) => s + r.count, 0)

  const byService = buildByService(orders, adByCat, adUnavailable)

  // Channel rollup: ad spend buckets to google_ads; CANONICAL invoiced revenue + leads map by source.
  const channelMap = new Map<ReportChannel, ChannelLine>()
  for (const ch of REPORT_CHANNELS) channelMap.set(ch, { channel: ch, spendCents: 0, revenueCents: 0, leads: 0 })
  channelMap.get('google_ads')!.spendCents = spendCents
  for (const s of bySource) channelMap.get(reportChannelForSource(s.source))!.revenueCents += s.revenueCents
  for (const l of leadsSrc) channelMap.get(reportChannelForSource(l.source))!.leads += l.count
  // Keep the Google Ads channel visible (spend shown as unavailable) when ad data is unknown — never
  // silently drop it so the UI can't imply "no activity" for a failed/unknown read.
  const byChannel = Array.from(channelMap.values()).filter((c) =>
    (c.spendCents != null && c.spendCents !== 0) || c.revenueCents || c.leads || (adUnavailable && c.channel === 'google_ads'),
  )

  // When ad data is UNAVAILABLE we do NOT know it's empty — never claim "no activity" in that case.
  const isEmpty = !adUnavailable && (spendCents ?? 0) === 0 && (adReportedRevenueCents ?? 0) === 0 && completedJobs === 0 && leads === 0

  return {
    range: dateRange,
    periodBasis,
    spendCents,
    invoicedRevenueCents,
    quotedJobValueCents,
    collectedRevenueCents: null,
    adReportedRevenueCents,
    adReportedConversions,
    roas: roas(invoicedRevenueCents, spendCents),
    leads, completedJobs, jobsInvoiced,
    byService, byChannel, bySource,
    adData: ad.meta,
    adByCategory: adByCat,
    isEmpty,
  }
}

/**
 * Merge canonical completed-job service rollups with Google Ads spend/reported data per category.
 * When ad data is UNAVAILABLE, the ad columns stay `null` (not 0) on every line so the UI can show
 * them as unavailable rather than a fabricated zero.
 */
function buildByService(orders: AttributedOrder[], adByCat: CategoryAdRollup[], adUnavailable: boolean): ServiceLine[] {
  const map = new Map<string, ServiceLine>()
  const line = (cat: string): ServiceLine => {
    let l = map.get(cat)
    if (!l) {
      l = {
        serviceCategory: cat, completedJobs: 0, invoicedRevenueCents: 0, quotedJobValueCents: 0,
        spendCents: adUnavailable ? null : 0,
        adReportedRevenueCents: adUnavailable ? null : 0,
        adReportedConversions: adUnavailable ? null : 0,
        roas: null,
      }
      map.set(cat, l)
    }
    return l
  }
  for (const o of orders) {
    const l = line(o.serviceCategory)
    l.completedJobs += 1
    l.invoicedRevenueCents += o.invoicedCents ?? 0
    l.quotedJobValueCents += o.quotedValueCents ?? 0
  }
  if (!adUnavailable) {
    for (const r of adByCat) {
      const l = line(r.serviceCategory)
      l.spendCents = (l.spendCents ?? 0) + r.spendCents
      l.adReportedRevenueCents = (l.adReportedRevenueCents ?? 0) + r.revenueCents
      l.adReportedConversions = (l.adReportedConversions ?? 0) + r.conversions
    }
  }
  for (const l of map.values()) l.roas = roas(l.invoicedRevenueCents, l.spendCents)
  return Array.from(map.values()).sort((a, b) => b.invoicedRevenueCents - a.invoicedRevenueCents || (b.spendCents ?? 0) - (a.spendCents ?? 0))
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

/**
 * Report for an explicit [from,to] range vs the immediately-preceding equal-length window (so the
 * WoW-style comparison still works for any custom range the owner picks). `to` is inclusive.
 */
export async function reportForRange(from: Date, to: Date): Promise<WeeklyReport> {
  const lenMs = to.getTime() - from.getTime()
  const prevTo = new Date(from.getTime() - 1)
  const prevFrom = new Date(prevTo.getTime() - lenMs)
  const [current, previous] = await Promise.all([
    marketingReport({ from, to }),
    marketingReport({ from: prevFrom, to: prevTo }),
  ])
  return { current, previous }
}

export const PREMIUM_SERVICE_CARDS: ServiceCategory[] = ['ceramic', 'paint_correction', 'interior']
