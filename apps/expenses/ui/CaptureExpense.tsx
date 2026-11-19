'use client'
/**
 * Business Receipts — employee TAP-FIRST capture + self-filing.
 *
 * SAVED is separated from READ. Snap/upload → the ORIGINAL is preserved and a recoverable receipt row is
 * created FIRST; the employee immediately sees "Photo saved — reading receipt". The AI read continues in the
 * same streamed request while the employee answers three quick questions, then prefills vendor/date/total. A slow or
 * failed read never makes the capture feel lost: the photo is already saved; the employee retries the read
 * (bounded) or just types the few facts. Nothing shows "photo read" unless the read actually succeeded.
 *
 * Interruptions are recoverable: a stable captureId (kept across retries) means a lost/timed-out response
 * never creates a second purchase, and a small sessionStorage marker lets the employee resume an in-progress
 * capture. The employee's typed answers are authoritative — a late read never overwrites them.
 */
import { readReceiptEvents } from '@/apps/expenses/read-events'
import { useEffect, useRef, useState } from 'react'
import {
  BUSINESS_ENTITIES, EXPENSE_CATEGORIES, CAPTURE_PRIMARY_CATEGORIES, CAPTURE_MORE_CATEGORIES,
  attentionReasonLabel, centsToDollars,
} from '@/apps/expenses/types'
import { fileReceiptAction } from '@/apps/expenses/actions'
import { amountsWarning, receiptDateWarning, todayBusinessDate } from '@/apps/expenses/checks'
import JobPicker, { type PickedJob } from './JobPicker'
import VehiclePicker, { type PickedVehicle, type VehicleOption } from './VehiclePicker'
import {
  OTHER_PAYMENT_MAX_LENGTH, OTHER_PAYMENT_FUNDINGS, OTHER_PAYMENT_METHODS, RECEIPT_PAYMENT_CHOICES,
  resolveReceiptPayment, autoSelectPayment,
} from '@/apps/expenses/payment'

export type { VehicleOption }

// The server preserves the ORIGINAL bytes as evidence, so we never re-encode the file we send. The platform
// caps request bodies (~4.5 MB); reject an oversized ORIGINAL up front (never silently shrink the only copy).
const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024
const MAX_READ_ATTEMPTS = 3       // a retry must be safe AND limited — never unlimited AI calls
const RESUME_KEY = 'ps_capture_resume'
const RESUME_TTL_MS = 2 * 60 * 60_000

type Step = 'q1' | 'q2' | 'q2more' | 'q3' | 'confirm' | 'saving'
type SaveState = 'uploading' | 'saved' | 'duplicate' | 'error'   // is the ORIGINAL durably stored?
type ReadState = 'idle' | 'reading' | 'read' | 'failed'          // did the AI read succeed?
interface Proposal {
  vendor: string | null; date: string | null; totalCents: number | null; categoryKey?: string; paymentChoice?: string | null
  subtotalCents?: number | null; taxCents?: number | null; shippingCents?: number | null
  invoiceNumber?: string | null; orderNumber?: string | null; description?: string | null
}
type EvidenceKind = 'photo' | 'pdf' | 'text'
const money = (c: number) => `$${(c / 100).toFixed(2)}`
interface Saved { receiptId: string; fileToken?: string }

const entityLabel = (k: string) => BUSINESS_ENTITIES.find((b) => b.key === k)?.label ?? k
const categoryLabel = (k: string) => EXPENSE_CATEGORIES.find((c) => c.key === k)?.label ?? k
const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`)

function Bubble({ children, onClick, selected = false, variant = 'default' }: { children: React.ReactNode; onClick: () => void; selected?: boolean; variant?: 'default' | 'muted' }) {
  const base = 'w-full text-left rounded-2xl px-4 py-4 text-lg font-semibold border transition active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400'
  const tone = selected ? 'bg-indigo-600 border-indigo-400 text-white' : variant === 'muted' ? 'bg-gray-900 border-gray-800 text-gray-400' : 'bg-gray-800 border-gray-700 text-white'
  return <button type="button" aria-pressed={selected} onClick={onClick} className={`${base} ${tone}`}>{children}</button>
}

function StepShell({ title, children, onBack, previewUrl, badge, kind = 'photo', jobLabel = null }: { title: string; children: React.ReactNode; onBack?: () => void; previewUrl: string | null; badge: React.ReactNode; kind?: EvidenceKind; jobLabel?: string | null }) {
  return (
    <section className="rounded-2xl bg-gray-900 border border-gray-800 p-4" role="group" aria-label={title}>
      {jobLabel && <p className="mb-3 rounded-lg bg-indigo-950/30 border border-indigo-900/50 px-3 py-2 text-xs text-indigo-200 break-words"><span className="text-indigo-400">For job:</span> {jobLabel}</p>}
      <div className="flex items-start gap-3 mb-3">
        {kind === 'photo' && previewUrl && <img src={previewUrl} alt="receipt preview" className="w-14 h-14 rounded-lg object-cover bg-black/40 border border-gray-800" />}
        {kind !== 'photo' && <div aria-hidden="true" className="w-14 h-14 rounded-lg bg-black/40 border border-gray-800 grid place-items-center text-[11px] font-bold tracking-wide text-gray-300">{kind === 'pdf' ? 'PDF' : 'TEXT'}</div>}
        <div className="flex-1">
          <h2 className="text-white font-bold text-lg leading-tight">{title}</h2>
          <p className="text-xs mt-0.5" aria-live="polite">{badge}</p>
        </div>
        {onBack && <button type="button" onClick={onBack} className="text-gray-500 text-sm">Back</button>}
      </div>
      {children}
    </section>
  )
}

export default function CaptureExpense({ vehicles = [], job: startJob = null }: { vehicles?: VehicleOption[]; job?: PickedJob | null }) {
  const camRef = useRef<HTMLInputElement>(null)
  const upRef = useRef<HTMLInputElement>(null)
  const captureId = useRef<string>('')

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [kind, setKind] = useState<EvidenceKind>('photo')
  const [started, setStarted] = useState(false)
  // Started from a customer job → the business is Detail & Service, so skip straight to "what did you buy?".
  const firstStep: Step = startJob ? 'q2' : 'q1'
  const [step, setStep] = useState<Step>(firstStep)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  // The customer job this purchase was for (preselected when capture starts from a job).
  const [job, setJob] = useState<PickedJob | null>(startJob)
  // What the reader found beyond vendor/date/total — shown for review, stored server-side by the read itself.
  const [readExtras, setReadExtras] = useState<Pick<Proposal, 'subtotalCents' | 'taxCents' | 'shippingCents' | 'invoiceNumber' | 'orderNumber' | 'description'>>({})
  const [dateConfirmed, setDateConfirmed] = useState(false)
  const [description, setDescription] = useState('')
  const [pickErr, setPickErr] = useState<string | null>(null)

  const [saveState, setSaveState] = useState<SaveState>('uploading')
  const [readState, setReadState] = useState<ReadState>('idle')
  const [readAttempts, setReadAttempts] = useState(0)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [possibleDup, setPossibleDup] = useState(false)
  const [dupChoice, setDupChoice] = useState<'' | 'different' | 'same'>('')

  // Answers
  const [entity, setEntity] = useState(startJob ? 'detail' : '')
  const [categoryMode, setCategoryMode] = useState<'single' | 'mixed' | 'unsure'>('single')
  const [categoryKey, setCategoryKey] = useState('')
  const [paymentChoice, setPaymentChoice] = useState('')
  const [otherPayment, setOtherPayment] = useState('')
  // An "Other" source is classified EXPLICITLY (whose money + the instrument for business money) — the
  // description is never read to decide funding.
  const [otherFunding, setOtherFunding] = useState('')
  const [otherPaymentMethod, setOtherPaymentMethod] = useState('')
  const paymentTouched = useRef(false)          // set once the employee picks a payment — protects a manual choice
  const [paymentAuto, setPaymentAuto] = useState(false) // the current selection came from the receipt read
  // Confirmed purchase facts. `touched` marks fields the employee changed — a late read never overwrites them.
  const [vendor, setVendor] = useState(''); const vendorT = useRef(false)
  const [date, setDate] = useState(''); const dateT = useRef(false)
  const [total, setTotal] = useState(''); const totalT = useRef(false)
  const [showExtras, setShowExtras] = useState(false)
  const [vehicle, setVehicle] = useState<PickedVehicle | null>(null)
  const [note, setNote] = useState('')

  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ status: string; reasons: string[]; jobLinked?: boolean; jobLinkError?: string; vehicleLinked?: boolean; vehicleLinkError?: string } | null>(null)
  const [resume, setResume] = useState<{ captureId: string; receiptId: string; fileToken?: string } | null>(null)

  // On mount (client only), offer to resume an in-progress capture whose photo is already saved. Deliberately
  // in an effect, not a lazy initializer: sessionStorage is client-only, so reading it after hydration avoids
  // an SSR/client mismatch. The setState here is exactly the intended one-time hydration of that client state.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY)
      if (!raw) return
      const r = JSON.parse(raw) as { captureId: string; receiptId: string; fileToken?: string; ts: number }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (r && r.receiptId && Date.now() - (r.ts || 0) < RESUME_TTL_MS) setResume(r)
      else sessionStorage.removeItem(RESUME_KEY)
    } catch { /* ignore */ }
  }, [])

  function persistResume(s: Saved) {
    try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ captureId: captureId.current, receiptId: s.receiptId, fileToken: s.fileToken, ts: Date.now() })) } catch { /* ignore */ }
  }
  function clearResume() { try { sessionStorage.removeItem(RESUME_KEY) } catch { /* ignore */ } }

  function resetAll() {
    if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null)
    setStarted(false); setStep(firstStep); setPickErr(null); setKind('photo'); setPasteOpen(false); setPasteText('')
    setJob(startJob); setReadExtras({}); setDateConfirmed(false); setDescription('')
    setSaveState('uploading'); setReadState('idle'); setSaved(null); setPossibleDup(false); setDupChoice('')
    setEntity(startJob ? 'detail' : ''); setCategoryMode('single'); setCategoryKey(''); setPaymentChoice(''); setOtherPayment(''); setOtherFunding(''); setOtherPaymentMethod(''); paymentTouched.current = false; setPaymentAuto(false)
    setVendor(''); setDate(''); setTotal(''); vendorT.current = false; dateT.current = false; totalT.current = false
    setShowExtras(false); setVehicle(null); setNote(''); setSaveErr(null); setResult(null)
    captureId.current = ""; setReadAttempts(0)
    if (camRef.current) camRef.current.value = ''
    if (upRef.current) upRef.current.value = ''
  }

  // Prefill a confirm field from the read — ONLY if the employee hasn't touched it (never overwrite answers).
  function applyProposal(p: Proposal | null | undefined) {
    if (!p) return
    if (p.vendor && !vendorT.current) setVendor((v) => v || p.vendor || '')
    if (p.date && !dateT.current) setDate((d) => d || p.date || '')
    setReadExtras({ subtotalCents: p.subtotalCents, taxCents: p.taxCents, shippingCents: p.shippingCents, invoiceNumber: p.invoiceNumber, orderNumber: p.orderNumber, description: p.description })
    if (p.totalCents != null && !totalT.current) setTotal((t) => t || centsToDollars(p.totalCents))
    if (p.categoryKey && p.categoryKey !== 'uncategorized' && categoryMode === 'single' && !categoryKey) setCategoryKey(p.categoryKey)
    // Auto-select the matching payment bubble the receipt identified — never over a choice the employee made
    // (shared, unit-tested guard: a late/retry read can't overwrite a manual selection).
    const sel = autoSelectPayment(paymentChoice, paymentTouched.current, p.paymentChoice)
    if (sel.auto) { setPaymentChoice(sel.choice); setPaymentAuto(true) }
  }

  async function runExtract(receiptId: string, token?: string) {
    if (readAttempts >= MAX_READ_ATTEMPTS) { setReadState('failed'); return }
    setReadAttempts((n) => n + 1)
    setReadState('reading')
    try {
      const res = await fetch(`/api/expenses/receipt/${receiptId}/extract`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j.ok && j.aiStatus === 'extracted') {
        applyProposal(j.proposal)
        setPossibleDup(!!j.possibleDuplicate)
        setReadState('read')
      } else {
        setReadState('failed')   // saved, but not read — honest; employee can retry or type
      }
    } catch { setReadState('failed') }
  }

  async function doUpload(payload: { file: File } | { text: string }) {
    setSaveState('uploading'); setReadState('idle')
    let photoSaved = false
    try {
      const fd = new FormData(); fd.set('captureId', captureId.current)
      if ('file' in payload) fd.set('receipt', payload.file); else fd.set('text', payload.text)
      const res = await fetch('/api/expenses/receipt', { method: 'POST', headers: { accept: 'application/x-ndjson' }, body: fd })
      if (res.ok && res.headers.get('content-type')?.includes('application/x-ndjson') && res.body) {
        type Event = { type: 'saved' | 'read'; ok: boolean; receiptId: string; fileToken?: string; aiStatus?: string; proposal?: Proposal; possibleDuplicate?: unknown }
        let readFinished = false
        for await (const event of readReceiptEvents<Event>(res.body)) {
          if (event.type === 'saved' && event.ok && event.receiptId) {
            const s = { receiptId: event.receiptId, fileToken: event.fileToken }
            photoSaved = true
            setSaved(s); setSaveState('saved'); persistResume(s)
            setReadAttempts((n) => n + 1); setReadState('reading')
          } else if (event.type === 'read' && photoSaved) {
            readFinished = true
            if (event.ok && event.aiStatus === 'extracted') {
              applyProposal(event.proposal); setPossibleDup(!!event.possibleDuplicate); setReadState('read')
            } else setReadState('failed')
          }
        }
        if (!photoSaved) throw new Error('Missing save acknowledgement')
        if (!readFinished) setReadState('failed')
        return
      }
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) { setSaveState('error'); setSaveErr(j.error || 'Could not save the receipt — try again.'); return }
      if (j.alreadyCaptured || (j.duplicate && !j.receiptId)) { setSaveState('duplicate'); return }
      const s: Saved = { receiptId: j.receiptId, fileToken: j.fileToken }
      setSaved(s); setSaveState('saved'); persistResume(s)
      if (j.resumed && j.proposal) { applyProposal(j.proposal); setReadState('read') }
      else runExtract(s.receiptId, s.fileToken)   // fire the read; the employee answers meanwhile
    } catch {
      if (photoSaved) setReadState('failed')
      else { setSaveState('error'); setSaveErr('Connection interrupted — try again to save or recover this photo.') }
    }
  }

  function pick(f: File | null) {
    if (!f) return
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    if (f.size > MAX_ORIGINAL_BYTES) { setPickErr(isPdf ? 'This PDF is too large (over 4 MB). Save just the invoice page and try again.' : 'This photo is too large. Retake it at a lower resolution (under 4 MB).'); return }
    setPickErr(null); setKind(isPdf ? 'pdf' : 'photo')
    setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return isPdf ? null : URL.createObjectURL(f) })
    captureId.current = uuid(); setReadAttempts(0)
    doUpload({ file: f })
    setStarted(true); setStep(firstStep)
  }
  /** Pasted email / order-confirmation text → saved verbatim as the evidence, then read like a photo. */
  function pickText() {
    const text = pasteText.trim()
    if (text.length < 20) { setPickErr('Paste the whole receipt email or order confirmation first.'); return }
    if (text.length > 20_000) { setPickErr('That is too long — paste just the receipt part of the email.'); return }
    setPickErr(null); setKind('text'); setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return null })
    captureId.current = uuid(); setReadAttempts(0)
    doUpload({ text })
    setStarted(true); setStep(firstStep)
  }

  async function doResume() {
    if (!resume) return
    captureId.current = resume.captureId
    setSaved({ receiptId: resume.receiptId, fileToken: resume.fileToken })
    setSaveState('saved'); setResume(null); setStarted(true); setStep(firstStep)
    setReadAttempts(0)
    runExtract(resume.receiptId, resume.fileToken)  // fetch the (already-finished or re-run) read
  }
  function discardResume() { clearResume(); setResume(null) }

  async function save() {
    const payment = resolveReceiptPayment(paymentChoice, otherPayment, { funding: otherFunding, paymentMethod: otherPaymentMethod })
    if (!payment.ok) { setSaveErr(payment.error); setStep('q3'); return }
    if (possibleDup && !dupChoice) { setSaveErr('Tell us if this is the same purchase or a different one.'); return }
    if (!saved?.receiptId) { setSaveErr(saveState === 'duplicate' ? 'This receipt was already captured.' : 'The receipt hasn’t saved yet — one moment.'); return }
    if (receiptDateWarning(date, todayBusinessDate()) && !dateConfirmed) { setSaveErr('Check the date above — fix it, or confirm it is right.'); return }
    if (vehicle && job) { setSaveErr('Choose a customer job or a sales vehicle for this receipt — not both.'); return }
    if (vehicle && vehicle.matchEventId === undefined) { setSaveErr('Tell us whether this purchase is already entered on the vehicle.'); return }
    setSaveErr(null); setStep('saving')
    const res = await fileReceiptAction({
      id: saved.receiptId, token: saved.fileToken,
      entity, category: categoryKey, categoryMode, paymentChoice, otherPayment,
      otherFunding: otherFunding || undefined, otherPaymentMethod: otherPaymentMethod || undefined,
      vendor, receiptDate: date, total,
      filingNote: note || undefined,
      inventoryVehicleId: vehicle?.id || undefined, vehicleMatchEventId: vehicle?.matchEventId || undefined,
      serviceOrderId: job?.id, dateConfirmed: dateConfirmed || undefined,
      description: description.trim() || undefined,
      duplicate: possibleDup && dupChoice === 'same',   // flag as a duplicate → manager resolves, CFO won't count it
    })
    if (!res.ok) { setSaveErr(res.error || 'Could not save — try again.'); setStep('confirm'); return }
    clearResume()
    setResult({ status: res.status ?? 'needs_review', reasons: res.reasons ?? [], jobLinked: res.jobLinked, jobLinkError: res.jobLinkError, vehicleLinked: res.vehicleLinked, vehicleLinkError: res.vehicleLinkError })
  }

  // ── IDLE ──
  if (!started && !result) {
    return (
      <section className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
        <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <input ref={upRef} type="file" accept="image/*,application/pdf,.pdf" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        {job && <p className="mb-3 rounded-lg bg-indigo-950/30 border border-indigo-900/50 px-3 py-2 text-sm text-indigo-200 break-words"><span className="text-indigo-400">For job:</span> {job.label}</p>}
        {resume && (
          <div className="mb-3 rounded-xl border border-indigo-900/60 bg-indigo-950/20 p-3">
            <p className="text-indigo-200 text-sm font-semibold">You have a receipt in progress.</p>
            <p className="text-gray-400 text-xs mt-0.5">Your photo is saved. Pick up where you left off.</p>
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={doResume} className="flex-1 bg-indigo-600 text-white font-semibold py-2 rounded-xl">Resume</button>
              <button type="button" onClick={discardResume} className="text-gray-500 text-sm px-3">Discard</button>
            </div>
          </div>
        )}
        <div className="space-y-3">
          <button type="button" onClick={() => camRef.current?.click()} className="w-full bg-indigo-600 active:bg-indigo-700 text-white text-lg font-bold py-5 rounded-2xl">📷 Snap a Receipt</button>
          <button type="button" onClick={() => upRef.current?.click()} className="w-full border border-gray-700 text-gray-200 text-base font-semibold py-3 rounded-2xl">Upload a Photo or PDF</button>
          {!pasteOpen ? (
            <button type="button" onClick={() => setPasteOpen(true)} className="w-full text-indigo-300 text-sm py-3">Paste receipt text from an email</button>
          ) : (
            <div className="space-y-2">
              <label className="block text-xs text-gray-500">Receipt or order-confirmation text
                <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={6} placeholder="Paste the email here…"
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
              </label>
              <button type="button" onClick={pickText} disabled={pasteText.trim().length < 20} className="w-full bg-indigo-600 text-white font-bold py-3 rounded-2xl disabled:opacity-50">Read this text</button>
            </div>
          )}
          {pickErr && <p role="alert" className="text-amber-400 text-sm">{pickErr}</p>}
        </div>
      </section>
    )
  }

  // ── DONE ──
  if (result) {
    const filed = result.status === 'filed'
    return (
      <section className="rounded-2xl bg-gray-900 border border-gray-800 p-6 text-center space-y-3">
        <div className="text-5xl">{filed ? '✅' : '📝'}</div>
        {filed ? (
          <>
            <p className="text-white font-semibold text-lg">Saved under {entityLabel(entity)} → {categoryLabel(categoryKey)}.</p>
            <p className="text-gray-500 text-sm">Filed by you. It’s in the shop’s records — no manager sign-off needed.</p>
          </>
        ) : (
          <>
            <p className="text-white font-semibold text-lg">Saved — needs clarification.</p>
            <p className="text-amber-300/90 text-sm">{result.reasons.map(attentionReasonLabel).join(' · ') || 'A manager will take a quick look.'}</p>
            <p className="text-gray-500 text-sm">Nothing more to do — a manager will finish filing it.</p>
          </>
        )}
        {job && result.jobLinked && <p className="text-indigo-200 text-sm break-words">Attached to {job.label}. The customer’s invoice was not changed.</p>}
        {vehicle && result.vehicleLinked && <p className="text-indigo-200 text-sm break-words">{vehicle.matchEventId ? `Attached to the expense already on ${vehicle.label} — counted once.` : `Added to ${vehicle.label}’s expenses${filed ? '' : ' as pending until a manager files it'}.`}</p>}
        {vehicle && result.vehicleLinked === false && <p role="alert" className="text-amber-300 text-sm">The receipt is saved, but it could not be assigned to the vehicle{result.vehicleLinkError ? ` (${result.vehicleLinkError})` : ''}. A manager can assign it from Receipts.</p>}
        {job && result.jobLinked === false && <p role="alert" className="text-amber-300 text-sm">The receipt is saved, but it could not be attached to the job{result.jobLinkError ? ` (${result.jobLinkError})` : ''}. A manager can attach it from the job’s Expenses section.</p>}
        {startJob && <a href={`/orders/${startJob.id}`} className="block w-full bg-indigo-600 active:bg-indigo-700 text-white text-base font-bold py-4 rounded-2xl mt-2">Back to the job</a>}
        <button type="button" onClick={resetAll} className={startJob ? 'w-full border border-gray-700 text-gray-200 text-base font-semibold py-3 rounded-2xl' : 'w-full bg-indigo-600 active:bg-indigo-700 text-white text-base font-bold py-4 rounded-2xl mt-2'}>Capture Another</button>
      </section>
    )
  }

  // ── Honest status badge: SAVED vs READ are separate; never claim "read" on failure, no invented % ──
  const noun = kind === 'pdf' ? 'PDF' : kind === 'text' ? 'text' : 'photo'
  const badge =
    saveState === 'uploading' ? <span className="text-gray-500">saving {noun}…</span>
    : saveState === 'error' ? <span className="text-red-400">not saved — try again</span>
    : saveState === 'duplicate' ? <span className="text-amber-300">already captured</span>
    : readState === 'reading' ? <span className="text-emerald-400">{noun} saved ✓ · reading…</span>
    : readState === 'read' ? <span className="text-emerald-400">{noun} saved ✓ · read ✓</span>
    : readState === 'failed' ? <span className="text-amber-300">{noun} saved ✓ · couldn’t read</span>
    : <span className="text-emerald-400">{noun} saved ✓</span>
  const shell = { previewUrl, badge, kind, jobLabel: job?.label ?? null }

  if (step === 'q1') {
    return (
      <StepShell title="Which business?" onBack={resetAll} {...shell}>
        <div className="space-y-3">
          {BUSINESS_ENTITIES.filter((b) => b.key !== 'unassigned').map((b) => (
            <Bubble key={b.key} selected={entity === b.key} onClick={() => { setEntity(b.key); setStep('q2') }}>{b.label}</Bubble>
          ))}
        </div>
      </StepShell>
    )
  }

  if (step === 'q2') {
    const chooseSingle = (key: string) => { setCategoryMode('single'); setCategoryKey(key); setStep('q3') }
    return (
      <StepShell title="What did you buy?" onBack={startJob ? resetAll : () => setStep('q1')} {...shell}>
        <div className="space-y-3">
          {CAPTURE_PRIMARY_CATEGORIES.map((c) => (
            <Bubble key={c.key} selected={categoryMode === 'single' && categoryKey === c.key} onClick={() => chooseSingle(c.key)}>{c.label}</Bubble>
          ))}
          <Bubble variant="muted" onClick={() => setStep('q2more')}>More categories…</Bubble>
          <Bubble variant="muted" selected={categoryMode === 'mixed'} onClick={() => { setCategoryMode('mixed'); setCategoryKey(''); setStep('q3') }}>More than one category</Bubble>
          <Bubble variant="muted" selected={categoryMode === 'unsure'} onClick={() => { setCategoryMode('unsure'); setCategoryKey(''); setStep('q3') }}>Other / Not sure</Bubble>
        </div>
      </StepShell>
    )
  }

  if (step === 'q2more') {
    const chooseSingle = (key: string) => { setCategoryMode('single'); setCategoryKey(key); setStep('q3') }
    return (
      <StepShell title="What did you buy?" onBack={() => setStep('q2')} {...shell}>
        <div className="space-y-2">
          {CAPTURE_MORE_CATEGORIES.map((c) => (
            <Bubble key={c.key} selected={categoryMode === 'single' && categoryKey === c.key} onClick={() => chooseSingle(c.key)}>{c.label}</Bubble>
          ))}
        </div>
      </StepShell>
    )
  }

  if (step === 'q3') {
    // paymentAuto is cleared the moment the employee picks anything, so it alone reflects "still auto-selected".
    const autoLabel = paymentAuto && paymentChoice ? (RECEIPT_PAYMENT_CHOICES.find((c) => c.key === paymentChoice)?.label ?? '') : ''
    const pick = (key: string) => { paymentTouched.current = true; setPaymentAuto(false); setPaymentChoice(key); setSaveErr(null) }
    return (
      <StepShell title="How did we pay for it?" onBack={() => setStep('q2')} {...shell}>
        <div className="space-y-3">
          {autoLabel && <p className="text-emerald-400 text-sm">Read from the receipt: <span className="font-semibold">{autoLabel}</span> — tap to confirm, or pick another.</p>}
          {RECEIPT_PAYMENT_CHOICES.map((c) => (
            <Bubble key={c.key} selected={paymentChoice === c.key}
              onClick={() => { pick(c.key); if (c.key !== 'other') { setOtherPayment(''); setOtherFunding(''); setOtherPaymentMethod(''); setStep('confirm') } }}>{c.label}</Bubble>
          ))}
          {paymentChoice === 'other' && (
            <div className="space-y-3">
              <label className="block text-sm text-gray-300">How was it paid?
                <input autoFocus value={otherPayment} onChange={(e) => setOtherPayment(e.target.value)} maxLength={OTHER_PAYMENT_MAX_LENGTH}
                  placeholder="e.g. AMEX 5008" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
              </label>
              {/* Whose money — asked outright, never guessed from the text above. */}
              <fieldset className="space-y-2">
                <legend className="text-sm text-gray-300">Whose money was it?</legend>
                {OTHER_PAYMENT_FUNDINGS.map((f) => (
                  <Bubble key={f.key} variant={f.key === 'unclassified' ? 'muted' : 'default'} selected={otherFunding === f.key}
                    onClick={() => { setOtherFunding(f.key); if (f.key !== 'business') setOtherPaymentMethod('') }}>{f.label}</Bubble>
                ))}
              </fieldset>
              {otherFunding === 'business' && (
                <label className="block text-sm text-gray-300">How was it paid? (business money needs the method)
                  <select value={otherPaymentMethod} onChange={(e) => setOtherPaymentMethod(e.target.value)}
                    className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white">
                    <option value="">Choose…</option>
                    {OTHER_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m === 'ach' ? 'ACH / bank transfer' : m}</option>)}
                  </select>
                </label>
              )}
              <button type="button" onClick={() => setStep('confirm')}
                disabled={!resolveReceiptPayment(paymentChoice, otherPayment, { funding: otherFunding, paymentMethod: otherPaymentMethod }).ok
                  || !otherFunding || (otherFunding === 'business' && !otherPaymentMethod)}
                className="w-full bg-indigo-600 text-white font-bold py-3 rounded-xl disabled:opacity-50">Continue</button>
              <p className="text-xs text-gray-500">
                {otherFunding === 'business' ? 'Recorded as a business purchase from this source.'
                  : otherFunding === 'personal' ? 'Saved for a reimbursement review — not business cash.'
                  : 'If you’re not sure, pick “Not sure” — a manager will classify this payment source.'}
              </p>
            </div>
          )}
          <button type="button" className="text-gray-400 text-sm py-2" onClick={() => { pick('unpaid'); setOtherPayment(''); setOtherFunding(''); setOtherPaymentMethod(''); setStep('confirm') }}>Not paid yet</button>
          {saveErr && <p className="text-red-400 text-sm">{saveErr}</p>}
        </div>
      </StepShell>
    )
  }

  // confirm / saving
  const saving = step === 'saving'
  const catText = categoryMode === 'single' ? categoryLabel(categoryKey) : categoryMode === 'mixed' ? 'More than one category' : 'Other / Not sure'
  const fundText = paymentChoice === 'other'
    ? `Other: ${otherPayment.trim()}${otherFunding === 'business' ? ` · business ${otherPaymentMethod}` : otherFunding === 'personal' ? ' · personal money' : ' · not yet classified'}`
    : paymentChoice === 'unpaid' ? 'Not paid yet' : RECEIPT_PAYMENT_CHOICES.find((c) => c.key === paymentChoice)?.label ?? '—'
  const missing = (v: string) => v.trim() === ''
  const set = <T,>(setter: (v: T) => void, touched: React.MutableRefObject<boolean>) => (v: T) => { touched.current = true; setter(v) }
  const dateWarn = receiptDateWarning(date, todayBusinessDate())
  const totalCentsTyped = total.trim() === '' ? null : Math.round(parseFloat(total.replace(/[^0-9.]/g, '') || '0') * 100)
  const sumWarn = amountsWarning({ ...readExtras, totalCents: totalCentsTyped })
  const readLine = [
    readExtras.subtotalCents != null ? `subtotal ${money(readExtras.subtotalCents)}` : null,
    readExtras.shippingCents != null ? `shipping ${money(readExtras.shippingCents)}` : null,
    readExtras.taxCents != null ? `tax ${money(readExtras.taxCents)}` : null,
    readExtras.invoiceNumber ? `invoice ${readExtras.invoiceNumber}` : null,
    readExtras.orderNumber ? `order ${readExtras.orderNumber}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <StepShell title="Check the details" onBack={saving ? undefined : () => setStep('q3')} {...shell}>
      <div className="space-y-3">
        <div className="text-xs text-gray-400 flex flex-wrap gap-x-2 gap-y-1">
          <span className="text-gray-300">{entityLabel(entity)}</span><span>·</span>
          <span className="text-gray-300">{catText}</span><span>·</span>
          <span className="text-gray-300">{fundText}</span>
        </div>

        {readState === 'reading' && <p className="text-gray-500 text-sm">Reading the {noun}… you can fill these in now if you like.</p>}
        {readState === 'failed' && (
          <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-sm">
            <p className="text-amber-300">Your {noun} is saved, but we couldn’t read it automatically.</p>
            <button type="button" onClick={() => saved && runExtract(saved.receiptId, saved.fileToken)} disabled={readAttempts >= MAX_READ_ATTEMPTS}
              className="text-indigo-300 underline mt-1 disabled:opacity-40 disabled:no-underline">{readAttempts >= MAX_READ_ATTEMPTS ? 'Enter the details below' : 'Try reading again'}</button>
          </div>
        )}
        {(paymentChoice === 'personal' || (paymentChoice === 'other' && otherFunding === 'personal')) && <p className="text-amber-300 text-sm">Personal payment — saved for manager review. This does not record a reimbursement.</p>}
        {paymentChoice === 'other' && otherFunding === 'unclassified' && <p className="text-amber-300 text-sm">Payment source not classified — a manager will confirm whether “{otherPayment.trim()}” is business or personal.</p>}

        {possibleDup && (
          <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 space-y-2">
            <p className="text-amber-300 text-sm">This looks like a receipt you already captured (same store, date, and total).</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setDupChoice('different')} className={`flex-1 py-2 rounded-xl text-sm font-semibold border ${dupChoice === 'different' ? 'bg-indigo-600 border-indigo-400 text-white' : 'border-gray-700 text-gray-200'}`}>Different purchase</button>
              <button type="button" onClick={() => setDupChoice('same')} className={`flex-1 py-2 rounded-xl text-sm font-semibold border ${dupChoice === 'same' ? 'bg-indigo-600 border-indigo-400 text-white' : 'border-gray-700 text-gray-200'}`}>Same — I already have it</button>
            </div>
            {dupChoice === 'same' && <p className="text-gray-400 text-xs">We’ll flag this so it isn’t counted twice; a manager will tidy it up.</p>}
          </div>
        )}

        <label className="block text-xs text-gray-500">Store / vendor {missing(vendor) && <span className="text-amber-400">· needed</span>}
          <input value={vendor} onChange={(e) => set(setVendor, vendorT)(e.target.value)} disabled={saving} placeholder="e.g. O’Reilly Auto Parts" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-gray-500">Date {missing(date) && <span className="text-amber-400">· needed</span>}
            <input type="date" value={date} onChange={(e) => { setDateConfirmed(false); set(setDate, dateT)(e.target.value) }} disabled={saving} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
          </label>
          <label className="block text-xs text-gray-500">Total {missing(total) && <span className="text-amber-400">· needed</span>}
            <input value={total} onChange={(e) => set(setTotal, totalT)(e.target.value)} disabled={saving} inputMode="decimal" placeholder="0.00" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
          </label>
        </div>

        {dateWarn && !dateConfirmed && (
          <div role="alert" className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 space-y-2">
            <p className="text-amber-300 text-sm">{dateWarn.message}</p>
            <div className="flex gap-2">
              {dateWarn.suggestion && <button type="button" disabled={saving} onClick={() => { dateT.current = true; setDate(dateWarn.suggestion as string); setSaveErr(null) }} className="flex-1 py-3 rounded-xl text-sm font-semibold bg-indigo-600 text-white">Use {dateWarn.suggestion}</button>}
              <button type="button" disabled={saving} onClick={() => { setDateConfirmed(true); setSaveErr(null) }} className="flex-1 py-3 rounded-xl text-sm font-semibold border border-gray-700 text-gray-200">The date is right</button>
            </div>
          </div>
        )}
        {readLine && <p className="text-gray-500 text-xs break-words">Read from the receipt: {readLine}. Shipping and tax are already inside the total.</p>}
        {sumWarn && <p role="alert" className="text-amber-300 text-sm">{sumWarn}</p>}

        {/* Auto Sales vehicle — asked right here (never tucked away). Hidden only when this is a customer-job expense. */}
        {!job && (
          <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3 space-y-2">
            <p className="text-sm text-gray-200 font-semibold">Assign to Auto Sales Vehicle <span className="text-gray-500 font-normal">(optional)</span></p>
            <p className="text-xs text-gray-500">Only for a car we are selling. The receipt then shows under that vehicle’s expenses.</p>
            <VehiclePicker vehicles={vehicles} value={vehicle} onChange={(v) => { setVehicle(v); setSaveErr(null) }} total={total} date={date} receiptId={saved?.receiptId} disabled={saving} />
          </div>
        )}

        {!showExtras ? (
          <button type="button" onClick={() => setShowExtras(true)} className="text-indigo-300 text-sm py-2">{job || vehicle ? '+ Add a description or note (optional)' : '+ Add a customer job or note (optional)'}</button>
        ) : (
          <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
            {!startJob && !vehicle && (
              <div className="text-xs text-gray-500">Customer job (optional — if this was bought for a customer’s car)
                <div className="mt-1"><JobPicker value={job} onChange={setJob} disabled={saving} /></div>
              </div>
            )}
            <label className="block text-xs text-gray-500">What was it? (optional)
              <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={saving} maxLength={300} placeholder={readExtras.description || 'e.g. seat cushion foam'} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
            </label>
            <label className="block text-xs text-gray-500">Note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} placeholder="Anything a manager should know" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
            </label>
          </div>
        )}

        {saveState === 'duplicate' && <p className="text-amber-300 text-sm rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2">This receipt was already captured — no need to send it again.</p>}
        {saveState === 'error' && <p className="text-red-400 text-sm">The {noun} didn’t save. Go back and try again.</p>}
        {saveErr && <p className="text-red-400 text-sm">{saveErr}</p>}

        <button type="button" onClick={save} disabled={saving || saveState === 'duplicate' || saveState === 'error'}
          className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl disabled:opacity-50">
          {saving ? 'Saving…' : job ? 'Save expense to this job' : 'Save receipt'}
        </button>
        {job && <p className="text-gray-500 text-xs text-center">Saves our cost only. No customer price is needed and the customer’s invoice is not changed.</p>}
        <p className="text-gray-600 text-xs text-center">You’re filing this yourself. If anything’s missing we’ll flag it for a manager.</p>
      </div>
    </StepShell>
  )
}
