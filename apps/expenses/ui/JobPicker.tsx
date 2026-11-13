'use client'
/**
 * Customer-job picker — search by customer name, vehicle, VIN, or job number (server: searchJobsAction).
 * Shared by receipt capture, the manager review card and the job-expense reassign control.
 */
import { useEffect, useRef, useState } from 'react'
import { searchJobsAction } from '@/apps/expenses/job-actions'

export interface PickedJob { id: string; label: string }
interface JobHit { id: string; orderNumber: string; status: string; customerName: string | null; vehicle: string; vin: string | null }
const labelOf = (j: JobHit) => [j.customerName || 'Customer', j.vehicle, j.orderNumber].filter(Boolean).join(' · ')

export default function JobPicker({ value, onChange, disabled = false, placeholder = 'Customer, vehicle, VIN or job #' }: {
  value: PickedJob | null; onChange: (j: PickedJob | null) => void; disabled?: boolean; placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<JobHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) return
    const mine = ++seq.current
    const t = setTimeout(async () => {
      setBusy(true)
      const res = await searchJobsAction(term).catch(() => ({ ok: false, jobs: [] as JobHit[] }))
      if (mine === seq.current) { setHits(res.ok ? res.jobs : []); setBusy(false) }
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-indigo-900/60 bg-indigo-950/20 px-3 py-2">
        <span className="flex-1 min-w-0 text-sm text-indigo-100 break-words">{value.label}</span>
        {!disabled && <button type="button" onClick={() => onChange(null)} className="shrink-0 text-gray-400 text-sm px-2 py-1 min-h-11">Change</button>}
      </div>
    )
  }
  const term = q.trim()
  return (
    <div>
      <input value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value.trim().length < 2) { seq.current++; setHits(null); setBusy(false) } }}
        disabled={disabled} placeholder={placeholder} autoComplete="off" spellCheck={false} aria-label="Search customer jobs"
        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
      <div aria-live="polite">
        {term.length >= 2 && busy && hits === null && <p className="text-gray-500 text-xs mt-1">Searching…</p>}
        {term.length >= 2 && hits !== null && hits.length === 0 && !busy && <p className="text-gray-500 text-xs mt-1">No jobs match “{term}”.</p>}
      </div>
      {term.length >= 2 && hits && hits.length > 0 && (
        <ul className="mt-2 space-y-1">
          {hits.map((j) => (
            <li key={j.id}>
              <button type="button" onClick={() => { onChange({ id: j.id, label: labelOf(j) }); setQ(''); setHits(null) }}
                className="w-full text-left rounded-xl bg-gray-800 border border-gray-700 px-3 py-3 active:bg-gray-700">
                <span className="block text-sm text-white font-semibold">{j.customerName || 'Customer'} · {j.vehicle}</span>
                <span className="block text-xs text-gray-400">{j.orderNumber}{j.vin ? ` · VIN …${j.vin.slice(-6)}` : ''} · {j.status.replace(/_/g, ' ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
