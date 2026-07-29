import Link from 'next/link'
import { getCheckInMetrics } from '@/apps/dealer-checkin/db'
import QueueControls from './QueueControls'

export const dynamic = 'force-dynamic'

function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export default async function DealerCheckInAdminPage() {
  const m = await getCheckInMetrics()

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

        <QueueControls initialQueued={m.queued} />
      </div>
    </main>
  )
}
