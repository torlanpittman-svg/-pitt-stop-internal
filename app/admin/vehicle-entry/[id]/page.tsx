import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getVehicleEntry } from '@/apps/vehicle-entry/db'
import StatusChanger from './StatusChanger'

function fmt(d: Date | string) {
  return new Date(d).toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  })
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-4 items-baseline py-2 border-b border-gray-700/50 last:border-0">
      <span className="w-28 shrink-0 text-gray-500 text-sm">{label}</span>
      <span className={`text-sm font-medium ${value ? 'text-white' : 'text-gray-600 italic'}`}>
        {value ?? '—'}
      </span>
    </div>
  )
}

function ConfBar({ field, value }: { field: string; value: number | undefined }) {
  const pct = Math.round((value ?? 0) * 100)
  const color = pct >= 85 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-gray-400 text-xs">{field}</span>
      <div className="flex-1 bg-gray-700 rounded-full h-2 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right text-gray-400 text-xs">{pct}%</span>
    </div>
  )
}

export default async function AdminVehicleEntryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const entry = await getVehicleEntry(id)
  if (!entry) return notFound()

  const conf = (entry.ocrConfidence ?? {}) as Record<string, number>

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/admin" className="text-gray-500 hover:text-white transition-colors">Admin</Link>
        <span className="text-gray-700">›</span>
        <Link href="/admin/vehicle-entry" className="text-gray-500 hover:text-white transition-colors">
          Vehicle Entries
        </Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-400 font-mono text-xs">{id.slice(0, 8)}…</span>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">
            {[entry.year, entry.make, entry.model].filter(Boolean).join(' ') || 'Untitled Entry'}
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Scanned {fmt(entry.createdAt)}
            {entry.wasCorrected && (
              <span className="ml-2 text-yellow-500">· employee corrected</span>
            )}
          </p>
        </div>
      </div>

      {/* Photo */}
      <div className="rounded-2xl overflow-hidden bg-gray-900 mb-6 aspect-[4/3]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/vehicle-entry/entries/${id}/photo`}
          alt="Key tag photo"
          className="w-full h-full object-cover"
        />
      </div>

      {/* Fields */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 mb-4">
        <h2 className="text-white font-semibold mb-3">Vehicle Data</h2>
        <Row label="Year"    value={entry.year}        />
        <Row label="Make"    value={entry.make}        />
        <Row label="Model"   value={entry.model}       />
        <Row label="Color"   value={entry.color === 'Other' ? `Other (${entry.customColor ?? ''})` : entry.color} />
        <Row label="Stock #" value={entry.stockNumber} />
      </div>

      {/* OCR confidence */}
      {Object.keys(conf).length > 0 && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 mb-4">
          <h2 className="text-white font-semibold mb-3">OCR Confidence</h2>
          <div className="space-y-2.5">
            <ConfBar field="Year"     value={conf.year}        />
            <ConfBar field="Make"     value={conf.make}        />
            <ConfBar field="Model"    value={conf.model}       />
            <ConfBar field="Color"    value={conf.color}       />
            <ConfBar field="Stock #"  value={conf.stockNumber} />
          </div>
        </div>
      )}

      {/* Status */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 mb-4">
        <h2 className="text-white font-semibold mb-3">Status</h2>
        <StatusChanger entryId={id} currentStatus={entry.status} />
      </div>

      {/* Metadata */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 mb-4">
        <h2 className="text-white font-semibold mb-3">Metadata</h2>
        <Row label="Entry ID"  value={entry.id}                              />
        <Row label="Created"   value={fmt(entry.createdAt)}                  />
        <Row label="Updated"   value={fmt(entry.updatedAt)}                  />
        <Row label="Corrected" value={entry.wasCorrected ? 'Yes' : 'No'}    />
        <Row label="QB Invoice" value={entry.quickbooksInvoiceId ?? 'None'} />
      </div>

      {/* Raw OCR (collapsible via details/summary) */}
      {entry.rawOcrResponse != null && (
        <details className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden mb-4">
          <summary className="px-5 py-4 text-white font-semibold cursor-pointer select-none hover:bg-gray-750 transition-colors">
            Raw OCR Response ▾
          </summary>
          <pre className="px-5 pb-5 text-gray-400 text-xs overflow-x-auto leading-relaxed">
            {JSON.stringify(entry.rawOcrResponse as Record<string, unknown>, null, 2)}
          </pre>
        </details>
      )}

      <div className="pt-2">
        <Link
          href="/admin/vehicle-entry"
          className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          ← Back to all entries
        </Link>
      </div>
    </main>
  )
}
