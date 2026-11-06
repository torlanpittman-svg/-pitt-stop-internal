'use client'

import { useState, useTransition } from 'react'
import { checkInAction, noShowAction, cancelAction, rescheduleAction, noteAction, type ActionResult } from '../actions'
import SlotPicker from '../SlotPicker'

export interface SavedVehicleOption { id: string; label: string; color: string | null; vin: string | null; matches: boolean }

export default function AppointmentActions({ id, status, hasJob, isManager, past, date, time, serviceKeys, bookedVehicle, bookedVin, savedVehicles }: {
  id: string; status: string; hasJob: boolean; isManager: boolean; past: boolean; date: string; time: string; serviceKeys: string[]
  /** What the customer booked (year make model) and the VIN if staff entered one on the appointment. */
  bookedVehicle: string; bookedVin: string | null
  /** The customer's saved vehicles. Empty = nothing on file (the Job starts without a VIN; scan it on the Job). */
  savedVehicles: SavedVehicleOption[]
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

  // Which vehicle is here? Pre-selected only when exactly ONE saved vehicle is the booked year/make/model
  // (the server applies the same rule); otherwise staff must choose — check-in never guesses a VIN.
  const matching = savedVehicles.filter((v) => v.matches)
  const [vehicleChoice, setVehicleChoice] = useState<string>(matching.length === 1 ? matching[0].id : '')
  const needsVehicleChoice = savedVehicles.length > 0 && !bookedVin
  const chosen = vehicleChoice === 'new' ? { newVehicle: true } : vehicleChoice ? { vehicleId: vehicleChoice } : null

  const confirmed = status === 'confirmed'
  const canCheckIn = !hasJob && (confirmed || status === 'arrived')

  return (
    <section className="mt-6">
      {canCheckIn && needsVehicleChoice && (
        <fieldset className="mb-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-200">Which vehicle is here?</legend>
          <p className="mb-3 text-xs text-gray-500">Booked as {bookedVehicle}. Choosing a saved vehicle keeps its VIN on the Job.</p>
          <div className="space-y-2">
            {savedVehicles.map((v) => (
              <label key={v.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-gray-800 px-3 py-2 has-[:checked]:border-emerald-600">
                <input type="radio" name="vehicle" className="mt-1" checked={vehicleChoice === v.id} onChange={() => setVehicleChoice(v.id)} />
                <span className="min-w-0 text-sm">
                  <span className="block text-gray-100">{v.label}{v.color ? ` (${v.color})` : ''}{v.matches ? <span className="ml-2 text-xs text-emerald-300">matches booking</span> : null}</span>
                  <span className="block font-mono text-xs text-gray-400">{v.vin ?? 'no VIN on file'}</span>
                </span>
              </label>
            ))}
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-gray-800 px-3 py-2 has-[:checked]:border-emerald-600">
              <input type="radio" name="vehicle" className="mt-1" checked={vehicleChoice === 'new'} onChange={() => setVehicleChoice('new')} />
              <span className="text-sm text-gray-100">New vehicle — {bookedVehicle}<span className="block text-xs text-gray-400">Not one of the saved vehicles. No VIN yet; scan it on the Job.</span></span>
            </label>
          </div>
        </fieldset>
      )}
      {canCheckIn && !needsVehicleChoice && !bookedVin && (
        <p className="mb-3 text-xs text-gray-500">No saved vehicle on file for this customer — the Job starts as {bookedVehicle} without a VIN; scan it on the Job.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {canCheckIn && (
          <button type="button" disabled={pending || (needsVehicleChoice && !chosen)} onClick={() => run(() => checkInAction(id, chosen))}
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
