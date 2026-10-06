import { requireMarketingManager, MarketingShell, Section, StatTile, StatusChip, EmptyRow } from '@/app/marketing/_components'
import { money, bigMoney } from '@/app/lib/format'
import { adMetricsByCategory, listSearchTerms } from '@/apps/marketing/ads'
import { buildAdRecommendations } from '@/apps/marketing/recommendations'
import { importAdMetricAction } from '@/app/marketing/actions'
import { SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ymd = (d: Date) => d.toISOString().slice(0, 10)
function monthRange(now: Date) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59))
  return { from, to }
}

const label = (cat: string) => SERVICE_CATEGORY_LABELS[cat as keyof typeof SERVICE_CATEGORY_LABELS] ?? cat

const inputClass = 'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm'
const primaryBtn = 'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500'

export default async function GoogleAdsPage() {
  await requireMarketingManager('/marketing/google-ads')
  const now = new Date()
  const { from, to } = monthRange(now)

  const cat = await adMetricsByCategory({ from: ymd(from), to: ymd(to) })
  const terms = await listSearchTerms()
  const recs = buildAdRecommendations({ byCategory: cat, searchTerms: terms })

  const totalSpend = cat.reduce((s, r) => s + r.spendCents, 0)
  const totalRevenue = cat.reduce((s, r) => s + r.revenueCents, 0)
  const blendedRoas = totalSpend > 0 ? totalRevenue / totalSpend : null

  return (
    <MarketingShell active="/marketing/google-ads" title="Google Ads">
      <p className="mb-4 text-sm text-gray-500">This month ({ymd(from)} → {ymd(now)}). Revenue is attributed completed revenue — never estimated.</p>

      <Section title="Connection status">
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          Google Ads API not connected — metrics are entered manually below. Set GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_ADS_CUSTOMER_ID to enable read-only sync.
        </div>
      </Section>

      <Section title="Performance by service (this month)">
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label="Total spend" value={bigMoney(totalSpend)} />
          <StatTile label="Total revenue" value={bigMoney(totalRevenue)} />
          <StatTile label="Blended ROAS" value={blendedRoas == null ? '—' : `${blendedRoas.toFixed(1)}x`} />
        </div>
        {cat.length === 0 ? <EmptyRow>No metrics for this month yet. Import daily metrics below.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Service</th>
                  <th className="pb-2 text-right">Spend</th>
                  <th className="pb-2 text-right">Impr.</th>
                  <th className="pb-2 text-right">Clicks</th>
                  <th className="pb-2 text-right">CTR</th>
                  <th className="pb-2 text-right">CPC</th>
                  <th className="pb-2 text-right">Conv.</th>
                  <th className="pb-2 text-right">Cost / lead</th>
                  <th className="pb-2 text-right">Revenue</th>
                  <th className="pb-2 text-right">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {cat.map((r) => {
                  const ctr = r.impressions > 0 ? (r.clicks / r.impressions) * 100 : null
                  const cpc = r.clicks > 0 ? Math.round(r.spendCents / r.clicks) : null
                  const costPerLead = r.conversions > 0 ? Math.round(r.spendCents / r.conversions) : null
                  const roas = r.spendCents > 0 ? r.revenueCents / r.spendCents : null
                  return (
                    <tr key={r.serviceCategory} className="border-t border-gray-800">
                      <td className="py-2">{label(r.serviceCategory)}</td>
                      <td className="py-2 text-right">{money(r.spendCents)}</td>
                      <td className="py-2 text-right">{r.impressions.toLocaleString('en-US')}</td>
                      <td className="py-2 text-right">{r.clicks.toLocaleString('en-US')}</td>
                      <td className="py-2 text-right">{ctr == null ? '—' : `${ctr.toFixed(1)}%`}</td>
                      <td className="py-2 text-right">{cpc == null ? '—' : money(cpc)}</td>
                      <td className="py-2 text-right">{r.conversions}</td>
                      <td className="py-2 text-right">{costPerLead == null ? '—' : money(costPerLead)}</td>
                      <td className="py-2 text-right text-emerald-400">{money(r.revenueCents)}</td>
                      <td className="py-2 text-right">{roas == null ? '—' : `${roas.toFixed(1)}x`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Recommendations">
        {recs.length === 0 ? <EmptyRow>No recommendations — import more Google Ads data to generate them.</EmptyRow> : (
          <ul className="space-y-2">
            {recs.map((r) => (
              <li key={r.id} className="rounded-lg border border-gray-800 bg-gray-950 p-3">
                <div className="flex items-center gap-2">
                  <StatusChip status={r.severity === 'warn' ? 'needs_review' : 'suggested'} />
                  <span className="text-sm font-semibold">{r.title}</span>
                </div>
                <p className="mt-1 text-xs text-gray-400">{r.detail}</p>
                <p className="mt-1 text-xs text-gray-500">{r.action}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Search terms">
        {terms.length === 0 ? <EmptyRow>No search terms imported yet.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Term</th>
                  <th className="pb-2 text-right">Spend</th>
                  <th className="pb-2 text-right">Clicks</th>
                  <th className="pb-2 text-right">Conv.</th>
                  <th className="pb-2 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {terms.map((t) => (
                  <tr key={t.id} className="border-t border-gray-800">
                    <td className="py-2">{t.term}{t.serviceCategory ? <span className="ml-2 text-xs text-gray-500">{label(t.serviceCategory)}</span> : null}</td>
                    <td className="py-2 text-right">{money(t.spendCents)}</td>
                    <td className="py-2 text-right">{t.clicks}</td>
                    <td className="py-2 text-right">{t.conversions}</td>
                    <td className="py-2 text-right text-emerald-400">{money(t.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Import metrics (manual)">
        <form action={importAdMetricAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Service category</span>
            <select name="serviceCategory" className={inputClass} defaultValue="general">
              {SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{SERVICE_CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Date</span>
            <input type="date" name="statDate" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Spend ($)</span>
            <input type="text" inputMode="decimal" name="spend" placeholder="0.00" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Impressions</span>
            <input type="text" inputMode="numeric" name="impressions" placeholder="0" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Clicks</span>
            <input type="text" inputMode="numeric" name="clicks" placeholder="0" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Conversions</span>
            <input type="text" inputMode="numeric" name="conversions" placeholder="0" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Revenue ($)</span>
            <input type="text" inputMode="decimal" name="revenue" placeholder="0.00" className={inputClass} />
          </label>
          <div className="flex items-end">
            <button type="submit" className={primaryBtn}>Save daily metric</button>
          </div>
        </form>
        <p className="mt-2 text-xs text-gray-500">Idempotent per service category + date — re-importing the same day overwrites that row.</p>
      </Section>
    </MarketingShell>
  )
}
