import Link from 'next/link'
import { getCheckInMetrics } from '@/apps/dealer-checkin/db'
import { getDealerInvoiceOverview } from '@/apps/dealer-checkin/overview'
import QueueControls from './QueueControls'

export const dynamic = 'force-dynamic'

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export default async function DealerCheckInAdminPage() {
  const [m, overview] = await Promise.all([getCheckInMetrics(), getDealerInvoiceOverview()])

  const cards: Array<{ label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' }> = [
    { label: 'Check-ins today', value: String(m.today) },
    { label: 'Total check-ins', value: String(m.total), sub: `${m.approved} approved` },
    { label: 'Avg scan time', value: fmtMs(m.avgScanDurationMs), sub: 'camera → confirm' },
    { label: 'Avg QB latency', value: fmtMs(m.avgQbLatencyMs), sub: 'invoice write' },
    { label: 'Duplicate rate', value: m.duplicateRatePct == null ? '—' : `${m.duplicateRatePct}%`, sub: `${m.duplicateSkipped} blocked`, tone: (m.duplicateRatePct ?? 0) > 10 ? 'warn' : 'good' },
    { label: 'New-vehicle prompts', value: String(m.pricingPrompted), sub: '$125 decisions' },
    { label: 'Invoices synced', value: String(m.synced), tone: 'good' },
    { label: 'Queued (QB down)', value: String(m.queued), sub: 'awaiting retry', tone: m.queued > 0 ? 'warn' : 'good' },
    { label: 'Errors', value: String(m.errors), tone: m.errors > 0 ? 'bad' : 'good' },
  ]

  const toneClass = (t?: string) =>
    t === 'good' ? 'text-green-400' : t === 'warn' ? 'text-amber-400' : t === 'bad' ? 'text-red-400' : 'text-white'

  return (
    <main className="min-h-screen bg-gray-950 px-6 pt-10 pb-16">
      <div className="max-w-3xl mx-auto">
        <Link href="/admin" className="text-gray-500 text-sm block mb-6 hover:text-gray-300">← Admin</Link>
        <h1 className="text-2xl font-bold text-white mb-1">Dealer Check-In</h1>
        <p className="text-gray-500 text-sm mb-8">Live operational metrics for production check-ins.</p>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
          {cards.map((c) => (
            <div key={c.label} className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
              <p className="text-gray-500 text-xs uppercase tracking-widest">{c.label}</p>
              <p className={`text-2xl font-bold mt-1 ${toneClass(c.tone)}`}>{c.value}</p>
              {c.sub && <p className="text-gray-600 text-xs mt-0.5">{c.sub}</p>}
            </div>
          ))}
        </div>

        {/* Live dealer invoices (read from QuickBooks) */}
        <div className="mb-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest">Open Dealer Invoices</h2>
            <span className="text-gray-600 text-xs uppercase tracking-widest">{overview.environment} · live</span>
          </div>
          {!overview.connected ? (
            <p className="text-gray-500 text-sm">QuickBooks not connected.</p>
          ) : overview.dealers.length === 0 ? (
            <p className="text-gray-500 text-sm">No dealers mapped yet.</p>
          ) : (
            <div className="space-y-3">
              {overview.dealers.map((d) => (
                <div key={d.qbCustomerId} className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
                  <div className="flex items-baseline justify-between">
                    <p className="text-white font-semibold">{d.dealer}</p>
                    <p className="text-gray-400 text-sm">{money(d.openTotal)} · {d.openVehicles} vehicle{d.openVehicles === 1 ? '' : 's'}</p>
                  </div>
                  {d.openInvoices.length === 0 ? (
                    <p className="text-gray-600 text-sm mt-1">No open invoices</p>
                  ) : (
                    <div className="mt-2 space-y-1">
                      {d.openInvoices.map((inv) => (
                        <div key={inv.id} className="flex items-center justify-between text-sm">
                          <span className="text-gray-300">#{inv.number ?? inv.id} · {inv.vehicles} veh</span>
                          <span className="flex items-center gap-2">
                            <span className="text-gray-300">{money(inv.total)}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${inv.sent ? 'bg-amber-500/15 text-amber-400' : 'bg-green-500/15 text-green-400'}`}>
                              {inv.sent ? 'sent' : 'open'}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <QueueControls initialQueued={m.queued} />
      </div>
    </main>
  )
}
