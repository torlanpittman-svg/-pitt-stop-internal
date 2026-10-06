import { requireMarketingManager, MarketingShell, Section, StatTile, EmptyRow } from '@/app/marketing/_components'
import { money, bigMoney, count, shortDate } from '@/app/lib/format'
import { weeklyReport } from '@/apps/marketing/report'
import { SERVICE_CATEGORY_LABELS, REPORT_CHANNEL_LABELS } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const svcLabel = (cat: string) => SERVICE_CATEGORY_LABELS[cat as keyof typeof SERVICE_CATEGORY_LABELS] ?? cat
const roasStr = (r: number | null) => (r == null ? '—' : `${r.toFixed(1)}x`)

export default async function WeeklyReportPage() {
  await requireMarketingManager('/marketing/report')
  const { current, previous } = await weeklyReport(new Date())

  // Recommended action: shift toward the highest-ROAS service, away from the lowest.
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
      <p className="mb-4 text-sm text-gray-500">
        Week of {shortDate(current.range.from)} → {shortDate(current.range.to)}
      </p>

      {current.isEmpty && (
        <div className="mb-5">
          <EmptyRow>No marketing activity recorded this week yet.</EmptyRow>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Spend" value={bigMoney(current.spendCents)} note={`vs ${bigMoney(previous.spendCents)} last wk`} />
        <StatTile label="Attributed revenue" value={bigMoney(current.attributedRevenueCents)} note={`vs ${bigMoney(previous.attributedRevenueCents)} last wk`} />
        <StatTile label="ROAS" value={roasStr(current.roas)} note={`vs ${roasStr(previous.roas)} last wk`} />
        <StatTile label="Leads" value={count(current.leads)} note={`vs ${count(previous.leads)} last wk`} />
        <StatTile label="Completed jobs" value={count(current.completedJobs)} note={`vs ${count(previous.completedJobs)} last wk`} />
      </div>

      <Section title="By service">
        {current.byService.length === 0 ? <EmptyRow>No service-level activity this week.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Service</th>
                  <th className="pb-2 text-right">Spend</th>
                  <th className="pb-2 text-right">Revenue</th>
                  <th className="pb-2 text-right">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {current.byService.map((s) => (
                  <tr key={s.serviceCategory} className="border-t border-gray-800">
                    <td className="py-2">{svcLabel(s.serviceCategory)}</td>
                    <td className="py-2 text-right">{money(s.spendCents)}</td>
                    <td className="py-2 text-right text-emerald-400">{money(s.revenueCents)}</td>
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
