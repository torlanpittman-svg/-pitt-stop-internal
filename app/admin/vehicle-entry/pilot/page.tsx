import Link from 'next/link'
import PilotDashboard from './PilotDashboard'

export const dynamic = 'force-dynamic'

const FILTER_OPTIONS = [
  { label: 'Pilot',      value: 'pilot' },
  { label: 'Production', value: 'production' },
  { label: 'Test',       value: 'test' },
  { label: 'All',        value: 'all' },
]

export default async function PilotPage({
  searchParams,
}: {
  searchParams: Promise<{ dt?: string }>
}) {
  const { dt } = await searchParams
  const activeFilter = FILTER_OPTIONS.some(o => o.value === dt) ? dt! : 'pilot'
  const isPilotMode = process.env.PILOT_MODE === 'true'

  return (
    <main className="max-w-5xl mx-auto px-6 py-10">
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/admin" className="text-gray-500 hover:text-white transition-colors">Admin</Link>
        <span className="text-gray-700">›</span>
        <Link href="/admin/vehicle-entry" className="text-gray-500 hover:text-white transition-colors">Vehicle Entries</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300">Pilot Dashboard</span>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Pilot Dashboard</h1>
          <p className="text-gray-500 mt-0.5 text-sm">Live view of scan activity</p>
        </div>
        {isPilotMode && (
          <span className="bg-yellow-900/60 border border-yellow-700 text-yellow-300 text-xs font-semibold px-3 py-1.5 rounded-full">
            TEST MODE — Mock QuickBooks
          </span>
        )}
      </div>

      {/* ── Data type filter tabs ── */}
      <div className="flex items-center gap-1 mb-6">
        {FILTER_OPTIONS.map(opt => (
          <Link
            key={opt.value}
            href={`/admin/vehicle-entry/pilot?dt=${opt.value}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${activeFilter === opt.value
                ? 'bg-gray-700 text-white'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}
          >
            {opt.label}
          </Link>
        ))}
      </div>

      <PilotDashboard dataTypeFilter={activeFilter} />
    </main>
  )
}
