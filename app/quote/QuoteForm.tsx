'use client'
/**
 * Short quote / estimate form: service or damage type, contact, year/make/model, what happened, up to
 * MAX_PHOTOS optional photos; for insurance-restoration damage types also the customer's own claim status
 * and an optional incident date. Photos are downscaled in the browser (≤1600px JPEG) so the request stays
 * small; the server rejects anything over ~1 MB each. The success screen only says the shop was emailed
 * when the server confirmed it, and the GA4 `quote_requested` event fires only for a NEW (non-replayed)
 * request — never on a retry.
 * A per-payload request key makes retries safe: resubmitting the SAME content (double-tap, flaky network)
 * reuses the key so the server replays the stored outcome instead of creating a second lead/email; any
 * edit clears the key so the next submit is a genuinely new request.
 */
import { useRef, useState } from 'react'
import { QUOTE_SERVICES, QUOTE_PROMPTS, CLAIM_STATUSES, MAX_PHOTOS, isRestorationService, type QuoteService, type QuoteErrors } from '@/apps/marketing/quote-shared'
import { REFERRAL_SOURCES } from '@/apps/quick-entry/referral-source'
import { telHref } from '@/app/book/BookShell'
import { fireQuoteConversion } from './conversion'

type Photo = { name: string; contentType: string; contentBase64: string; preview: string }

async function downscale(file: File): Promise<Photo> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('bad image')); i.src = url })
    const max = 1600
    const scale = Math.min(1, max / Math.max(img.width, img.height))
    const c = document.createElement('canvas')
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    const dataUrl = c.toDataURL('image/jpeg', 0.8)
    return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', contentType: 'image/jpeg', contentBase64: dataUrl.split(',')[1], preview: dataUrl }
  } finally { URL.revokeObjectURL(url) }
}

const field = 'w-full rounded-lg border border-[var(--ps-line,#cfd8e3)] bg-white px-3 py-3 text-base text-[var(--ps-ink,#0b1f33)] focus:outline-none focus:ring-2 focus:ring-[var(--ps-navy,#0d4469)]'
const label = 'mb-1 block text-sm font-medium text-[var(--ps-ink,#0b1f33)]'
const err = 'mt-1 text-sm text-red-700'

const SERVICE_KEYS = Object.keys(QUOTE_SERVICES) as QuoteService[]
const GROUPS: { key: 'restoration' | 'detailing'; legend: string; hint?: string }[] = [
  { key: 'restoration', legend: 'Damage or insurance-related restoration', hint: 'Vandalism, break-ins, paint overspray, water in the cabin, broken glass.' },
  { key: 'detailing', legend: 'Detailing and appearance' },
]

export default function QuoteForm({ preselect, attribution, phone }: { preselect: QuoteService; attribution: Record<string, string>; phone: string }) {
  const [service, setService] = useState<QuoteService>(preselect)
  const [f, setF] = useState({ name: '', phone: '', email: '', vehicleYear: '', vehicleMake: '', vehicleModel: '', message: '', incidentDate: '' })
  const [claimStatus, setClaimStatus] = useState('')
  const [referral, setReferral] = useState({ source: '', detail: '' }) // optional, self-reported; sent separately from `attribution`
  const [photos, setPhotos] = useState<Photo[]>([])
  const [errors, setErrors] = useState<QuoteErrors>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ emailed: boolean } | null>(null)
  const website = useRef('') // honeypot
  // Idempotency key: minted at first submit, REUSED while the content is unchanged (so a retry replays
  // instead of double-submitting), cleared on any edit or server-reported conflict.
  const requestKey = useRef('')
  const mintKey = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `qk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setF({ ...f, [k]: e.target.value }); setErrors((x) => ({ ...x, [k]: undefined })); requestKey.current = '' }
  const restoration = isRestorationService(service)
  const prompt = QUOTE_PROMPTS[service]
  const noun = restoration ? 'estimate' : 'quote'

  async function addPhotos(list: FileList | null) {
    if (!list) return
    const next = [...photos]
    let skipped = 0
    for (const file of Array.from(list)) {
      if (next.length >= MAX_PHOTOS) { skipped++; continue }
      if (!file.type.startsWith('image/')) { skipped++; continue }
      try { next.push(await downscale(file)) } catch { setErrors((x) => ({ ...x, photos: 'That file could not be read as a photo.' })) }
    }
    if (skipped) setErrors((x) => ({ ...x, photos: `Only images are accepted, up to ${MAX_PHOTOS} photos.` }))
    setPhotos(next)
    requestKey.current = ''
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setErrors({})
    if (!requestKey.current) requestKey.current = mintKey()
    try {
      const r = await fetch('/api/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service, ...f,
          incidentDate: restoration ? f.incidentDate : undefined,
          claimStatus: restoration && claimStatus ? claimStatus : undefined,
          referralSource: referral.source || undefined, referralDetail: referral.source === 'other' ? referral.detail : undefined,
          photos: photos.map((p) => ({ name: p.name, contentType: p.contentType, contentBase64: p.contentBase64 })),
          attribution, website: website.current, requestKey: requestKey.current,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (d.ok) {
        fireQuoteConversion({ leadId: typeof d.leadId === 'string' ? d.leadId : null, service, replayed: d.replayed === true })
        setDone({ emailed: d.emailed === true }); return
      }
      if (d.conflict) requestKey.current = '' // server saw this key with different content — next submit gets a fresh key
      if (d.errors) { setErrors(d.errors); return }
      setErrors({ form: d.error || 'Something went wrong. Please call the shop.' })
    } catch {
      setErrors({ form: 'We couldn’t reach the shop. Check your connection and try again, or call us.' })
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h2 className="text-2xl font-bold text-[var(--ps-navy)]">Thanks, {f.name.split(' ')[0] || 'we have it'}.</h2>
        {done.emailed ? (
          <p className="mt-2 text-[var(--ps-body)]">Your request was sent to the shop. We&apos;ll reply to <span className="font-medium">{f.email}</span> or call <span className="font-medium">{f.phone}</span>{restoration ? ' to look at the damage and write up your estimate.' : ' with your quote.'}</p>
        ) : (
          <p className="mt-2 text-[var(--ps-body)]">Your request was saved, but our email delivery hiccupped. To be safe, please call us at <a className="font-medium underline" href={telHref(phone)}>{phone}</a> and mention your {QUOTE_SERVICES[service].label.toLowerCase()} {noun}.</p>
        )}
        {restoration && (
          <p className="mt-3 text-sm text-[var(--ps-body)]">You&apos;ll get a written, itemized estimate and damage documentation you can share with your insurer if you file a claim. Whether a claim is covered is always your insurance company&apos;s decision, not ours.</p>
        )}
        <a href="https://www.pittstopdetailandautosales.com/" className="ps-btn-call mt-6 inline-block">Back to the website</a>
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-3xl space-y-5 px-4 py-6">
      <p className="text-[var(--ps-body)]">
        {restoration
          ? <>Tell us what happened and add a few photos. We&apos;ll reply with next steps and a written estimate. Prefer to talk? Call <a className="font-medium underline" href={telHref(phone)}>{phone}</a>.</>
          : <>Tell us about the vehicle and we&apos;ll get back to you with a quote. Prefer to talk? Call <a className="font-medium underline" href={telHref(phone)}>{phone}</a>.</>}
      </p>
      {errors.form && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{errors.form}</div>}

      <fieldset>
        <legend className={label}>What do you need help with?</legend>
        {GROUPS.map((g) => (
          <div key={g.key} className="mt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ps-body)]">{g.legend}</p>
            {g.hint && <p className="mb-1 text-xs text-[var(--ps-body)]">{g.hint}</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              {SERVICE_KEYS.filter((k) => QUOTE_SERVICES[k].group === g.key).map((k) => (
                <label key={k} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-3 ${service === k ? 'border-[var(--ps-navy)] bg-[var(--ps-navy)] text-white' : 'border-[var(--ps-line,#cfd8e3)] bg-white'}`}>
                  <input type="radio" name="service" value={k} checked={service === k} onChange={() => { setService(k); setErrors((x) => ({ ...x, service: undefined })); requestKey.current = '' }} className="sr-only" />
                  <span className="text-sm font-medium">{QUOTE_SERVICES[k].label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        {errors.service && <p className={err}>{errors.service}</p>}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div><label className={label} htmlFor="q-name">Your name</label><input id="q-name" className={field} autoComplete="name" value={f.name} onChange={set('name')} aria-invalid={!!errors.name} />{errors.name && <p className={err}>{errors.name}</p>}</div>
        <div><label className={label} htmlFor="q-phone">Phone</label><input id="q-phone" className={field} type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} aria-invalid={!!errors.phone} />{errors.phone && <p className={err}>{errors.phone}</p>}</div>
        <div className="sm:col-span-2"><label className={label} htmlFor="q-email">Email</label><input id="q-email" className={field} type="email" inputMode="email" autoComplete="email" value={f.email} onChange={set('email')} aria-invalid={!!errors.email} />{errors.email && <p className={err}>{errors.email}</p>}</div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div><label className={label} htmlFor="q-year">Year</label><input id="q-year" className={field} inputMode="numeric" maxLength={4} value={f.vehicleYear} onChange={set('vehicleYear')} aria-invalid={!!errors.vehicleYear} />{errors.vehicleYear && <p className={err}>{errors.vehicleYear}</p>}</div>
        <div><label className={label} htmlFor="q-make">Make</label><input id="q-make" className={field} value={f.vehicleMake} onChange={set('vehicleMake')} aria-invalid={!!errors.vehicleMake} />{errors.vehicleMake && <p className={err}>{errors.vehicleMake}</p>}</div>
        <div><label className={label} htmlFor="q-model">Model</label><input id="q-model" className={field} value={f.vehicleModel} onChange={set('vehicleModel')} aria-invalid={!!errors.vehicleModel} />{errors.vehicleModel && <p className={err}>{errors.vehicleModel}</p>}</div>
      </div>

      <div>
        <label className={label} htmlFor="q-msg">{prompt.messageLabel}</label>
        {prompt.messageHint && <p id="q-msg-hint" className="mb-1 text-xs text-[var(--ps-body)]">{prompt.messageHint}</p>}
        <textarea id="q-msg" className={field} rows={4} maxLength={1500} value={f.message} onChange={set('message')} aria-describedby={prompt.messageHint ? 'q-msg-hint' : undefined} />
      </div>

      {restoration && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="q-claim">Insurance claim (optional)</label>
            <select id="q-claim" className={field} value={claimStatus} onChange={(e) => { setClaimStatus(e.target.value); requestKey.current = '' }}>
              <option value="">Choose one</option>
              {CLAIM_STATUSES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="q-incident">When did it happen? (optional)</label>
            <input id="q-incident" className={field} type="date" value={f.incidentDate} onChange={set('incidentDate')} aria-invalid={!!errors.incidentDate} />
            {errors.incidentDate && <p className={err}>{errors.incidentDate}</p>}
          </div>
          <p className="text-xs text-[var(--ps-body)] sm:col-span-2">
            This helps us plan, nothing more. Coverage, deductibles and approval are decided by your insurance company. Contact your insurer to open or discuss a claim; we provide a written, itemized estimate and damage documentation and coordinate the repair once you decide to proceed.
          </p>
        </div>
      )}

      <div>
        <span className={label}>Photos ({restoration ? 'recommended' : 'optional'}, up to {MAX_PHOTOS})</span>
        {restoration && <p className="mb-1 text-xs text-[var(--ps-body)]">One wide shot of the vehicle and close-ups of the damage help us estimate accurately.</p>}
        <input type="file" accept="image/*" multiple onChange={(e) => addPhotos(e.target.files)} className="block w-full text-sm" aria-label="Add photos" />
        {errors.photos && <p className={err}>{errors.photos}</p>}
        {photos.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview of the customer's own upload */}
                <img src={p.preview} alt="" className="h-20 w-20 rounded object-cover" />
                <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => { setPhotos(photos.filter((_, j) => j !== i)); requestKey.current = '' }} className="absolute -right-2 -top-2 h-6 w-6 rounded-full bg-black/70 text-xs text-white">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="q-ref">How did you hear about us? (optional)</label>
          <select id="q-ref" className={field} value={referral.source} onChange={(e) => { setReferral({ source: e.target.value, detail: '' }); requestKey.current = '' }}>
            <option value="">Choose one</option>
            {REFERRAL_SOURCES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </div>
        {referral.source === 'other' && (
          <div><label className={label} htmlFor="q-ref-detail">Where?</label><input id="q-ref-detail" className={field} maxLength={120} value={referral.detail} onChange={(e) => { setReferral({ ...referral, detail: e.target.value }); requestKey.current = '' }} /></div>
        )}
      </div>

      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" onChange={(e) => { website.current = e.target.value }} />

      <button type="submit" disabled={busy} className="ps-btn-call w-full disabled:opacity-60">{busy ? 'Sending…' : restoration ? 'Request my estimate' : 'Request my quote'}</button>
      <p className="text-xs text-[var(--ps-body)]">We&apos;ll only use your details to answer this request.</p>
    </form>
  )
}
