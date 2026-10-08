import { requireMarketingManager, MarketingShell, Section, StatTile, EmptyRow } from '@/app/marketing/_components'
import { money, bigMoney, count } from '@/app/lib/format'
import { attributionBySource, leadsBySource } from '@/apps/marketing/attribution'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ymd = (d: Date) => d.toISOString().slice(0, 10)
function monthRange(now: Date) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59))
  return { from, to }
}

const srcLabel = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export default async function AttributionPage() {
  await requireMarketingManager('/marketing/attribution')
  const now = new Date()
  const { from, to } = monthRange(now)

  const bySource = await attributionBySource({ from, to })
  const leads = await leadsBySource({ from, to })

  const totalRevenue = bySource.reduce((s, r) => s + r.revenueCents, 0)
  const totalDirect = bySource.reduce((s, r) => s + r.direct, 0)
  const totalAssisted = bySource.reduce((s, r) => s + r.assisted, 0)
  const totalUnknown = bySource.reduce((s, r) => s + r.unknown, 0)

  return (
    <MarketingShell active="/marketing/attribution" title="Attribution">
      <p className="mb-4 text-sm text-gray-500">This month ({ymd(from)} → {ymd(now)}).</p>

      <p className="mb-5 max-w-3xl text-sm text-gray-400">
        Each row is a <span className="text-gray-200">unique completed job</span> (service order) credited to the marketing touch
        that produced it — counted ONCE even if it had several touches. Revenue is the canonical <span className="text-gray-200">invoiced</span> value
        of that job (collected/paid is not tracked locally and never invented). The representative touch is chosen
        last-touch first, then by confidence: <span className="text-gray-200">direct</span> (full chain from touch to completed job),
        <span className="text-gray-200"> assisted</span> (a plausible touch), or <span className="text-gray-200">unknown</span> — a source we
        can&apos;t establish stays unknown and is never guessed. Unverified touches with no linked completed order never appear here.
      </p>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Attributed revenue" value={bigMoney(totalRevenue)} note="invoiced" />
        <StatTile label="Direct" value={count(totalDirect)} />
        <StatTile label="Assisted" value={count(totalAssisted)} />
        <StatTile label="Unknown" value={count(totalUnknown)} />
      </div>

      <Section title="Revenue by source">
        {bySource.length === 0 ? <EmptyRow>No attribution recorded this month yet.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Source</th>
                  <th className="pb-2 text-right">Count</th>
                  <th className="pb-2 text-right">Revenue</th>
                  <th className="pb-2 text-right">Direct</th>
                  <th className="pb-2 text-right">Assisted</th>
                  <th className="pb-2 text-right">Unknown</th>
                </tr>
              </thead>
              <tbody>
                {bySource.map((r) => (
                  <tr key={r.source} className="border-t border-gray-800">
                    <td className="py-2">{srcLabel(r.source)}</td>
                    <td className="py-2 text-right">{r.count}</td>
                    <td className="py-2 text-right text-emerald-400">{money(r.revenueCents)}</td>
                    <td className="py-2 text-right">{r.direct}</td>
                    <td className="py-2 text-right">{r.assisted}</td>
                    <td className="py-2 text-right">{r.unknown}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Leads by source">
        {leads.length === 0 ? <EmptyRow>No leads recorded this month yet.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Source</th>
                  <th className="pb-2 text-right">Count</th>
                  <th className="pb-2 text-right">Attributed revenue</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.source} className="border-t border-gray-800">
                    <td className="py-2">{srcLabel(l.source)}</td>
                    <td className="py-2 text-right">{l.count}</td>
                    <td className="py-2 text-right text-emerald-400">{money(l.attributedRevenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </MarketingShell>
  )
}
