'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createStaffAppointment } from '../actions'
import SlotPicker from '../SlotPicker'
import { BOOKING_REFERRAL_OPTIONS, BOOKING_REFERRAL_PLACEHOLDER, REFERRAL_DETAIL_MAX } from '@/apps/appointments/referral'

const SOURCES = [
  ['phone', 'Phone call'], ['walk_in', 'Walk-in'], ['facebook', 'Facebook'], ['google_ads', 'Google Ads'],
  ['marketing', 'Marketing campaign'], ['website_booking', 'Website (entered by staff)'], ['autoleap_import', 'Moved from AutoLeap'], ['other', 'Other'],
] as const

const input = 'mt-1 h-11 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 text-white placeholder-gray-600 focus:border-emerald-500 focus:outline-none'

export interface RecoveryPrefill {
  recoveryId: string; reference: string; serviceKeys: string[]
  firstName: string; lastName: string; phone: string; email: string; year: string; make: string; model: string; color: string; plate: string; vin: string
}

export default function NewAppointmentForm({ services, today, isManager, prefill = null }: {
  services: { key: string; label: string; enabled: boolean }[]; today: string; isManager: boolean
  /** Rebooking a cancelled appointment from Lead Recovery: details filled in, and the new booking is credited to it. */
  prefill?: RecoveryPrefill | null
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState('phone')
  const [chosen, setChosen] = useState<string[]>(prefill?.serviceKeys.filter((k) => services.some((s) => s.key === k)) ?? [])
  const [slot, setSlot] = useState<{ date: string; time: string | null; override: boolean }>({ date: today, time: null, override: false })
  const [f, setF] = useState({
    firstName: prefill?.firstName ?? '', lastName: prefill?.lastName ?? '', phone: prefill?.phone ?? '', email: prefill?.email ?? '',
    year: prefill?.year ?? '', make: prefill?.make ?? '', model: prefill?.model ?? '', color: prefill?.color ?? '', plate: prefill?.plate ?? '', vin: prefill?.vin ?? '',
    notes: '', internal: prefill ? `Rebooked from cancelled appointment ${prefill.reference} (Lead Recovery).` : '', externalRef: '',
  })
  // Optional on staff entries (the customer may not have been asked); the public form requires it.
  const [referral, setReferral] = useState({ source: '', detail: '' })
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
        referralSource: referral.source, referralDetail: referral.source === 'other' ? referral.detail : '',
        ...(prefill ? { recoveryId: prefill.recoveryId } : {}),
      })
      if (!r.ok) { setError(r.error); return }
      router.push(`/appointments/${r.id}`)
    })
  }

  return (
    <div className="mt-5 space-y-6">
      {prefill && (
        <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 text-sm text-emerald-100">
          Rebooking cancelled appointment {prefill.reference}. Pick a new drop-off time — this booking will be credited to Lead Recovery and the follow-up emails will stop.
        </p>
      )}
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
        <label className="block text-sm text-gray-300">How did they hear about us? <span className="text-gray-500">(optional for phone entries)</span>
          <select value={referral.source} onChange={(e) => setReferral({ source: e.target.value, detail: e.target.value === 'other' ? referral.detail : '' })} className={input}>
            <option value="">{BOOKING_REFERRAL_PLACEHOLDER}</option>
            {BOOKING_REFERRAL_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        {referral.source === 'other' && (
          <label className="block text-sm text-gray-300">Where did they hear about us?
            <input value={referral.detail} maxLength={REFERRAL_DETAIL_MAX} onChange={(e) => setReferral({ ...referral, detail: e.target.value })} className={input} /></label>
        )}
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
