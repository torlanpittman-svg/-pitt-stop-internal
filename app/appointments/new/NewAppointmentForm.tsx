'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createStaffAppointment } from '../actions'
import SlotPicker from '../SlotPicker'

const SOURCES = [
  ['phone', 'Phone call'], ['walk_in', 'Walk-in'], ['facebook', 'Facebook'], ['google_ads', 'Google Ads'],
  ['marketing', 'Marketing campaign'], ['website_booking', 'Website (entered by staff)'], ['autoleap_import', 'Moved from AutoLeap'], ['other', 'Other'],
] as const

const input = 'mt-1 h-11 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 text-white placeholder-gray-600 focus:border-emerald-500 focus:outline-none'

export default function NewAppointmentForm({ services, today, isManager }: { services: { key: string; label: string; enabled: boolean }[]; today: string; isManager: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState('phone')
  const [chosen, setChosen] = useState<string[]>([])
  const [slot, setSlot] = useState<{ date: string; time: string | null; override: boolean }>({ date: today, time: null, override: false })
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', email: '', year: '', make: '', model: '', color: '', plate: '', vin: '', notes: '', internal: '', externalRef: '' })
  const [idemKey] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(36).slice(2)}`))
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })

  function submit() {
    setError(null)
    if (!chosen.length) return setError('Choose at least one service.')
    if (!slot.time) return setError('Choose a drop-off time.')
    start(async () => {
      const r = await createStaffAppointment({
        idempotencyKey: idemKey, date: slot.date, time: slot.time!, serviceKeys: chosen,
        firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email.trim(),
        vehicleYear: f.year.trim(), vehicleMake: f.make, vehicleModel: f.model, vehicleColor: f.color, vehiclePlate: f.plate,
        vehicleVin: f.vin.trim().toUpperCase(), notes: f.notes, internalNotes: f.internal,
        externalRef: source === 'autoleap_import' && f.externalRef.trim() ? `autoleap:${f.externalRef.trim()}` : undefined,
        source, override: slot.override, attribution: {},
      })
      if (!r.ok) { setError(r.error); return }
      router.push(`/appointments/${r.id}`)
    })
  }

  return (
    <div className="mt-5 space-y-6">
      <section>
        <label className="block text-sm text-gray-300">Where did this booking come from?
          <select value={source} onChange={(e) => setSource(e.target.value)} className={input}>
            {SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        {source === 'autoleap_import' && (
          <label className="mt-3 block text-sm text-gray-300">AutoLeap appointment / order number (prevents entering it twice)
            <input value={f.externalRef} onChange={set('externalRef')} className={input} />
          </label>
        )}
      </section>

      <section>
        <p className="text-sm font-semibold text-gray-200">Services</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {services.map((s) => {
            const on = chosen.includes(s.key)
            return (
              <button key={s.key} type="button" onClick={() => setChosen(on ? chosen.filter((k) => k !== s.key) : [...chosen, s.key])}
                className={`min-h-11 rounded-lg border px-3 text-left text-sm ${on ? 'border-emerald-500 bg-emerald-500/10' : 'border-gray-800 bg-gray-900'}`}>
                {s.label}{!s.enabled && <span className="block text-[10px] text-gray-500">not offered online</span>}
              </button>
            )
          })}
        </div>
      </section>

      <section>
        <p className="text-sm font-semibold text-gray-200">Drop-off time</p>
        <SlotPicker serviceKeys={chosen} value={slot} onChange={setSlot} allowOverride={isManager} />
        {!isManager && <p className="mt-2 text-xs text-gray-500">Outside the normal window or full? Ask a manager to override.</p>}
      </section>

      <section className="grid grid-cols-2 gap-3">
        <label className="text-sm text-gray-300">First name<input value={f.firstName} onChange={set('firstName')} className={input} /></label>
        <label className="text-sm text-gray-300">Last name<input value={f.lastName} onChange={set('lastName')} className={input} /></label>
        <label className="text-sm text-gray-300">Phone<input value={f.phone} onChange={set('phone')} type="tel" className={input} /></label>
        <label className="text-sm text-gray-300">Email<input value={f.email} onChange={set('email')} type="email" className={input} /></label>
      </section>

      <section className="grid grid-cols-3 gap-3">
        <label className="text-sm text-gray-300">Year<input value={f.year} onChange={set('year')} inputMode="numeric" className={input} /></label>
        <label className="col-span-2 text-sm text-gray-300">Make<input value={f.make} onChange={set('make')} className={input} /></label>
        <label className="col-span-3 text-sm text-gray-300">Model<input value={f.model} onChange={set('model')} className={input} /></label>
        <label className="text-sm text-gray-300">Color<input value={f.color} onChange={set('color')} className={input} /></label>
        <label className="text-sm text-gray-300">Plate<input value={f.plate} onChange={set('plate')} className={input} /></label>
        <label className="text-sm text-gray-300">VIN<input value={f.vin} onChange={set('vin')} className={input} /></label>
      </section>

      <section className="space-y-3">
        <label className="block text-sm text-gray-300">Customer request / notes
          <textarea value={f.notes} onChange={set('notes')} rows={2} className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label>
        <label className="block text-sm text-gray-300">Staff-only note
          <textarea value={f.internal} onChange={set('internal')} rows={2} className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label>
      </section>

      {error && <p role="alert" className="rounded-lg border border-amber-900/60 bg-amber-950/40 p-3 text-sm text-amber-200">{error}</p>}
      <button type="button" disabled={pending} onClick={submit} className="min-h-12 w-full rounded-xl bg-emerald-500 font-semibold text-gray-950 disabled:opacity-60">
        {pending ? 'Saving…' : 'Confirm appointment'}
      </button>
    </div>
  )
}
