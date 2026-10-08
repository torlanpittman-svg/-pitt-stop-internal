import Link from 'next/link'
import { requireMarketingManager, MarketingShell, Section, StatTile, StatusChip, EmptyRow } from './_components'
import { money, bigMoney, count } from '@/app/lib/format'
import { marketingReport } from '@/apps/marketing/report'
import { adMetricsByCategory } from '@/apps/marketing/ads'
import { listSearchTerms } from '@/apps/marketing/ads'
import { buildAdRecommendations } from '@/apps/marketing/recommendations'
import { listCampaigns } from '@/apps/marketing/db'
import { listPosts } from '@/apps/marketing/content'
import { SERVICE_CATEGORY_LABELS, REPORT_CHANNEL_LABELS, PREMIUM_CATEGORIES } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function monthRange(now: Date) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59))
  return { from, to }
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)

export default async function MarketingOverview() {
  await requireMarketingManager()
  const now = new Date()
  const range = monthRange(now)
  const report = await marketingReport(range)
  const adByCat = await adMetricsByCategory({ from: ymd(range.from), to: ymd(range.to) })
  const terms = await listSearchTerms()
  const recs = buildAdRecommendations({ byCategory: adByCat, searchTerms: terms })
  const campaigns = await listCampaigns({ limit: 6 })
  const upcomingPosts = (await listPosts({ limit: 50 })).filter((p) => ['approved', 'scheduled', 'draft'].includes(p.status)).slice(0, 6)

  // Canonical premium-service performance: completed-job COUNT + INVOICED revenue (from the report's
  // canonical byService), with Google Ads spend alongside for ROAS. Not ad-reported revenue.
  const premiumCards = PREMIUM_CATEGORIES.map((cat) => {
    const row = report.byService.find((r) => r.serviceCategory === cat)
    return { cat, spend: row?.spendCents ?? 0, invoiced: row?.invoicedRevenueCents ?? 0, jobs: row?.completedJobs ?? 0, roas: row?.roas ?? null }
  })

  return (
    <MarketingShell active="/marketing" title="Overview"
      actions={<Link href="/marketing/campaigns/new" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">New campaign</Link>}>

      <p className="mb-4 text-sm text-gray-500">This month ({ymd(range.from)} → {ymd(now)}). Revenue is attributed from completed jobs only (invoiced basis); Google Ads platform numbers are shown separately below.</p>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Attributed revenue" value={bigMoney(report.invoicedRevenueCents)} note="invoiced · completed jobs" />
        <StatTile label="Marketing spend" value={bigMoney(report.spendCents)} />
        <StatTile label="ROAS" value={report.roas == null ? '—' : `${report.roas.toFixed(1)}x`} />
        <StatTile label="Leads" value={count(report.leads)} />
        <StatTile label="Completed jobs" value={count(report.completedJobs)} note="unique attributed orders" />
        <StatTile label="Campaigns" value={count(campaigns.length)} />
      </div>

      <Section title="Premium services (completed jobs, this month)">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {premiumCards.map((c) => (
            <div key={c.cat} className="rounded-xl border border-gray-800 bg-gray-950 p-3">
              <div className="text-sm font-semibold text-white">{SERVICE_CATEGORY_LABELS[c.cat]}</div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><div className="text-[10px] uppercase text-gray-500">Jobs</div><div className="text-sm font-bold">{c.jobs}</div></div>
                <div><div className="text-[10px] uppercase text-gray-500">Invoiced</div><div className="text-sm font-bold text-emerald-400">{money(c.invoiced)}</div></div>
                <div><div className="text-[10px] uppercase text-gray-500">Ad spend</div><div className="text-sm font-bold">{money(c.spend)}</div></div>
              </div>
              <div className="mt-1 text-center text-xs text-gray-500">{c.roas != null ? `${c.roas.toFixed(1)}x ROAS (invoiced)` : c.spend > 0 ? 'No invoiced revenue yet' : 'No ad spend'}</div>
            </div>
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Revenue by channel">
          {report.byChannel.length === 0 ? <EmptyRow>No channel data yet. Import Google Ads data or link attribution.</EmptyRow> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-gray-500"><th className="pb-2">Channel</th><th className="pb-2 text-right">Spend</th><th className="pb-2 text-right">Revenue</th><th className="pb-2 text-right">Leads</th></tr></thead>
              <tbody>
                {report.byChannel.map((c) => (
                  <tr key={c.channel} className="border-t border-gray-800">
                    <td className="py-2">{REPORT_CHANNEL_LABELS[c.channel]}</td>
                    <td className="py-2 text-right">{money(c.spendCents)}</td>
                    <td className="py-2 text-right text-emerald-400">{money(c.revenueCents)}</td>
                    <td className="py-2 text-right">{c.leads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Recommendations needing attention" right={<Link href="/marketing/google-ads" className="text-xs text-blue-400 hover:underline">Google Ads →</Link>}>
          {recs.length === 0 ? <EmptyRow>No recommendations — import Google Ads data to generate them.</EmptyRow> : (
            <ul className="space-y-2">
              {recs.slice(0, 4).map((r) => (
                <li key={r.id} className="rounded-lg border border-gray-800 bg-gray-950 p-3">
                  <div className="flex items-center gap-2"><StatusChip status={r.severity === 'warn' ? 'needs_review' : 'suggested'} /><span className="text-sm font-semibold">{r.title}</span></div>
                  <p className="mt-1 text-xs text-gray-400">{r.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent campaigns" right={<Link href="/marketing/campaigns" className="text-xs text-blue-400 hover:underline">All →</Link>}>
          {campaigns.length === 0 ? <EmptyRow>No campaigns yet. Create your first revenue campaign.</EmptyRow> : (
            <ul className="space-y-2">
              {campaigns.map((c) => (
                <li key={c.id}>
                  <Link href={`/marketing/campaigns/${c.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950 p-3 hover:border-gray-700">
                    <span className="min-w-0"><span className="block truncate text-sm font-semibold">{c.name}</span><span className="text-xs text-gray-500">{count(c.recipientCount)} recipients · {count(c.sentCount)} sent{c.dryRun ? ' · dry-run' : ''}</span></span>
                    <StatusChip status={c.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Upcoming content" right={<Link href="/marketing/content" className="text-xs text-blue-400 hover:underline">Content →</Link>}>
          {upcomingPosts.length === 0 ? <EmptyRow>No posts queued. Draft this week&apos;s 3 Facebook posts.</EmptyRow> : (
            <ul className="space-y-2">
              {upcomingPosts.map((p) => (
                <li key={p.id} className="rounded-lg border border-gray-800 bg-gray-950 p-3">
                  <div className="flex items-center gap-2"><StatusChip status={p.status} /><span className="text-xs uppercase text-gray-500">{p.pillar}{p.targetService ? ` · ${SERVICE_CATEGORY_LABELS[p.targetService as keyof typeof SERVICE_CATEGORY_LABELS] ?? p.targetService}` : ''}</span></div>
                  <p className="mt-1 line-clamp-2 text-xs text-gray-400">{p.copy || '—'}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </MarketingShell>
  )
}
