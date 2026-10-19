'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SmsConsentDisclosure } from '@/app/components/SmsConsentDisclosure'

interface Service { key: string; label: string; description: string }
interface Shop { title: string; intro: string; phone: string; address: string; instructions: string; cancellationPolicy: string }
interface Slot { time: string; available: boolean }
interface Day { date: string; closed: boolean; closedReason?: string; slots: Slot[] }
interface Confirmed { reference: string; dateLabel: string; timeLabel: string; services: string; vehicle: string; firstName: string; phone: string; email: string | null }

const STEPS = ['Service', 'Vehicle', 'Time', 'Contact', 'Review'] as const

const timeLabel = (hhmm: string) => {
  const h = Number(hhmm.slice(0, 2)); const m = hhmm.slice(3, 5)
  return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}`
}
const dayParts = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`)
  return {
    wd: d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }),
    md: d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
    long: d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }),
  }
}
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`)

export default function BookingFlow({ open, services, preselect, attribution, shop, smsLabel, privacyUrl, termsUrl }: {
  open: boolean; services: Service[]; preselect: string[]; attribution: Record<string, string>; shop: Shop
  smsLabel: string; privacyUrl: string; termsUrl: string
}) {
  const [step, setStep] = useState(0)
  const [chosen, setChosen] = useState<string[]>(preselect)
  const [vehicle, setVehicle] = useState({ year: '', make: '', model: '', color: '', plate: '', vin: '' })
  const [days, setDays] = useState<Day[] | null>(null)
  const [loadingDays, setLoadingDays] = useState(false)
  const [date, setDate] = useState<string | null>(null)
  const [time, setTime] = useState<string | null>(null)
  const [contact, setContact] = useState({ firstName: '', lastName: '', phone: '', email: '', notes: '' })
  const [sms, setSms] = useState(false)
  const [website, setWebsite] = useState('') // honeypot
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ appt: Confirmed; token: string } | null>(null)
  const [idemKey] = useState(newKey)
  const topRef = useRef<HTMLDivElement>(null)

  const selectedLabels = useMemo(() => services.filter((s) => chosen.includes(s.key)).map((s) => s.label).join(', '), [services, chosen])

  const loadDays = useCallback(async () => {
    setLoadingDays(true); setError(null)
    try {
      const r = await fetch(`/api/book/availability?services=${encodeURIComponent(chosen.join(','))}`, { cache: 'no-store' })
      const d = await r.json()
      const list: Day[] = d.days ?? []
      setDays(list)
      setDate((cur) => (cur && list.some((x) => x.date === cur && !x.closed) ? cur : list.find((x) => !x.closed)?.date ?? null))
    } catch { setError('Could not load times. Check your connection and try again.') }
    finally { setLoadingDays(false) }
  }, [chosen])

  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }) }, [step, done])

  const go = (n: number) => { setError(null); setStep(n); if (n === 2) loadDays() }

  function next() {
    setError(null)
    if (step === 0 && !chosen.length) return setError('Choose at least one service.')
    if (step === 1) {
      if (!/^(19|20)\d{2}$/.test(vehicle.year.trim())) return setError('Enter the 4-digit vehicle year.')
      if (!vehicle.make.trim() || !vehicle.model.trim()) return setError('Enter the vehicle make and model.')
      if (vehicle.vin.trim() && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vehicle.vin.trim())) return setError('A VIN is 17 letters and numbers (or leave it blank).')
    }
    if (step === 2 && (!date || !time)) return setError('Choose a drop-off day and time.')
    if (step === 3) {
      if (!contact.firstName.trim() || !contact.lastName.trim()) return setError('Enter your first and last name.')
      if (contact.phone.replace(/\D/g, '').length < 10) return setError('Enter a 10-digit mobile number.')
      if (contact.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) return setError('Check the email address (or leave it blank).')
    }
    if (step + 1 === 2) loadDays()
    setStep(step + 1)
  }

  async function confirm() {
    if (submitting) return
    setSubmitting(true); setError(null)
    try {
      const r = await fetch('/api/book/appointments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: idemKey, date, time, serviceKeys: chosen,
          firstName: contact.firstName, lastName: contact.lastName, phone: contact.phone, email: contact.email.trim(),
          vehicleYear: vehicle.year.trim(), vehicleMake: vehicle.make, vehicleModel: vehicle.model, vehicleColor: vehicle.color,
          vehiclePlate: vehicle.plate, vehicleVin: vehicle.vin.trim().toUpperCase(), notes: contact.notes,
          smsMarketingOptIn: sms, attribution, website,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (d.ok) { setDone({ appt: d.appointment, token: d.token }); return }
      if (d.code === 'full' || d.code === 'closed') {
        setTime(null); setStep(2); await loadDays()
        setError(d.error || 'That time is no longer available. Please pick another.')
        return
      }
      setError(d.error || 'Something went wrong. Please try again or call the shop.')
    } catch {
      setError('Could not reach the shop. Check your connection and tap Confirm again — you will not be double-booked.')
    } finally { setSubmitting(false) }
  }

  const header = (
    <header className="border-b border-gray-900 bg-gray-950/95">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4 py-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400">Pitt Stop Detail &amp; Auto Sales</p>
          <p className="text-sm text-gray-400">College Station, TX</p>
        </div>
        <a href={`tel:${shop.phone.replace(/[^\d+]/g, '')}`} className="shrink-0 rounded-full border border-gray-800 px-3 py-2 text-sm text-gray-200 hover:border-gray-600">
          {shop.phone}
        </a>
      </div>
    </header>
  )

  if (!open) {
    return (
      <>
        {header}
        <section className="mx-auto max-w-xl px-4 py-10">
          <h1 className="text-2xl font-bold">Book a drop-off</h1>
          <p className="mt-3 text-gray-300">Online booking isn&apos;t available right now. Please call us and we&apos;ll get you scheduled.</p>
          <a href={`tel:${shop.phone.replace(/[^\d+]/g, '')}`} className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-emerald-500 px-5 font-semibold text-gray-950">Call {shop.phone}</a>
          <p className="mt-6 text-sm text-gray-500">{shop.address}</p>
        </section>
      </>
    )
  }

  if (done) {
    const a = done.appt
    return (
      <>
        {header}
        <section ref={topRef} className="mx-auto max-w-xl px-4 py-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-2xl text-emerald-400" aria-hidden>✓</div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight">Appointment Confirmed</h1>
          <p className="mt-2 text-gray-300">Thanks, {a.firstName}. Your drop-off is booked.</p>
          <dl className="mt-6 divide-y divide-gray-800 rounded-2xl border border-gray-800 bg-gray-900">
            <Row k="Drop-off" v={`${a.dateLabel} at ${a.timeLabel}`} strong />
            <Row k="Service" v={a.services} />
            {a.vehicle && <Row k="Vehicle" v={a.vehicle} />}
            <Row k="Reference" v={a.reference} mono />
            <Row k="Location" v={shop.address} />
            <Row k="Phone" v={shop.phone} />
          </dl>
          <p className="mt-5 text-sm leading-relaxed text-gray-300">{shop.instructions}</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <a href={`/api/book/a/${done.token}/ics`} className="flex min-h-12 items-center justify-center rounded-xl border border-gray-700 font-medium text-gray-100 hover:border-gray-500">Add to calendar</a>
            <a href={`/book/a/${done.token}`} className="flex min-h-12 items-center justify-center rounded-xl border border-gray-700 font-medium text-gray-100 hover:border-gray-500">View or cancel</a>
          </div>
          <p className="mt-5 text-xs leading-relaxed text-gray-500">
            Save this page or bookmark the &ldquo;View or cancel&rdquo; link. {shop.cancellationPolicy}
          </p>
        </section>
      </>
    )
  }

  return (
    <>
      {header}
      <section ref={topRef} className="mx-auto max-w-xl px-4 pb-32 pt-6">
        <h1 className="text-2xl font-bold tracking-tight">{shop.title}</h1>
        <p className="mt-1 text-sm text-gray-400">{shop.intro}</p>

        <ol className="mt-5 grid grid-cols-5 gap-1.5" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button type="button" disabled={i >= step} onClick={() => go(i)} className="w-full text-left disabled:cursor-default">
                <span className={`block h-1 rounded-full ${i <= step ? 'bg-emerald-400' : 'bg-gray-800'}`} />
                <span className={`mt-1.5 block text-[11px] ${i === step ? 'text-white' : 'text-gray-500'}`}>{s}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="mt-6">
          {step === 0 && (
            <fieldset className="min-w-0">
              <legend className="text-lg font-semibold">What can we help with?</legend>
              <p className="mt-1 text-sm text-gray-400">Choose one or more. Final pricing depends on your vehicle&apos;s condition and is confirmed with you.</p>
              <div className="mt-4 grid gap-2">
                {services.map((s) => {
                  const on = chosen.includes(s.key)
                  return (
                    <label key={s.key} className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition ${on ? 'border-emerald-500 bg-emerald-500/10' : 'border-gray-800 bg-gray-900 hover:border-gray-600'}`}>
                      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-emerald-500" checked={on}
                        onChange={() => setChosen((c) => (on ? c.filter((k) => k !== s.key) : [...c, s.key]))} />
                      <span className="min-w-0">
                        <span className="block font-medium">{s.label}</span>
                        {s.description && <span className="mt-0.5 block text-sm text-gray-400">{s.description}</span>}
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}

          {step === 1 && (
            <fieldset className="min-w-0">
              <legend className="text-lg font-semibold">Your vehicle</legend>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <Field label="Year" value={vehicle.year} onChange={(v) => setVehicle({ ...vehicle, year: v.replace(/\D/g, '').slice(0, 4) })} inputMode="numeric" autoComplete="off" placeholder="2021" />
                <Field label="Make" value={vehicle.make} onChange={(v) => setVehicle({ ...vehicle, make: v })} className="col-span-2" placeholder="Toyota" autoComplete="off" />
              </div>
              <div className="mt-3 grid gap-3">
                <Field label="Model" value={vehicle.model} onChange={(v) => setVehicle({ ...vehicle, model: v })} placeholder="Camry" autoComplete="off" />
              </div>
              <details className="mt-4 rounded-xl border border-gray-800 bg-gray-900 p-3">
                <summary className="cursor-pointer text-sm text-gray-300">Optional: color, plate, VIN</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Color" value={vehicle.color} onChange={(v) => setVehicle({ ...vehicle, color: v })} autoComplete="off" />
                  <Field label="License plate" value={vehicle.plate} onChange={(v) => setVehicle({ ...vehicle, plate: v.toUpperCase() })} autoComplete="off" />
                  <Field label="VIN" value={vehicle.vin} onChange={(v) => setVehicle({ ...vehicle, vin: v.toUpperCase().slice(0, 17) })} className="sm:col-span-2" autoComplete="off" />
                </div>
              </details>
            </fieldset>
          )}

          {step === 2 && (
            <fieldset className="min-w-0">
              <legend className="text-lg font-semibold">Pick a drop-off time</legend>
              <p className="mt-1 text-sm text-gray-400">This is when you drop the vehicle off — not a finish time. We&apos;ll contact you when it&apos;s ready.</p>
              {loadingDays && !days && <p className="mt-6 text-sm text-gray-400">Loading available times…</p>}
              {days && !days.some((d) => !d.closed) && (
                <p className="mt-6 rounded-xl border border-gray-800 bg-gray-900 p-4 text-sm text-gray-300">No online times are open in the next two weeks. Please call {shop.phone}.</p>
              )}
              {days && days.some((d) => !d.closed) && (
                <>
                  <div className="-mx-4 mt-4 flex snap-x gap-2 overflow-x-auto px-4 pb-2" role="listbox" aria-label="Day">
                    {days.filter((d) => !d.closed).map((d) => {
                      const p = dayParts(d.date); const on = d.date === date
                      return (
                        <button key={d.date} type="button" role="option" aria-selected={on} onClick={() => { setDate(d.date); setTime(null) }}
                          className={`w-[4.75rem] shrink-0 snap-start whitespace-nowrap rounded-xl border px-3 py-2.5 text-center ${on ? 'border-emerald-500 bg-emerald-500/10' : 'border-gray-800 bg-gray-900 hover:border-gray-600'}`}>
                          <span className="block text-xs text-gray-400">{p.wd}</span>
                          <span className="block font-semibold">{p.md}</span>
                        </button>
                      )
                    })}
                  </div>
                  {date && (
                    <div className="mt-4">
                      <p className="text-sm text-gray-300">{dayParts(date).long}</p>
                      <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {days.find((d) => d.date === date)?.slots.map((s) => (
                          <button key={s.time} type="button" disabled={!s.available} onClick={() => setTime(s.time)}
                            className={`min-h-12 rounded-xl border text-sm font-medium ${time === s.time ? 'border-emerald-500 bg-emerald-500 text-gray-950' : s.available ? 'border-gray-700 bg-gray-900 hover:border-gray-500' : 'cursor-not-allowed border-gray-900 bg-gray-950 text-gray-600 line-through'}`}>
                            {timeLabel(s.time)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </fieldset>
          )}

          {step === 3 && (
            <fieldset className="min-w-0">
              <legend className="text-lg font-semibold">Your contact info</legend>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Field label="First name" value={contact.firstName} onChange={(v) => setContact({ ...contact, firstName: v })} autoComplete="given-name" />
                <Field label="Last name" value={contact.lastName} onChange={(v) => setContact({ ...contact, lastName: v })} autoComplete="family-name" />
              </div>
              <div className="mt-3 grid gap-3">
                <Field label="Mobile number" value={contact.phone} onChange={(v) => setContact({ ...contact, phone: v })} type="tel" inputMode="tel" autoComplete="tel" placeholder="(979) 555-0123" />
                <Field label="Email (optional)" value={contact.email} onChange={(v) => setContact({ ...contact, email: v })} type="email" inputMode="email" autoComplete="email" hint="For your confirmation and reminder." />
                <label className="block">
                  <span className="text-sm text-gray-300">Anything we should know? (optional)</span>
                  <textarea value={contact.notes} onChange={(e) => setContact({ ...contact, notes: e.target.value.slice(0, 2000) })} rows={3}
                    className="mt-1 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2.5 text-base text-white placeholder-gray-600 focus:border-emerald-500 focus:outline-none"
                    placeholder="Pet hair, a stain, a noise you're hearing…" />
                </label>
                {/* Honeypot — hidden from people, tempting to bots. */}
                <div aria-hidden className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
                  <label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
                </div>
                <div onChange={(e) => setSms((e.target as HTMLInputElement).checked)}>
                  <SmsConsentDisclosure disclosure={smsLabel} privacyUrl={privacyUrl} termsUrl={termsUrl}>
                    <span className="mb-1 block font-medium text-gray-200">Optional: text offers</span>
                    {smsLabel}
                  </SmsConsentDisclosure>
                  <p className="mt-1.5 text-xs text-gray-500">Not required to book. Leave unchecked if you only want appointment updates.</p>
                </div>
              </div>
            </fieldset>
          )}

          {step === 4 && (
            <div>
              <h2 className="text-lg font-semibold">Review your appointment</h2>
              <dl className="mt-4 divide-y divide-gray-800 rounded-2xl border border-gray-800 bg-gray-900">
                <Row k="Drop-off" v={date && time ? `${dayParts(date).long} at ${timeLabel(time)}` : ''} strong edit={() => go(2)} />
                <Row k="Service" v={selectedLabels} edit={() => go(0)} />
                <Row k="Vehicle" v={[vehicle.year, vehicle.make, vehicle.model, vehicle.color && `(${vehicle.color})`].filter(Boolean).join(' ')} edit={() => go(1)} />
                <Row k="Contact" v={[`${contact.firstName} ${contact.lastName}`, contact.phone, contact.email].filter(Boolean).join(' · ')} edit={() => go(3)} />
                {contact.notes && <Row k="Notes" v={contact.notes} />}
              </dl>
              <p className="mt-4 text-sm leading-relaxed text-gray-400">{shop.instructions}</p>
              <p className="mt-2 text-xs text-gray-500">{shop.cancellationPolicy}</p>
            </div>
          )}
        </div>

        {error && <p role="alert" className="mt-5 rounded-xl border border-amber-900/60 bg-amber-950/40 p-3 text-sm text-amber-200">{error}</p>}
      </section>

      <div className="fixed inset-x-0 bottom-0 border-t border-gray-900 bg-gray-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {step > 0 && (
            <button type="button" onClick={() => go(step - 1)} className="min-h-12 rounded-xl border border-gray-700 px-5 font-medium text-gray-200">Back</button>
          )}
          {step < 4 ? (
            <button type="button" onClick={next} className="min-h-12 flex-1 rounded-xl bg-emerald-500 font-semibold text-gray-950 hover:bg-emerald-400">Continue</button>
          ) : (
            <button type="button" onClick={confirm} disabled={submitting} className="min-h-12 flex-1 rounded-xl bg-emerald-500 font-semibold text-gray-950 hover:bg-emerald-400 disabled:opacity-60">
              {submitting ? 'Confirming…' : 'Confirm Appointment'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function Field({ label, value, onChange, className = '', hint, ...rest }: {
  label: string; value: string; onChange: (v: string) => void; className?: string; hint?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className={`block ${className}`}>
      <span className="text-sm text-gray-300">{label}</span>
      <input {...rest} value={value} onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-12 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 text-base text-white placeholder-gray-600 focus:border-emerald-500 focus:outline-none" />
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  )
}

function Row({ k, v, strong, mono, edit }: { k: string; v: string; strong?: boolean; mono?: boolean; edit?: () => void }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <dt className="w-20 shrink-0 text-sm text-gray-500">{k}</dt>
      <dd className={`min-w-0 flex-1 break-words ${strong ? 'font-semibold text-white' : 'text-gray-200'} ${mono ? 'font-mono tracking-wider' : ''}`}>{v}</dd>
      {edit && <button type="button" onClick={edit} className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300">Edit</button>}
    </div>
  )
}
