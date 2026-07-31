'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export interface ScanDTO {
  id: string
  createdAt: string
  dealer: string
  stockNumber: string | null
  vehicle: string
  invoiceNumber: string | null
  status: string
  syncStatus: string | null
  photoUrl: string | null
  imageDeleted: boolean
}

function statusTone(s: string): string {
  if (s === 'approved') return 'bg-green-500/15 text-green-400'
  if (s === 'error') return 'bg-red-500/15 text-red-400'
  if (s === 'duplicate_skipped') return 'bg-amber-500/15 text-amber-400'
  return 'bg-gray-700/40 text-gray-400'
}

export default function HistoryList({ scans }: { scans: ScanDTO[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function markReviewed(id: string) {
    if (busy) return
    setBusy(id)
    try {
      await fetch(`/api/dealer-checkin/mark-reviewed?id=${id}`, { method: 'POST' })
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  if (scans.length === 0) return <p className="text-gray-500 text-sm">No scans yet.</p>

  return (
    <div className="space-y-3">
      {scans.map((s) => (
        <div key={s.id} className="rounded-2xl bg-gray-900 border border-gray-800 p-3 flex gap-3">
          {/* Original tag image (click to view full) */}
          <div className="w-16 h-20 shrink-0 rounded-lg bg-gray-950 border border-gray-800 overflow-hidden flex items-center justify-center">
            {s.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <a href={s.photoUrl} target="_blank" rel="noreferrer"><img src={s.photoUrl} alt="tag" className="w-16 h-20 object-cover" /></a>
            ) : (
              <span className="text-gray-700 text-[10px] text-center px-1">{s.imageDeleted ? 'image\npurged' : 'no image'}</span>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-white font-semibold font-mono truncate">{s.stockNumber ?? '—'}</p>
              <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${statusTone(s.status)}`}>{s.status}</span>
            </div>
            <p className="text-gray-400 text-sm truncate">{s.vehicle || '—'}</p>
            <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
              <span>{s.dealer}</span>
              {s.invoiceNumber && <span>· inv #{s.invoiceNumber}</span>}
              {s.syncStatus && <span>· {s.syncStatus}</span>}
              <span>· {new Date(s.createdAt).toLocaleString()}</span>
            </div>
            {s.photoUrl && (
              <button
                onClick={() => markReviewed(s.id)}
                disabled={busy === s.id}
                className="mt-2 text-xs px-3 py-1 rounded-full border border-gray-700 text-gray-300 disabled:opacity-40"
              >
                {busy === s.id ? 'Removing…' : 'Mark reviewed (delete image)'}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
