'use client'
/**
 * "Assign to Auto Sales Vehicle" picker — shared by receipt capture and the manager review card.
 *
 * Search the whole sales inventory (active AND sold) by stock number, VIN, year, make or model; pick one
 * vehicle; the choice stays visible as a chip with Change / Remove.
 *
 * Once a vehicle is picked it asks the server what is already entered on that vehicle. If an expense there
 * looks like this same purchase, the person must say so — "It's this one" matches the receipt to that existing
 * expense (counted once) instead of adding a second line. Nothing is saved by this component; the parent
 * submits the value.
 */
import { useEffect, useRef, useState } from 'react'
import { vehicleExpenseCandidatesAction } from '@/apps/expenses/vehicle-actions'
import { matchVehicles, type VehicleOption } from '@/apps/expenses/vehicle-search'

export type { VehicleOption }
/** matchEventId: null = a new expense for the vehicle · an id = that existing vehicle expense ·
 *  undefined = still has to be answered (a likely match exists). */
export interface PickedVehicle { id: string; label: string; matchEventId: string | null | undefined }
interface Candidate { eventId: string; label: string; likely: boolean }

export default function VehiclePicker({ vehicles, value, onChange, total, date, receiptId, disabled = false }: {
  vehicles: VehicleOption[]; value: PickedVehicle | null; onChange: (v: PickedVehicle | null) => void
  total?: string; date?: string; receiptId?: string; disabled?: boolean
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const seq = useRef(0)
  const answeredFor = useRef<string | null>(null)   // the vehicle the person explicitly answered the match question for
  const latest = useRef({ value, onChange })
  useEffect(() => { latest.current = { value, onChange } })

  // What is already entered on the chosen vehicle? Re-asked when the amount/date change (they drive "likely").
  const vehicleId = value?.id ?? ''
  useEffect(() => {
    if (!vehicleId) return
    const mine = ++seq.current
    const t = setTimeout(async () => {
      const res = await vehicleExpenseCandidatesAction({ inventoryVehicleId: vehicleId, total, date, receiptId }).catch(() => ({ ok: false, candidates: [] as Candidate[] }))
      if (mine !== seq.current) return
      const list = res.ok ? res.candidates : []
      setCandidates(list)
      const cur = latest.current.value
      if (!cur || cur.id !== vehicleId) return
      // A likely match must be answered by the person; with none, the receipt is simply a new expense.
      // Never auto-match, and never discard an answer the person already gave for this vehicle.
      const stillThere = typeof cur.matchEventId === 'string' && list.some((c) => c.eventId === cur.matchEventId)
      if (answeredFor.current === vehicleId && (cur.matchEventId === null || stillThere)) return
      const next = list.some((c) => c.likely) ? undefined : null
      if (cur.matchEventId !== next) latest.current.onChange({ ...cur, matchEventId: next })
    }, 300)
    return () => clearTimeout(t)
  }, [vehicleId, total, date, receiptId])

  if (value) {
    const likely = (candidates ?? []).filter((c) => c.likely)
    const others = (candidates ?? []).filter((c) => !c.likely)
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-xl border border-indigo-900/60 bg-indigo-950/20 px-3 py-2">
          <span className="flex-1 min-w-0 text-sm text-indigo-100 break-words"><span className="text-indigo-400">Vehicle:</span> {value.label}</span>
          {!disabled && <button type="button" onClick={() => { seq.current++; answeredFor.current = null; setCandidates(null); onChange(null) }} className="shrink-0 text-gray-400 text-sm px-2 py-1 min-h-11">Change / remove</button>}
        </div>
        {candidates && candidates.length > 0 && (
          <fieldset className={`rounded-xl border px-3 py-2 space-y-1.5 ${likely.length && value.matchEventId === undefined ? 'border-amber-800/70 bg-amber-950/20' : 'border-gray-800 bg-gray-900/60'}`}>
            <legend className="sr-only">Is this purchase already entered on the vehicle?</legend>
            <p className={`text-sm ${likely.length ? 'text-amber-200' : 'text-gray-400'}`}>
              {likely.length ? 'This vehicle already has an expense for the same amount. Is it this same purchase?' : 'Already entered on this vehicle? Pick it so it is not counted twice.'}
            </p>
            {[...likely, ...others].slice(0, 6).map((c) => (
              <label key={c.eventId} className="flex items-start gap-2 text-sm text-gray-200 py-1.5 min-h-11">
                <input type="radio" className="mt-1 w-4 h-4" name={`veh-match-${value.id}`} disabled={disabled}
                  checked={value.matchEventId === c.eventId} onChange={() => { answeredFor.current = value.id; onChange({ ...value, matchEventId: c.eventId }) }} />
                <span className="min-w-0 break-words">Yes — it is this one: <span className="text-white">{c.label}</span>{c.likely && <span className="text-amber-300 text-xs"> · same amount</span>}</span>
              </label>
            ))}
            <label className="flex items-start gap-2 text-sm text-gray-200 py-1.5 min-h-11">
              <input type="radio" className="mt-1 w-4 h-4" name={`veh-match-${value.id}`} disabled={disabled}
                checked={value.matchEventId === null} onChange={() => { answeredFor.current = value.id; onChange({ ...value, matchEventId: null }) }} />
              <span>No — this is a new expense for the vehicle</span>
            </label>
            {typeof value.matchEventId === 'string' && <p className="text-gray-500 text-xs">The receipt will be attached to that expense. The vehicle’s total does not change.</p>}
          </fieldset>
        )}
      </div>
    )
  }

  const hits = matchVehicles(vehicles, q).slice(0, 8)
  const showList = open || q.trim() !== ''
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setOpen(true)} disabled={disabled}
        placeholder="Search stock #, VIN, year, make or model" autoComplete="off" spellCheck={false} aria-label="Search Auto Sales inventory vehicles"
        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
      {showList && (
        <div aria-live="polite">
          {vehicles.length === 0 && <p className="text-gray-500 text-xs mt-1">No inventory vehicles yet.</p>}
          {vehicles.length > 0 && hits.length === 0 && <p className="text-gray-500 text-xs mt-1">No vehicle matches “{q.trim()}”.</p>}
        </div>
      )}
      {showList && hits.length > 0 && (
        <ul className="mt-2 space-y-1">
          {hits.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => { onChange({ id: v.id, label: v.label, matchEventId: null }); setQ(''); setOpen(false) }}
                className="w-full text-left rounded-xl bg-gray-800 border border-gray-700 px-3 py-3 active:bg-gray-700">
                <span className="block text-sm text-white font-semibold">{[v.year, v.make, v.model].filter(Boolean).join(' ') || v.label}
                  {v.sold && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border border-gray-600 text-gray-300 font-normal">Sold</span>}</span>
                <span className="block text-xs text-gray-400">{[v.stock ?? 'no stock #', v.vin ? `VIN ${v.vin}` : 'no VIN'].join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
