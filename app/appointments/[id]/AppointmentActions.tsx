'use client'

import { useState, useTransition } from 'react'
import { checkInAction, noShowAction, cancelAction, rescheduleAction, noteAction, requeueAction, type ActionResult } from '../actions'
import SlotPicker from '../SlotPicker'

export default function AppointmentActions({ id, status, hasJob, isManager, past, date, time, serviceKeys, notices }: {
  id: string; status: string; hasJob: boolean; isManager: boolean; past: boolean; date: string; time: string; serviceKeys: string[]; notices: string[]
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'none' | 'reschedule' | 'cancel' | 'note'>('none')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [slot, setSlot] = useState<{ date: string; time: string | null; override: boolean }>({ date, time: null, override: false })

  const run = (fn: () => Promise<ActionResult>, after?: () => void) => start(async () => {
    setError(null)
    const r = await fn()
    if (r && !r.ok) setError(r.error)
    else { setPanel('none'); after?.() }
  })

  const confirmed = status === 'confirmed'
  const canCheckIn = !hasJob && (confirmed || status === 'arrived')

  return (
    <section className="mt-6">
      <div className="flex flex-wrap gap-2">
        {canCheckIn && (
          <button type="button" disabled={pending} onClick={() => run(() => checkInAction(id))}
            className="min-h-12 flex-1 rounded-xl bg-emerald-500 px-5 font-semibold text-gray-950 disabled:opacity-60">
            {pending ? 'Working…' : 'Check in → Work Board'}
          </button>
        )}
        {confirmed && past && (
          <button type="button" disabled={pending} onClick={() => run(() => noShowAction(id))} className="min-h-12 rounded-xl border border-amber-800 px-4 text-amber-200">Mark no-show</button>
        )}
        {confirmed && isManager && (
          <>
            <button type="button" onClick={() => setPanel(panel === 'reschedule' ? 'none' : 'reschedule')} className="min-h-12 rounded-xl border border-gray-700 px-4 text-gray-200">Reschedule</button>
            <button type="button" onClick={() => setPanel(panel === 'cancel' ? 'none' : 'cancel')} className="min-h-12 rounded-xl border border-red-900 px-4 text-red-300">Cancel</button>
          </>
        )}
        <button type="button" onClick={() => setPanel(panel === 'note' ? 'none' : 'note')} className="min-h-12 rounded-xl border border-gray-700 px-4 text-gray-200">Add note</button>
        {isManager && notices.length > 0 && (
          <button type="button" disabled={pending} onClick={() => run(async () => { for (const n of notices) await requeueAction(n, id); return { ok: true } })}
            className="min-h-12 rounded-xl border border-gray-700 px-4 text-gray-200">Retry customer messages</button>
        )}
      </div>
      {confirmed && !isManager && <p className="mt-2 text-xs text-gray-500">To reschedule or cancel, ask a manager.</p>}

      {panel === 'reschedule' && (
        <div className="mt-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm text-gray-300">Currently {date} at {time}. Pick a new drop-off time.</p>
          <SlotPicker serviceKeys={serviceKeys} value={slot} onChange={setSlot} allowOverride={isManager} excludeId={id} />
          <button type="button" disabled={pending || !slot.time} onClick={() => run(() => rescheduleAction(id, slot.date, slot.time!, slot.override))}
            className="mt-3 min-h-11 w-full rounded-lg bg-emerald-500 font-semibold text-gray-950 disabled:opacity-50">Move appointment</button>
        </div>
      )}
      {panel === 'cancel' && (
        <div className="mt-4 rounded-xl border border-red-900/70 bg-red-950/20 p-4">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)"
            className="h-11 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 text-white placeholder-gray-600" />
          <button type="button" disabled={pending} onClick={() => run(() => cancelAction(id, reason))}
            className="mt-3 min-h-11 w-full rounded-lg bg-red-500 font-semibold text-white disabled:opacity-60">Cancel appointment (frees the time)</button>
        </div>
      )}
      {panel === 'note' && (
        <div className="mt-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Staff-only note"
            className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white placeholder-gray-600" />
          <button type="button" disabled={pending || !note.trim()} onClick={() => run(() => noteAction(id, note), () => setNote(''))}
            className="mt-3 min-h-11 w-full rounded-lg bg-emerald-500 font-semibold text-gray-950 disabled:opacity-50">Save note</button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/40 p-3 text-sm text-amber-200">{error}</p>}
    </section>
  )
}
