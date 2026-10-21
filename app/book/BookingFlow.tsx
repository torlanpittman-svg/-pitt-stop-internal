'use client'

/**
 * Public booking flow — three steps: Service & Vehicle → Time & Contact → Review & Confirm.
 *
 * • Answers live in this component for the whole visit, so Back (on-page or the browser/phone back button,
 *   via history entries per step) never loses anything.
 * • Vehicles come only from the dependent Year → Make → Model lists (/api/book/vehicles); boats and RVs are
 *   "Call to schedule".
 * • Nothing is saved while typing. The unfinished-booking draft is saved only when the completed contact step
 *   is submitted with "Continue to review", next to a notice saying so. A draft never holds a time.
 * • Confirm is idempotent (one key per visit) and disabled while sending, so a double tap books once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookShell, telHref } from './BookShell'
import Combobox from './Combobox'
import { formatUsPhone, validateContact, type ContactErrors } from '@/apps/appointments/contact'

interface Service { key: string; label: string; description: string }
interface Shop { title: string; intro: string; phone: string; address: string; instructions: string; cancellationPolicy: string }
interface Slot { time: string; available: boolean }
interface Day { date: string; closed: boolean; slots: Slot[] }
interface Confirmed { reference: string; dateLabel: string; timeLabel: string; services: string; vehicle: string; firstName: string; email: string | null }
type VType = '' | 'car' | 'motorcycle' | 'trailer' | 'rv' | 'boat'
interface Vehicle { type: VType; year: string; make: string; model: string }
interface Contact { firstName: string; lastName: string; phone: string; email: string; notes: string }
export interface ResumeState {
  draftKey: string; services: string[]; vehicle: Vehicle; contact: Contact; followUp: boolean
  preferredDate: string | null; preferredTime: string | null
}
type ListState = { status: 'idle' | 'loading' | 'ok' | 'error'; items: string[]; source?: string }

const STEPS = ['Service & vehicle', 'Time & contact', 'Review & confirm'] as const
const VEHICLE_TYPES: { key: Exclude<VType, ''>; label: string; online: boolean }[] = [
  { key: 'car', label: 'Car, truck, SUV or van', online: true },
  { key: 'motorcycle', label: 'Motorcycle', online: true },
  { key: 'trailer', label: 'Trailer', online: true },
  { key: 'rv', label: 'RV or motorhome', online: false },
  { key: 'boat', label: 'Boat', online: false },
]
const IDLE: ListState = { status: 'idle', items: [] }

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
async function fetchDays(keys: string[]): Promise<Day[]> {
  const r = await fetch(`/api/book/availability?services=${encodeURIComponent(keys.join(','))}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`availability ${r.status}`)
  return ((await r.json()).days ?? []) as Day[]
}
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`)
const vehicleText = (v: Vehicle) => (v.type === 'trailer' ? [v.year, v.model] : [v.year, v.make, v.model]).filter(Boolean).join(' ')

/** Fetch one vehicle list, kept for the visit (going back and forth never refetches). State is only set from
 *  the fetch callbacks; a URL with no result yet reads as "loading". */
function useVehicleList(url: string | null): ListState & { retry: () => void } {
  const [lists, setLists] = useState<Record<string, ListState>>({})
  const [attempt, setAttempt] = useState(0)
  const have = url ? lists[url] : undefined
  const needFetch = !!url && (!have || have.status === 'loading')
  useEffect(() => {
    if (!url || !needFetch) return
    const ctl = new AbortController()
    fetch(url, { signal: ctl.signal })
      .then((r) => r.json())
      .then((d: { ok?: boolean; makes?: string[]; models?: string[]; source?: string }) => {
        if (!d.ok) throw new Error('bad')
        const items = d.makes ?? d.models ?? []
        setLists((m) => ({ ...m, [url]: { status: d.source === 'unavailable' ? 'error' : 'ok', items, source: d.source } }))
      })
      .catch((e) => { if (e?.name !== 'AbortError') setLists((m) => ({ ...m, [url]: { status: 'error', items: [] } })) })
    return () => ctl.abort()
  }, [url, needFetch, attempt])
  const retry = useCallback(() => {
    if (!url) return
    setLists((m) => { const n = { ...m }; delete n[url]; return n })
    setAttempt((a) => a + 1)
  }, [url])
  if (!url) return { ...IDLE, retry }
  return { ...(have ?? { status: 'loading', items: [] }), retry }
}

export default function BookingFlow({ open, services, preselect, attribution, shop, years, smsLabel, privacyUrl, termsUrl, saveNotice, followUpText, resume, resumeNote }: {
  open: boolean; services: Service[]; preselect: string[]; attribution: Record<string, string>; shop: Shop; years: string[]
  smsLabel: string; privacyUrl: string; termsUrl: string; saveNotice: string; followUpText: string
  resume?: ResumeState | null; resumeNote?: string | null
}) {
  const startStep = resume && resume.services.length && resume.vehicle.type ? 1 : 0
  const [step, setStep] = useState(startStep)
  const [chosen, setChosen] = useState<string[]>(resume?.services ?? preselect)
  const [vehicle, setVehicle] = useState<Vehicle>(resume?.vehicle ?? { type: '', year: '', make: '', model: '' })
  const [days, setDays] = useState<Day[] | null>(null)
  const [daysError, setDaysError] = useState(false)
  const [when, setWhen] = useState<{ date: string | null; time: string | null }>({ date: null, time: null })
  const { date, time } = when
  const [contact, setContact] = useState<Contact>(resume?.contact ?? { firstName: '', lastName: '', phone: '', email: '', notes: '' })
  const [touched, setTouched] = useState<Partial<Record<keyof Contact, boolean>>>({})
  const [followUp, setFollowUp] = useState(resume?.followUp ?? false)
  const [sms, setSms] = useState(false)
  const [website, setWebsite] = useState('') // honeypot
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [banner, setBanner] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(resumeNote ?? null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ appt: Confirmed; token: string; emailQueued: boolean } | null>(null)
  const [idemKey] = useState(newKey)
  const [draftKey] = useState(() => resume?.draftKey ?? newKey())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const doneRef = useRef(false)
  const preferred = useRef(resume?.preferredDate && resume.preferredTime ? { date: resume.preferredDate, time: resume.preferredTime } : null)

  const typeInfo = VEHICLE_TYPES.find((t) => t.key === vehicle.type)
  const onlineType = !!typeInfo?.online
  const makesUrl = onlineType && vehicle.year ? `/api/book/vehicles?type=${vehicle.type}&year=${vehicle.year}` : null
  const modelsUrl = onlineType && vehicle.year && (vehicle.type === 'trailer' || vehicle.make)
    ? `/api/book/vehicles?type=${vehicle.type}&year=${vehicle.year}${vehicle.type === 'trailer' ? '' : `&make=${encodeURIComponent(vehicle.make)}`}` : null
  const makes = useVehicleList(vehicle.type === 'trailer' ? null : makesUrl)
  const models = useVehicleList(modelsUrl)

  // A remembered make/model that isn't in the newly loaded list (after changing the year) is cleared — the
  // customer can never end up with a vehicle the lists don't contain.
  const makeValid = vehicle.type === 'trailer' || makes.status !== 'ok' || makes.items.includes(vehicle.make)
  const modelValid = models.status !== 'ok' || models.items.includes(vehicle.model)
  const make = makeValid ? vehicle.make : ''
  const model = makeValid && modelValid ? vehicle.model : ''

  const selectedLabels = useMemo(() => services.filter((s) => chosen.includes(s.key)).map((s) => s.label).join(', '), [services, chosen])
  const contactErrors: ContactErrors = useMemo(() => validateContact(contact), [contact])
  /** Editing a field clears its submit-time error, so the live check (shown once touched) takes over. */
  function editContact(k: keyof Contact, v: string) {
    setContact((c) => ({ ...c, [k]: v }))
    setErrors((e) => (e[k] ? { ...e, [k]: '' } : e))
  }
  const fieldError = (k: keyof Contact) => errors[k] || (touched[k] ? contactErrors[k as keyof ContactErrors] : undefined)

  // ── Browser history: one entry per step, so the phone's back button steps back instead of leaving ──
  // `reached` = furthest step this page load has filled in. A history entry left over from before a reload points
  // at a step whose answers are gone, so it is clamped to what this page actually has.
  const reached = useRef(startStep)
  const historyInit = useRef(false)
  useEffect(() => {
    if (!historyInit.current) {
      historyInit.current = true
      window.history.replaceState({ ...window.history.state, psStep: 0 }, '')
      if (startStep > 0) window.history.pushState({ ...window.history.state, psStep: startStep }, '')
    }
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { psStep?: unknown } | null)?.psStep
      if (!doneRef.current && typeof s === 'number') { setStep(Math.min(s, reached.current)); setErrors({}) }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [startStep])

  // Move focus to the new heading on a step change (not on first load, where it would steal the page's start).
  const shown = useRef({ step, done })
  useEffect(() => {
    if (shown.current.step === step && shown.current.done === done) return
    shown.current = { step, done }
    headingRef.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0 })
  }, [step, done])

  const applyDays = useCallback((all: Day[]) => {
    const list = all.filter((x) => !x.closed)
    setDaysError(false)
    setDays(list)
    // Keep a still-open choice. A resumed booking's earlier time is offered again only if it is open NOW —
    // drafts never hold a time.
    const want = preferred.current
    preferred.current = null
    setWhen((cur) => {
      const pick = cur.date ? cur : want ?? { date: null, time: null }
      const day = list.find((x) => x.date === pick.date)
      return {
        date: day ? day.date : list[0]?.date ?? null,
        time: day && pick.time && day.slots.some((x) => x.time === pick.time && x.available) ? pick.time : null,
      }
    })
  }, [])
  const loadDays = useCallback(async (keys: string[]) => {
    try { applyDays(await fetchDays(keys)) } catch { setDaysError(true) }
  }, [applyDays])

  useEffect(() => {
    if (startStep === 1 && resume) fetchDays(resume.services).then(applyDays, () => setDaysError(true))
  }, [startStep, applyDays, resume])

  function goForward(n: number) {
    setErrors({}); setBanner(null); setNotice(null)
    reached.current = Math.max(reached.current, n)
    window.history.pushState({ ...window.history.state, psStep: n }, '')
    setStep(n)
  }
  /** Back / Edit: walk the real history so the browser back button and the on-page Back agree. */
  function goBack(n: number) {
    setErrors({})
    if (n < step) window.history.go(n - step)
  }

  function focusFirst(errs: Record<string, string>) {
    const first = Object.keys(errs)[0]
    if (first) requestAnimationFrame(() => document.getElementById(`f-${first}`)?.focus())
  }

  function continueFromVehicle() {
    const errs: Record<string, string> = {}
    if (!chosen.length) errs.services = 'Choose at least one service.'
    if (!vehicle.type) errs.vtype = 'Choose your vehicle type.'
    else if (!onlineType) errs.vtype = 'Boats and RVs are scheduled by phone. Please call us.'
    else {
      if (!vehicle.year) errs.year = 'Choose the year.'
      if (vehicle.type !== 'trailer' && !make) errs.make = 'Choose the make.'
      if (!model) errs.model = vehicle.type === 'trailer' ? 'Choose the trailer type.' : 'Choose the model.'
    }
    setErrors(errs)
    if (Object.keys(errs).length) { setBanner('Please complete the highlighted fields.'); focusFirst(errs); return }
    if (!days) void loadDays(chosen)
    goForward(1)
  }

  async function continueToReview() {
    const errs: Record<string, string> = { ...(contactErrors as Record<string, string>) }
    if (!date || !time) errs.time = 'Choose a drop-off time.'
    const ordered: Record<string, string> = {}
    for (const k of ['time', 'firstName', 'lastName', 'phone', 'email']) if (errs[k]) ordered[k] = errs[k]
    setErrors(ordered)
    setTouched({ firstName: true, lastName: true, phone: true, email: true })
    if (Object.keys(ordered).length) { setBanner('Please complete the highlighted fields.'); focusFirst(ordered); return }
    if (busy) return
    setBusy(true); setBanner(null)
    try {
      const r = await fetch('/api/book/drafts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draftKey, serviceKeys: chosen, vehicleType: vehicle.type, vehicleYear: vehicle.year, vehicleMake: make, vehicleModel: model,
          firstName: contact.firstName, lastName: contact.lastName, phone: contact.phone, email: contact.email, notes: contact.notes,
          preferredDate: date, preferredTime: time, followUpConsent: followUp, attribution, website,
        }),
      })
      const d = await r.json().catch(() => ({}))
      // A rejected entry stops here (the booking would be rejected for the same reason). A shop-side hiccup
      // does not block the customer from booking — nothing is promised about the draft in that case.
      if (r.status === 400 || r.status === 429 || (r.status === 409 && d.code === 'closed')) {
        setBanner(d.error || 'Please check your details and try again.')
        return
      }
    } catch { /* offline/timeout: let them review; Confirm reports any real problem */ }
    finally { setBusy(false) }
    goForward(2)
  }

  async function confirm() {
    if (busy) return
    setBusy(true); setBanner(null)
    try {
      const r = await fetch('/api/book/appointments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: idemKey, draftKey, date, time, serviceKeys: chosen,
          firstName: contact.firstName, lastName: contact.lastName, phone: contact.phone, email: contact.email.trim(),
          vehicleType: vehicle.type, vehicleYear: vehicle.year, vehicleMake: make, vehicleModel: model,
          notes: contact.notes, smsMarketingOptIn: sms, attribution, website,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (d.ok) {
        doneRef.current = true
        setDone({ appt: d.appointment, token: d.token, emailQueued: d.confirmationEmail === 'queued' })
        return
      }
      if (d.code === 'full' || d.code === 'closed') {
        setWhen((w) => ({ ...w, time: null }))
        await loadDays(chosen)
        goBack(1)
        setBanner(d.error || 'That time is no longer available. Please pick another.')
        return
      }
      setBanner(d.error || 'Something went wrong. Please try again or call the shop.')
    } catch {
      setBanner('We couldn’t reach the shop. Check your connection and tap Book again — you won’t be booked twice.')
    } finally { setBusy(false) }
  }

  const setV = (patch: Partial<Vehicle>) => { setVehicle((v) => ({ ...v, ...patch })); setErrors((e) => { const n = { ...e }; for (const k of Object.keys(patch)) delete n[k === 'type' ? 'vtype' : k]; return n }) }

  if (!open) {
    return (
      <BookShell phone={shop.phone} address={shop.address} heading="Schedule a Drop-Off">
        <h2 className="text-2xl font-bold text-[var(--ps-navy)]">Online booking is paused</h2>
        <p className="mt-2 text-[var(--ps-body)]">Please call us and we&apos;ll get you scheduled.</p>
        <a href={telHref(shop.phone)} className="ps-btn-primary mt-6">Call {shop.phone}</a>
      </BookShell>
    )
  }

  if (done) {
    const a = done.appt
    return (
      <BookShell phone={shop.phone} address={shop.address} heading="You're Booked!">
        <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-[var(--ps-navy)] outline-none">Your drop-off is confirmed</h2>
        <p className="mt-2 text-[var(--ps-body)]">Thanks, {a.firstName}. We&apos;ll see you on {a.dateLabel} at {a.timeLabel}. That&apos;s when you drop off your vehicle &mdash; not when it will be finished. We&apos;ll contact you when it&apos;s ready.</p>
        <Summary rows={[['Drop-off', `${a.dateLabel} at ${a.timeLabel}`], ['Service', a.services], ['Vehicle', a.vehicle], ['Reference', a.reference], ['Location', shop.address], ['Phone', shop.phone]]} />
        <p className="mt-5 text-[0.95rem] text-[var(--ps-ink)]">{shop.instructions}</p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <a href={`/book/a/${done.token}`} className="ps-btn-primary">View or cancel</a>
          <a href={`/api/book/a/${done.token}/ics`} className="ps-btn-secondary">Add to calendar</a>
        </div>
        <p className="mt-5 text-sm text-[var(--ps-body)]">
          {done.emailQueued && a.email
            ? <>We&apos;re sending a confirmation to <strong className="text-[var(--ps-ink)]">{a.email}</strong>. If it doesn&apos;t arrive, your booking is still confirmed &mdash; keep this page or the &ldquo;View or cancel&rdquo; link. </>
            : <>Keep this page or bookmark the &ldquo;View or cancel&rdquo; link &mdash; it&apos;s your confirmation. </>}
          {shop.cancellationPolicy}
        </p>
      </BookShell>
    )
  }

  const dayList = days ?? []
  const slots = dayList.find((d) => d.date === date)?.slots.filter((s) => s.available) ?? []

  return (
    <BookShell phone={shop.phone} address={shop.address} heading="Schedule a Drop-Off">
      <Progress step={step} onGo={goBack} />

      <h2 ref={headingRef} tabIndex={-1} className="mt-6 text-[1.6rem] font-bold leading-tight text-[var(--ps-navy)] outline-none">
        {step === 0 ? 'What can we help with?' : step === 1 ? 'Pick a drop-off time' : 'Review and book'}
      </h2>

      {notice && (
        <p role="status" className="mt-4 rounded-xl border border-[#c8dcea] bg-[#eef4f9] px-4 py-3 text-[0.95rem] text-[var(--ps-navy)]">{notice}</p>
      )}
      {banner && (
        <p role="alert" className="mt-4 rounded-xl border border-[#f1c2bf] bg-[#fdf1f0] px-4 py-3 text-[0.95rem] text-[var(--ps-error)]">{banner}</p>
      )}

      {step === 0 && (
        <div className="mt-4 space-y-8">
          <fieldset className="min-w-0" aria-describedby={errors.services ? 'err-services' : undefined}>
            <legend className="text-[1.05rem] font-semibold text-[var(--ps-ink)]">Services <span className="font-normal text-[var(--ps-body)]">(choose one or more)</span></legend>
            <p className="mt-1 text-sm text-[var(--ps-body)]">Final price depends on your vehicle&apos;s size and condition. We confirm it with you before any work.</p>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              {services.map((s, i) => {
                const on = chosen.includes(s.key)
                return (
                  <label key={s.key} data-on={on} className="ps-choice flex min-h-16 cursor-pointer items-start gap-3 p-3.5">
                    <input id={i === 0 ? 'f-services' : undefined} type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--ps-navy)]" checked={on}
                      onChange={() => { setChosen((c) => (on ? c.filter((k) => k !== s.key) : [...c, s.key])); setDays(null); setErrors((e) => ({ ...e, services: '' })) }} />
                    <span className="min-w-0">
                      <span className="block font-semibold text-[var(--ps-ink)]">{s.label}</span>
                      {s.description && <span className="mt-0.5 block text-sm leading-snug text-[var(--ps-body)]">{s.description}</span>}
                    </span>
                  </label>
                )
              })}
            </div>
            {errors.services && <p id="err-services" className="mt-2 text-sm font-medium text-[var(--ps-error)]">{errors.services}</p>}
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="text-[1.05rem] font-semibold text-[var(--ps-ink)]">Your vehicle</legend>
            <div role="radiogroup" aria-label="Vehicle type" aria-describedby={errors.vtype ? 'err-vtype' : undefined} className="mt-3 flex flex-wrap gap-2">
              {VEHICLE_TYPES.map((t, i) => {
                const on = vehicle.type === t.key
                return (
                  <label key={t.key} data-on={on} className="ps-choice inline-flex min-h-11 cursor-pointer items-center gap-2 px-3.5 text-[0.95rem]">
                    <input id={i === 0 ? 'f-vtype' : undefined} type="radio" name="vtype" className="h-4 w-4 accent-[var(--ps-navy)]" checked={on}
                      onChange={() => setV({ type: t.key, year: on ? vehicle.year : (t.online && onlineType ? vehicle.year : ''), make: '', model: '' })} />
                    {t.label}
                  </label>
                )
              })}
            </div>
            {errors.vtype && <p id="err-vtype" className="mt-2 text-sm font-medium text-[var(--ps-error)]">{errors.vtype}</p>}

            {vehicle.type && !onlineType && (
              <div className="mt-4 rounded-xl border border-[var(--ps-line)] bg-white p-4">
                <p className="font-semibold text-[var(--ps-ink)]">Call to schedule</p>
                <p className="mt-1 text-[0.95rem] text-[var(--ps-body)]">We book {vehicle.type === 'boat' ? 'boats' : 'RVs and motorhomes'} by phone so we can plan the space and time they need.</p>
                <a href={telHref(shop.phone)} className="ps-btn-call mt-3">Call {shop.phone}</a>
              </div>
            )}

            {onlineType && (
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Combobox id="f-year" label="Year" options={years} value={vehicle.year} inputMode="numeric" placeholder="Choose year"
                  onChange={(y) => setV({ year: y, model: vehicle.type === 'trailer' ? vehicle.model : '' })} error={errors.year} />
                {vehicle.type !== 'trailer' && (
                  <Combobox id="f-make" label="Make" options={makes.items} value={make} placeholder={vehicle.year ? 'Choose make' : 'Choose year first'}
                    disabled={!vehicle.year} loading={makes.status === 'loading'} error={errors.make ?? (makes.status === 'error' ? 'We couldn’t load makes. Check your connection, or call us.' : undefined)}
                    onChange={(m) => setV({ make: m, model: '' })} />
                )}
                <Combobox id="f-model" label={vehicle.type === 'trailer' ? 'Trailer type' : 'Model'} options={models.items} value={model}
                  placeholder={vehicle.type === 'trailer' ? (vehicle.year ? 'Choose type' : 'Choose year first') : make ? 'Choose model' : 'Choose make first'}
                  disabled={!vehicle.year || (vehicle.type !== 'trailer' && !make)} loading={models.status === 'loading'}
                  error={errors.model ?? (models.status === 'error' ? 'The model list isn’t available right now. Try again in a minute, or call us.' : undefined)}
                  hint={models.status === 'ok' && make && !models.items.length ? `We don’t have ${vehicle.year} ${make} models listed. Call us and we’ll book it for you.` : undefined}
                  onChange={(m) => setV({ model: m })} />
              </div>
            )}
            {onlineType && (makes.status === 'error' || models.status === 'error') && (
              <button type="button" onClick={() => { if (makes.status === 'error') makes.retry(); if (models.status === 'error') models.retry() }}
                className="mt-3 min-h-11 font-medium text-[var(--ps-navy)] underline underline-offset-2">Try loading the list again</button>
            )}
            {onlineType && (
              <p className="mt-3 text-sm text-[var(--ps-body)]">Don&apos;t see your vehicle? Call <a href={telHref(shop.phone)} className="font-medium text-[var(--ps-navy)] underline underline-offset-2">{shop.phone}</a> and we&apos;ll book it for you.</p>
            )}
          </fieldset>
        </div>
      )}

      {step === 1 && (
        <div className="mt-4 space-y-8">
          <section aria-labelledby="when-h">
            <h3 id="when-h" className="sr-only">Drop-off time</h3>
            <div className="rounded-xl border-l-4 border-[var(--ps-yellow)] bg-white px-4 py-3 text-[0.95rem] text-[var(--ps-ink)] shadow-[0_1px_0_var(--ps-line)]">
              <strong>This is your drop-off time</strong> &mdash; when you bring the vehicle to us, not when it will be finished. We&apos;ll contact you when it&apos;s ready.
            </div>
            {!days && !daysError && <p className="mt-5 text-[var(--ps-body)]" role="status">Loading open times…</p>}
            {daysError && (
              <p className="mt-5 text-[var(--ps-body)]">We couldn&apos;t load open times. <button type="button" onClick={() => { setDaysError(false); setDays(null); void loadDays(chosen) }} className="font-medium text-[var(--ps-navy)] underline">Try again</button> or call {shop.phone}.</p>
            )}
            {days && !dayList.length && (
              <p className="mt-5 rounded-xl border border-[var(--ps-line)] bg-white p-4 text-[var(--ps-ink)]">No online times are open in the next two weeks. Please call <a href={telHref(shop.phone)} className="font-medium text-[var(--ps-navy)] underline">{shop.phone}</a>.</p>
            )}
            {dayList.length > 0 && (
              <>
                <p id="day-label" className="mt-5 font-semibold text-[var(--ps-ink)]">Day</p>
                <div className="-mx-4 mt-2 flex snap-x gap-2 overflow-x-auto px-4 pb-2" role="radiogroup" aria-labelledby="day-label">
                  {dayList.map((d) => {
                    const p = dayParts(d.date); const on = d.date === date
                    return (
                      <button key={d.date} type="button" role="radio" aria-checked={on} aria-label={p.long} onClick={() => { setWhen({ date: d.date, time: null }); setErrors((e) => ({ ...e, time: '' })) }}
                        data-on={on} className="ps-choice w-[4.6rem] shrink-0 snap-start py-2.5 text-center">
                        <span className="block text-xs text-[var(--ps-body)]">{p.wd}</span>
                        <span className="block font-semibold text-[var(--ps-ink)]">{p.md}</span>
                      </button>
                    )
                  })}
                </div>
                {date && (
                  <>
                    <p id="time-label" className="mt-4 font-semibold text-[var(--ps-ink)]">Drop-off time on {dayParts(date).long}</p>
                    <div id="f-time" tabIndex={-1} className="mt-2 grid grid-cols-3 gap-2 outline-none sm:grid-cols-4" role="radiogroup" aria-labelledby="time-label" aria-describedby={errors.time ? 'err-time' : undefined}>
                      {slots.map((s) => {
                        const on = time === s.time
                        return (
                          <button key={s.time} type="button" role="radio" aria-checked={on} onClick={() => { setWhen((w) => ({ ...w, time: s.time })); setErrors((e) => ({ ...e, time: '' })) }}
                            className={`min-h-12 rounded-full border-[1.5px] text-[0.95rem] font-medium ${on ? 'border-transparent bg-[var(--ps-navy)] text-white' : 'border-[#c9ced4] bg-white text-[var(--ps-ink)] hover:border-[var(--ps-navy)]'}`}>
                            {timeLabel(s.time)}
                          </button>
                        )
                      })}
                      {!slots.length && <p className="col-span-full text-[var(--ps-body)]">This day is full. Choose another day.</p>}
                    </div>
                    {errors.time && <p id="err-time" className="mt-2 text-sm font-medium text-[var(--ps-error)]">{errors.time}</p>}
                  </>
                )}
              </>
            )}
          </section>

          <fieldset className="min-w-0">
            <legend className="text-[1.05rem] font-semibold text-[var(--ps-ink)]">Your contact details</legend>
            <p className="mt-1 text-sm text-[var(--ps-body)]">We use these to confirm your booking and to contact you about this appointment.</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field id="f-firstName" label="First name" value={contact.firstName} autoComplete="given-name" autoCapitalize="words" enterKeyHint="next"
                onChange={(v) => editContact('firstName', v)} onBlur={() => setTouched((t) => ({ ...t, firstName: true }))} error={fieldError('firstName')} />
              <Field id="f-lastName" label="Last name" value={contact.lastName} autoComplete="family-name" autoCapitalize="words" enterKeyHint="next"
                onChange={(v) => editContact('lastName', v)} onBlur={() => setTouched((t) => ({ ...t, lastName: true }))} error={fieldError('lastName')} />
              <Field id="f-phone" label="Phone" value={contact.phone} type="tel" inputMode="tel" autoComplete="tel-national" placeholder="(979) 555-0123" enterKeyHint="next"
                onChange={(v) => editContact('phone', v)}
                onBlur={() => { setTouched((t) => ({ ...t, phone: true })); setContact((c) => ({ ...c, phone: formatUsPhone(c.phone) })) }} error={fieldError('phone')} />
              <Field id="f-email" label="Email" value={contact.email} type="email" inputMode="email" autoComplete="email" autoCapitalize="off" spellCheck={false} placeholder="name@example.com" enterKeyHint="next"
                onChange={(v) => editContact('email', v)} onBlur={() => setTouched((t) => ({ ...t, email: true }))} error={fieldError('email')} />
            </div>
            <label className="mt-4 block">
              <span className="text-[0.95rem] font-medium text-[var(--ps-ink)]">Anything we should know? <span className="font-normal text-[var(--ps-body)]">(optional)</span></span>
              <textarea id="f-notes" value={contact.notes} onChange={(e) => setContact((c) => ({ ...c, notes: e.target.value.slice(0, 2000) }))} rows={3}
                className="ps-field mt-1.5" placeholder="Pet hair, a stain, a noise you're hearing…" />
            </label>
            {/* Honeypot — hidden from people, tempting to bots. */}
            <div aria-hidden className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
              <label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
            </div>
          </fieldset>

          <div className="space-y-3">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--ps-line)] bg-white p-3.5">
              <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--ps-navy)]" />
              <span className="text-[0.95rem] text-[var(--ps-ink)]">{followUpText} <span className="text-[var(--ps-body)]">(optional)</span></span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--ps-line)] bg-white p-3.5">
              <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--ps-navy)]" />
              <span className="text-xs leading-relaxed text-[var(--ps-body)]">
                <span className="mb-1 block text-sm font-medium text-[var(--ps-ink)]">Optional: text me offers</span>
                {smsLabel}
                <span className="mt-1 block"><a href={privacyUrl} className="underline">Privacy Policy</a> <span aria-hidden>·</span> <a href={termsUrl} className="underline">Terms</a></span>
              </span>
            </label>
          </div>

          <div className="border-t border-[var(--ps-line)] pt-5">
            <p id="save-notice" className="text-sm text-[var(--ps-body)]">{saveNotice}</p>
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
              <button type="button" onClick={() => goBack(0)} className="ps-btn-secondary">Back</button>
              <button type="button" onClick={continueToReview} disabled={busy} aria-describedby="save-notice" className="ps-btn-primary sm:flex-1">
                {busy ? 'Saving…' : 'Continue to review'}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-4">
          <Summary rows={[
            ['Drop-off', date && time ? `${dayParts(date).long} at ${timeLabel(time)}` : ''],
            ['Service', selectedLabels], ['Vehicle', vehicleText({ ...vehicle, make, model })],
            ['Name', `${contact.firstName} ${contact.lastName}`.trim()], ['Phone', contact.phone], ['Email', contact.email],
            ...(contact.notes ? [['Notes', contact.notes] as [string, string]] : []),
          ]} edits={{ 'Drop-off': () => goBack(1), Service: () => goBack(0), Vehicle: () => goBack(0), Name: () => goBack(1), Phone: () => goBack(1), Email: () => goBack(1), Notes: () => goBack(1) }} />
          <div className="mt-5 rounded-xl border-l-4 border-[var(--ps-yellow)] bg-white px-4 py-3 text-[0.95rem] text-[var(--ps-ink)]">
            <strong>Before you come in.</strong> {shop.instructions}
          </div>
          <p className="mt-3 text-sm text-[var(--ps-body)]">Your time isn&apos;t held until you book. {shop.cancellationPolicy}</p>
        </div>
      )}

      {step !== 1 && (
        <div className="sticky bottom-0 z-20 -mx-4 mt-8 border-t border-[var(--ps-line)] bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
          <div className="flex gap-3">
            {step > 0 && <button type="button" onClick={() => goBack(step - 1)} className="ps-btn-secondary">Back</button>}
            {step === 0 ? (
              <button type="button" onClick={continueFromVehicle} disabled={!!vehicle.type && !onlineType} className="ps-btn-primary flex-1">Continue</button>
            ) : (
              <button type="button" onClick={confirm} disabled={busy} className="ps-btn-primary flex-1">{busy ? 'Booking…' : 'Book my drop-off'}</button>
            )}
          </div>
        </div>
      )}
    </BookShell>
  )
}

function Progress({ step, onGo }: { step: number; onGo: (n: number) => void }) {
  return (
    <nav aria-label="Booking progress">
      <p className="text-sm text-[var(--ps-body)]">Step {step + 1} of {STEPS.length}</p>
      <ol className="mt-2 grid grid-cols-3 gap-2">
        {STEPS.map((s, i) => {
          const state = i < step ? 'done' : i === step ? 'current' : 'todo'
          const body = (
            <>
              <span className={`block h-1.5 rounded-full ${state === 'todo' ? 'bg-[var(--ps-line)]' : 'bg-[linear-gradient(90deg,var(--ps-red),var(--ps-red-deep))]'}`} />
              <span className={`mt-1.5 block text-[0.8rem] leading-tight sm:text-sm ${state === 'current' ? 'font-semibold text-[var(--ps-ink)]' : 'text-[var(--ps-body)]'}`}>{s}</span>
            </>
          )
          return (
            <li key={s} aria-current={state === 'current' ? 'step' : undefined}>
              {state === 'done'
                ? <button type="button" onClick={() => onGo(i)} className="w-full text-left" aria-label={`Back to ${s}`}>{body}</button>
                : <div>{body}</div>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function Field({ id, label, value, onChange, onBlur, error, ...rest }: {
  id: string; label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; error?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'id'>) {
  return (
    <div>
      <label htmlFor={id} className="block text-[0.95rem] font-medium text-[var(--ps-ink)]">{label}</label>
      <input {...rest} id={id} required value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} className="ps-field mt-1.5" />
      {error && <p id={`${id}-err`} className="mt-1.5 text-sm font-medium text-[var(--ps-error)]">{error}</p>}
    </div>
  )
}

function Summary({ rows, edits }: { rows: [string, string][]; edits?: Record<string, () => void> }) {
  return (
    <dl className="mt-5 divide-y divide-[var(--ps-line)] rounded-2xl border border-[var(--ps-line)] bg-white">
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} className="flex items-start gap-3 px-4 py-3">
          <dt className="w-[5.5rem] shrink-0 text-sm text-[var(--ps-body)]">{k}</dt>
          <dd className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${k === 'Drop-off' ? 'font-semibold text-[var(--ps-navy)]' : 'text-[var(--ps-ink)]'}`}>{v}</dd>
          {edits?.[k] && <button type="button" onClick={edits[k]} className="min-h-11 shrink-0 px-1 text-sm font-medium text-[var(--ps-navy)] underline underline-offset-2" aria-label={`Edit ${k.toLowerCase()}`}>Edit</button>}
        </div>
      ))}
    </dl>
  )
}
