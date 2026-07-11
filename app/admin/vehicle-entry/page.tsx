import Link from 'next/link'
import { listVehicleEntries } from '@/apps/vehicle-entry/db'

export const dynamic = 'force-dynamic'

const STATUS_COLORS: Record<string, string> = {
  ready_for_quickbooks: 'bg-blue-900/60 text-blue-300 border-blue-700',
  pending_quickbooks:   'bg-yellow-900/60 text-yellow-300 border-yellow-700',
  quickbooks_updated:   'bg-green-900/60 text-green-300 border-green-700',
  quickbooks_error:     'bg-red-900/60 text-red-300 border-red-700',
  needs_review:         'bg-orange-900/60 text-orange-300 border-orange-700',
  confirmed:            'bg-green-900/60 text-green-300 border-green-700',
  draft:                'bg-gray-800 text-gray-400 border-gray-600',
}

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'bg-gray-800 text-gray-400 border-gray-600'
  return (
    <span className={`inline-flex items-center border rounded-lg px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function fmt(d: Date | string) {
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export default async function AdminVehicleEntryPage() {
  const entries = await listVehicleEntries(200)

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/admin" className="text-gray-500 hover:text-white transition-colors">Admin</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300">Vehicle Entries</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Vehicle Entries</h1>
          <p className="text-gray-500 mt-0.5 text-sm">{entries.length} total submission{entries.length !== 1 ? 's' : ''}</p>
        </div>
        <Link
          href="/vehicle-entry"
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
        >
          + New Entry
        </Link>
      </div>

      {entries.length === 0 ? (
        <div className="bg-gray-800 border border-gray-700 rounded-xl px-6 py-16 text-center">
          <p className="text-gray-400 text-lg font-medium">No entries yet</p>
          <p className="text-gray-600 text-sm mt-2">Scan a key tag in Vehicle Entry to create the first one.</p>
          <Link
            href="/vehicle-entry"
            className="inline-block mt-5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
          >
            Open Vehicle Entry →
          </Link>
        </div>
      ) : (
        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
          <div className="hidden md:grid grid-cols-[1fr_2fr_1fr_1fr_1.5fr_2rem] gap-4 px-5 py-3 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            <span>Time</span>
            <span>Vehicle</span>
            <span>Color</span>
            <span>Stock #</span>
            <span>Status</span>
            <span />
          </div>

          <div className="divide-y divide-gray-700/60">
            {entries.map((e) => (
              <Link
                key={e.id}
                href={`/admin/vehicle-entry/${e.id}`}
                className="flex flex-col md:grid md:grid-cols-[1fr_2fr_1fr_1fr_1.5fr_2rem] gap-2 md:gap-4 items-start md:items-center px-5 py-4 hover:bg-gray-750 transition-colors group"
              >
                <span className="text-gray-400 text-sm">{fmt(e.createdAt)}</span>
                <span className="text-white font-medium">
                  {[e.year, e.make, e.model].filter(Boolean).join(' ') || '—'}
                  {e.wasCorrected && (
                    <span className="ml-2 text-yellow-500 text-xs">edited</span>
                  )}
                </span>
                <span className="text-gray-300 text-sm">{e.color ?? '—'}</span>
                <span className="text-gray-300 font-mono text-sm">{e.stockNumber ?? '—'}</span>
                <StatusBadge status={e.status} />
                <span className="text-gray-600 group-hover:text-gray-300 transition-colors text-lg md:text-right">›</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
