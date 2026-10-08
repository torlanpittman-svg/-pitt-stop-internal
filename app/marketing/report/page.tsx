import { requireMarketingManager, MarketingShell, Section, StatTile, EmptyRow } from '@/app/marketing/_components'
import { money, bigMoney, count, shortDate } from '@/app/lib/format'
import { weeklyReport, reportForRange } from '@/apps/marketing/report'
import { SERVICE_CATEGORY_LABELS, REPORT_CHANNEL_LABELS } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const svcLabel = (cat: string) => SERVICE_CATEGORY_LABELS[cat as keyof typeof SERVICE_CATEGORY_LABELS] ?? cat
const roasStr = (r: number | null) => (r == null ? '—' : `${r.toFixed(1)}x`)
const YMD = /^\d{4}-\d{2}-\d{2}$/
const parseYmd = (s: string | undefined): Date | null => {
  if (!s || !YMD.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

export default async function WeeklyReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await requireMarketingManager('/marketing/report')
  const { from: fromRaw, to: toRaw } = await searchParams
  const from = parseYmd(fromRaw)
  const toDay = parseYmd(toRaw)
  // Valid custom range → report that window vs the prior equal-length window; else default to this week.
  const customRange = from && toDay && from.getTime() <= toDay.getTime()
  const to = customRange ? new Date(toDay!.getTime() + 86_400_000 - 1) : null // inclusive end-of-day
  const { current, previous } = customRange
    ? await reportForRange(from!, to!)
    : await weeklyReport(new Date())
  const comparisonLabel = customRange ? 'prior equal period' : 'last wk'

  // Recommended action: shift toward the highest-ROAS service, away from the lowest. ROAS here is
  // canonical INVOICED completed-job revenue ÷ Google Ads spend — a revenue-return signal, NOT profit
  // (shop costs aren't included) and not collected cash.
  let recommendation = 'Import Google Ads data and run a campaign to populate this report.'
  const scored = current.byService.filter((s) => s.roas != null) as Array<typeof current.byService[number] & { roas: number }>
  if (scored.length >= 2) {
    const sorted = [...scored].sort((a, b) => b.roas - a.roas)
    const best = sorted[0]
    const worst = sorted[sorted.length - 1]
    if (best.serviceCategory !== worst.serviceCategory) {
      recommendation = `${svcLabel(best.serviceCategory)} is returning ${roasStr(best.roas)} while ${svcLabel(worst.serviceCategory)} is at ${roasStr(worst.roas)} — consider shifting budget toward ${svcLabel(best.serviceCategory)}.`
    }
  } else if (scored.length === 1) {
    recommendation = `${svcLabel(scored[0].serviceCategory)} is your only service with spend this week (${roasStr(scored[0].roas)} ROAS) — add more services or campaigns to compare performance.`
  }

  return (
    <MarketingShell active="/marketing/report" title="Weekly Marketing Report">
      <p className="mb-3 text-sm text-gray-500">
        {customRange ? 'Range' : 'Week'} of {shortDate(current.range.from)} → {shortDate(current.range.to)} · compared to the {comparisonLabel}.
      </p>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2 text-xs text-gray-500">
        <label>From
          <input type="date" name="from" defaultValue={current.range.from} className="ml-1 rounded-lg border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-white" />
        </label>
        <label>To
          <input type="date" name="to" defaultValue={current.range.to} className="ml-1 rounded-lg border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-white" />
        </label>
        <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Apply range</button>
        {customRange && <a href="/marketing/report" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700">This week</a>}
      </form>

      {current.isEmpty && (
        <div className="mb-5">
          <EmptyRow>No marketing activity recorded in this range yet.</EmptyRow>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Spend" value={bigMoney(current.spendCents)} note={`vs ${bigMoney(previous.spendCents)} ${comparisonLabel}`} />
        <StatTile label="Attributed revenue" value={bigMoney(current.invoicedRevenueCents)} note="invoiced · completed jobs" />
        <StatTile label="ROAS" value={roasStr(current.roas)} note={`vs ${roasStr(previous.roas)} ${comparisonLabel}`} />
        <StatTile label="Leads" value={count(current.leads)} note={`vs ${count(previous.leads)} ${comparisonLabel}`} />
        <StatTile label="Completed jobs" value={count(current.completedJobs)} note={`vs ${count(previous.completedJobs)} ${comparisonLabel}`} />
      </div>

      <p className="mb-5 max-w-3xl text-xs text-gray-500">
        Attributed revenue is the <span className="text-gray-300">invoiced</span> value of unique completed jobs linked to a marketing touch
        (collected/paid is not tracked locally). Google Ads below shows the platform&apos;s own reported revenue + conversions —
        those conversions are <span className="text-gray-300">not</span> counted as completed jobs.
      </p>

      <Section title="By service (canonical completed jobs + Google Ads)">
        <p className="mb-3 text-xs text-gray-500">Jobs + invoiced revenue are canonical (classified from each job&apos;s own services). Ad spend + ads-reported revenue come from Google Ads; ROAS = invoiced ÷ spend.</p>
        {current.byService.length === 0 ? <EmptyRow>No service-level activity this week.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Service</th>
                  <th className="pb-2 text-right">Jobs</th>
                  <th className="pb-2 text-right">Invoiced</th>
                  <th className="pb-2 text-right">Ad spend</th>
                  <th className="pb-2 text-right">Ads rev.</th>
                  <th className="pb-2 text-right">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {current.byService.map((s) => (
                  <tr key={s.serviceCategory} className="border-t border-gray-800">
                    <td className="py-2">{svcLabel(s.serviceCategory)}</td>
                    <td className="py-2 text-right">{s.completedJobs}</td>
                    <td className="py-2 text-right text-emerald-400">{money(s.invoicedRevenueCents)}</td>
                    <td className="py-2 text-right">{money(s.spendCents)}</td>
                    <td className="py-2 text-right text-gray-400">{money(s.adReportedRevenueCents)}</td>
                    <td className="py-2 text-right">{roasStr(s.roas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="By channel">
        {current.byChannel.length === 0 ? <EmptyRow>No channel activity this week.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Channel</th>
                  <th className="pb-2 text-right">Spend</th>
                  <th className="pb-2 text-right">Revenue</th>
                  <th className="pb-2 text-right">Leads</th>
                </tr>
              </thead>
              <tbody>
                {current.byChannel.map((c) => (
                  <tr key={c.channel} className="border-t border-gray-800">
                    <td className="py-2">{REPORT_CHANNEL_LABELS[c.channel]}</td>
                    <td className="py-2 text-right">{money(c.spendCents)}</td>
                    <td className="py-2 text-right text-emerald-400">{money(c.revenueCents)}</td>
                    <td className="py-2 text-right">{c.leads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Recommended action">
        <p className="text-sm text-gray-300">{recommendation}</p>
      </Section>
    </MarketingShell>
  )
}
