import { requireMarketingManager, MarketingShell, Section, StatTile, StatusChip, EmptyRow, FlashBanner } from '@/app/marketing/_components'
import { AdDataNotice } from '@/app/marketing/AdDataNotice'
import { money } from '@/app/lib/format'
import { listSearchTerms } from '@/apps/marketing/ads'
import { loadAdReporting } from '@/apps/marketing/ads-reporting'
import { ACCOUNT_TIME_ZONE, monthToDateRange } from '@/apps/marketing/ad-dates'
import { buildAdRecommendations } from '@/apps/marketing/recommendations'
import { importAdMetricAction, importSearchTermAction } from '@/app/marketing/actions'
import { SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const label = (cat: string) => SERVICE_CATEGORY_LABELS[cat as keyof typeof SERVICE_CATEGORY_LABELS] ?? cat
/** Neutral numeric assigned value (up to 2 decimals), e.g. "6.54" — NOT dollars. */
const assignedValue = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 2 }))

const inputClass = 'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm'
const primaryBtn = 'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500'

export default async function GoogleAdsPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  await requireMarketingManager('/marketing/google-ads')
  const { err } = await searchParams
  // Month-to-date in the ACCOUNT timezone, so the queried range equals the displayed range.
  const { from, to } = monthToDateRange(new Date())

  const ad = await loadAdReporting({ from, to })
  const cat = ad.byCategory
  const unavailable = ad.meta.status === 'unavailable'
  const live = ad.meta.status === 'live'
  const manual = ad.meta.status === 'manual'
  const terms = await listSearchTerms()
  const recs = buildAdRecommendations({ byCategory: cat, searchTerms: terms, source: live ? 'live' : 'manual' })

  const totalSpend = cat.reduce((s, r) => s + r.spendCents, 0)
  // Live: Google-ASSIGNED conversion value shown as a NEUTRAL number. Manual: owner-entered dollars.
  const totalConvValue = cat.reduce((s, r) => s + (r.conversionValue ?? r.revenueCents / 100), 0)
  const totalRevenueCents = cat.reduce((s, r) => s + r.revenueCents, 0)
  const ratioPerSpend = totalSpend > 0 ? totalRevenueCents / totalSpend : null

  return (
    <MarketingShell active="/marketing/google-ads" title="Google Ads">
      <FlashBanner err={err} />
      <p className="mb-4 text-sm text-gray-500">Month to date ({from} → {to}, {ACCOUNT_TIME_ZONE} time). These are Google Ads platform figures (spend + a Google-assigned conversion value) — not Pitt Stop collected cash, and ad conversions are not counted as completed jobs. The connection status below shows whether they are live or manually entered.</p>

      <Section title="Connection status">
        <AdDataNotice meta={ad.meta} />
        {live && <p className="mt-2 text-xs text-gray-500">Live figures come straight from the Google Ads API for this account; the manual-entry form below is hidden while the API is connected (so data is never double-counted).</p>}
      </Section>

      <Section title="Performance by service (month to date)">
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label="Total spend" value={unavailable ? 'Unavailable' : money(totalSpend)} />
          <StatTile
            label={live ? 'Conversion value' : 'Revenue'}
            value={unavailable ? 'Unavailable' : live ? assignedValue(totalConvValue) : money(totalRevenueCents)}
            note={live ? 'Google-assigned value, not revenue' : undefined}
          />
          <StatTile
            label={live ? 'Value ÷ spend' : 'ROAS'}
            value={unavailable ? 'Unavailable' : ratioPerSpend == null ? '—' : `${ratioPerSpend.toFixed(1)}x`}
            note={live ? 'not verified ROAS' : undefined}
          />
        </div>
        {unavailable ? <EmptyRow>Google Ads metrics are not available right now — see the connection status above.</EmptyRow> : cat.length === 0 ? <EmptyRow>No metrics for this period yet. {manual ? 'Import daily metrics below.' : 'Google Ads reported no campaign activity in this range.'}</EmptyRow> : (
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
                  <th className="pb-2 text-right">{live ? 'Conv. value' : 'Revenue'}</th>
                  <th className="pb-2 text-right">{live ? 'Value ÷ spend' : 'ROAS'}</th>
                </tr>
              </thead>
              <tbody>
                {cat.map((r) => {
                  const ctr = r.impressions > 0 ? (r.clicks / r.impressions) * 100 : null
                  const cpc = r.clicks > 0 ? Math.round(r.spendCents / r.clicks) : null
                  const costPerLead = r.conversions > 0 ? Math.round(r.spendCents / r.conversions) : null
                  const convValue = r.conversionValue ?? r.revenueCents / 100
                  const ratio = r.spendCents > 0 ? r.revenueCents / r.spendCents : null
                  return (
                    <tr key={r.serviceCategory} className="border-t border-gray-800">
                      <td className="py-2">{label(r.serviceCategory)}</td>
                      <td className="py-2 text-right">{money(r.spendCents)}</td>
                      <td className="py-2 text-right">{r.impressions.toLocaleString('en-US')}</td>
                      <td className="py-2 text-right">{r.clicks.toLocaleString('en-US')}</td>
                      <td className="py-2 text-right">{ctr == null ? '—' : `${ctr.toFixed(1)}%`}</td>
                      <td className="py-2 text-right">{cpc == null ? '—' : money(cpc)}</td>
                      <td className="py-2 text-right">{r.conversions.toLocaleString('en-US', { maximumFractionDigits: 1 })}</td>
                      <td className="py-2 text-right">{costPerLead == null ? '—' : money(costPerLead)}</td>
                      <td className={`py-2 text-right${live ? '' : ' text-emerald-400'}`}>{live ? assignedValue(convValue) : money(r.revenueCents)}</td>
                      <td className="py-2 text-right">{ratio == null ? '—' : `${ratio.toFixed(1)}x`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {live && (
          <p className="mt-2 text-xs text-gray-500">&ldquo;Conversion value&rdquo; is a Google-assigned value (neutral units), not dollars of collected or invoiced revenue; &ldquo;value ÷ spend&rdquo; is a directional ratio, not verified ROAS.{cat.some((r) => r.serviceCategory === 'other') ? ' “Other” holds campaigns with no explicit service-category mapping — map campaign ids via GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON to split them out (categories are never guessed from names).' : ''}</p>
        )}
      </Section>

      <Section title="Recommendations">
        {recs.length === 0 ? <EmptyRow>{manual ? 'No recommendations — import more Google Ads data to generate them.' : 'No negative-keyword suggestions from your manually-entered search terms right now. Budget/revenue advice is not generated from Google-assigned conversion values.'}</EmptyRow> : (
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
        <p className="mb-3 text-xs text-gray-500">Search terms are <span className="text-gray-300">manually entered</span> below and drive the recommendations — they are not synced from the Google Ads API even when the reporting connection is live.</p>
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

      {manual && (
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
      )}

      <Section title="Add search term (manual)">
        <p className="mb-3 text-xs text-gray-500">Enter the search terms Google Ads shows are triggering your ads, with their spend/clicks/conversions, to feed the recommendations below. No budgets are changed — this is data entry only.</p>
        <form action={importSearchTermAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block sm:col-span-2 lg:col-span-1">
            <span className="mb-1 block text-xs uppercase text-gray-500">Search term</span>
            <input type="text" name="term" placeholder="ceramic coating near me" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Service category</span>
            <select name="serviceCategory" className={inputClass} defaultValue="">
              <option value="">— Unspecified —</option>
              {SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{SERVICE_CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Period (e.g. 2026-10)</span>
            <input type="text" name="statPeriod" placeholder="2026-10" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase text-gray-500">Spend ($)</span>
            <input type="text" inputMode="decimal" name="spend" placeholder="0.00" className={inputClass} />
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
            <button type="submit" className={primaryBtn}>Save search term</button>
          </div>
        </form>
      </Section>
    </MarketingShell>
  )
}
