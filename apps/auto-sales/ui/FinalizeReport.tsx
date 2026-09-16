'use client'
/**
 * Auto-Sales — Finalize a monthly report (MANAGER-only). Explicit confirmation before capturing a
 * snapshot. This is NOT an irreversible month-close: it preserves the values as generated; a later data
 * change is flagged as "changed" and the month can be re-finalized (prior versions kept).
 */
import { useState } from 'react'
import { finalizeReportAction } from '@/apps/auto-sales/actions'

export default function FinalizeReport({ month, canFinalize, state }: { month: string; canFinalize: boolean; state: 'live' | 'finalized' | 'changed' }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!canFinalize) return null

  async function go() {
    setBusy(true); setErr(null)
    const r = await finalizeReportAction({ month, note: note || undefined })
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not finalize.'); return }
    window.location.reload()
  }

  const label = state === 'finalized' ? 'Re-finalize' : state === 'changed' ? 'Re-finalize (data changed)' : 'Finalize this month'
  if (!open) return <button onClick={() => setOpen(true)} className={`text-sm font-semibold px-3 py-2 rounded-xl border ${state === 'changed' ? 'border-amber-600 text-amber-300' : 'border-emerald-700 text-emerald-300'} print:hidden`}>{label}</button>
  return (
    <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/10 p-3 print:hidden">
      <p className="text-emerald-300 text-sm font-semibold">Finalize {month}?</p>
      <p className="text-gray-400 text-xs mt-1">Captures the current figures as a snapshot for the accountant package. Prior finalizations are kept. If the data changes later, this month is flagged as changed and you can re-finalize.</p>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full mt-2" />
      {err && <p className="text-red-400 text-xs mt-1">{err}</p>}
      <div className="flex gap-2 mt-2">
        <button disabled={busy} onClick={() => setOpen(false)} className="flex-1 bg-gray-800 text-gray-200 py-3 rounded-xl text-sm">Cancel</button>
        <button disabled={busy} onClick={go} className="flex-1 bg-emerald-600 active:bg-emerald-700 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm">{busy ? 'Finalizing…' : 'Finalize'}</button>
      </div>
    </div>
  )
}
