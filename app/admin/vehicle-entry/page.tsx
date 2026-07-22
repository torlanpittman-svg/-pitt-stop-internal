import Link from 'next/link'
import { getDb } from '@/platform/db'
import { vehicleEntries } from '@/apps/vehicle-entry/schema'
import { desc, eq, sql } from 'drizzle-orm'
import type { VehicleEntryRow } from '@/apps/vehicle-entry/db'

export const dynamic = 'force-dynamic'

const STATUS_COLORS: Record<string, string> = {
  ready_for_quickbooks: 'bg-blue-900/60 text-blue-300 border-blue-700',
  pending_quickbooks:   'bg-yellow-900/60 text-yellow-300 border-yellow-700',
  quickbooks_updated:   'bg-green-900/60 text-green-300 border-green-700',
  quickbooks_error:     'bg-red-900/60 text-red-300 border-red-700',
  needs_review:         'bg-orange-900/60 text-orange-300 border-orange-700',
  pending_invoice_assignment: 'bg-yellow-900/60 text-yellow-300 border-yellow-700',
  confirmed:            'bg-green-900/60 text-green-300 border-green-700',
  draft:                'bg-gray-800 text-gray-400 border-gray-600',
}

const DT_COLORS: Record<string, string> = {
  production: 'bg-green-900/50 text-green-300 border-green-800',
  pilot:      'bg-yellow-900/50 text-yellow-300 border-yellow-800',
  test:       'bg-gray-800 text-gray-400 border-gray-700',
}

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'bg-gray-800 text-gray-400 border-gray-600'
  return (
    <span className={`inline-flex items-center border rounded-lg px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function DataTypeBadge({ dataType }: { dataType: string }) {
  const cls = DT_COLORS[dataType] ?? 'bg-gray-800 text-gray-400 border-gray-700'
  return (
    <span className={`inline-flex items-center border rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {dataType}
    </span>
  )
}

function fmt(d: Date | string) {
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

const FILTER_OPTIONS = [
  { label: 'All',        value: 'all' },
  { label: 'Production', value: 'production' },
  { label: 'Pilot',      value: 'pilot' },
  { label: 'Test',       value: 'test' },
]

export default async function AdminVehicleEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ dt?: string }>
}) {
  const { dt } = await searchParams
  const activeFilter = FILTER_OPTIONS.some(o => o.value === dt) ? dt! : 'all'

  const db = getDb()

  // Counts by data_type
  const countRows = await db
    .select({ dataType: vehicleEntries.dataType, cnt: sql<number>`count(*)` })
    .from(vehicleEntries)
    .groupBy(vehicleEntries.dataType)

  const counts: Record<string, number> = { production: 0, pilot: 0, test: 0 }
  for (const row of countRows) counts[row.dataType] = Number(row.cnt)
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0)

  // Filtered entries — select only columns needed for the list; avoid photo/OCR blobs
  const cols = {
    id:          vehicleEntries.id,
    createdAt:   vehicleEntries.createdAt,
    year:        vehicleEntries.year,
    make:        vehicleEntries.make,
    model:       vehicleEntries.model,
    color:       vehicleEntries.color,
    stockNumber: vehicleEntries.stockNumber,
    status:      vehicleEntries.status,
    dataType:    vehicleEntries.dataType,
    wasCorrected: vehicleEntries.wasCorrected,
  }
  const entries = (activeFilter === 'all'
    ? await db.select(cols).from(vehicleEntries)
        .orderBy(desc(vehicleEntries.createdAt)).limit(200)
    : await db.select(cols).from(vehicleEntries)
        .where(eq(vehicleEntries.dataType, activeFilter))
        .orderBy(desc(vehicleEntries.createdAt))
        .limit(200)
  ) as Pick<VehicleEntryRow, 'id' | 'createdAt' | 'year' | 'make' | 'model' | 'color' | 'stockNumber' | 'status' | 'dataType' | 'wasCorrected'>[]

  const shownCount = activeFilter === 'all' ? totalCount : counts[activeFilter] ?? 0

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/admin" className="text-gray-500 hover:text-white transition-colors">Admin</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300">Vehicle Entries</span>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Vehicle Entries</h1>
          <p className="text-gray-500 mt-0.5 text-sm">{shownCount} {activeFilter === 'all' ? 'total' : activeFilter} submission{shownCount !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/admin/vehicle-entry/ocr-learning"
            className="border border-purple-800 hover:border-purple-600 text-purple-400 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            OCR Learning
          </Link>
          <Link
            href="/admin/vehicle-entry/pilot"
            className="border border-yellow-700 hover:border-yellow-500 text-yellow-300 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            Pilot Dashboard
          </Link>
          <Link
            href="/admin/vehicle-entry/invoices"
            className="border border-gray-600 hover:border-gray-400 text-gray-300 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            Invoice Batches
          </Link>
          <Link
            href="/admin/vehicle-entry/dealerships"
            className="border border-gray-600 hover:border-gray-400 text-gray-300 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            Dealerships
          </Link>
          <Link
            href="/vehicle-entry"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            + New Entry
          </Link>
        </div>
      </div>

      {/* ── Data Type Stats ─────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {(['production','pilot','test'] as const).map(dt => (
          <Link
            key={dt}
            href={`/admin/vehicle-entry?dt=${dt}`}
            className={`rounded-xl border px-4 py-3 flex items-center justify-between transition-colors
              ${activeFilter === dt
                ? dt === 'production' ? 'bg-green-900/30 border-green-700'
                  : dt === 'pilot'   ? 'bg-yellow-900/30 border-yellow-700'
                                     : 'bg-gray-800 border-gray-600'
                : 'bg-gray-900 border-gray-800 hover:border-gray-600'}`}
          >
            <span className={`text-sm font-semibold capitalize
              ${dt === 'production' ? 'text-green-300' : dt === 'pilot' ? 'text-yellow-300' : 'text-gray-400'}`}>
              {dt}
            </span>
            <span className="text-white text-xl font-bold tabular-nums">{counts[dt] ?? 0}</span>
          </Link>
        ))}
      </div>

      {/* ── Filter tabs ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 mb-5">
        {FILTER_OPTIONS.map(opt => (
          <Link
            key={opt.value}
            href={opt.value === 'all' ? '/admin/vehicle-entry' : `/admin/vehicle-entry?dt=${opt.value}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${activeFilter === opt.value
                ? 'bg-gray-700 text-white'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}
          >
            {opt.label}
            {opt.value !== 'all' && (
              <span className="ml-1.5 text-xs opacity-60">{counts[opt.value] ?? 0}</span>
            )}
          </Link>
        ))}
      </div>

      {entries.length === 0 ? (
        <div className="bg-gray-800 border border-gray-700 rounded-xl px-6 py-16 text-center">
          <p className="text-gray-400 text-lg font-medium">No {activeFilter === 'all' ? '' : activeFilter + ' '}entries yet</p>
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
          <div className="hidden md:grid grid-cols-[1fr_2fr_1fr_1fr_1.5fr_5rem_2rem] gap-4 px-5 py-3 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            <span>Time</span>
            <span>Vehicle</span>
            <span>Color</span>
            <span>Stock #</span>
            <span>Status</span>
            <span>Type</span>
            <span />
          </div>

          <div className="divide-y divide-gray-700/60">
            {entries.map((e) => (
              <Link
                key={e.id}
                href={`/admin/vehicle-entry/${e.id}`}
                className="flex flex-col md:grid md:grid-cols-[1fr_2fr_1fr_1fr_1.5fr_5rem_2rem] gap-2 md:gap-4 items-start md:items-center px-5 py-4 hover:bg-gray-750 transition-colors group"
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
                <DataTypeBadge dataType={e.dataType} />
                <span className="text-gray-600 group-hover:text-gray-300 transition-colors text-lg md:text-right">›</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
