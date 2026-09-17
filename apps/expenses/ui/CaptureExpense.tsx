'use client'
/**
 * Business Receipts — employee TAP-FIRST capture + self-filing.
 *
 * Snap/upload → three quick questions (big bubbles, no typing needed for most receipts) → confirm the
 * vendor/date/total the photo read → Save. An ordinary complete receipt is FILED immediately by the
 * employee (no "a manager will review it"). An incomplete / mixed / personal / unpaid / unsure receipt is
 * still SAVED — flagged "needs clarification" for a manager — the employee is never trapped in the form.
 *
 * The upload runs in the BACKGROUND while the employee answers the questions (the answers don't depend on
 * the image), so the AI read overlaps the human's taps. The employee's confirmed vendor/date/total are
 * authoritative — the server writes them over any AI proposal, and a filed receipt can't be re-read over.
 * A signed capture token returned by the upload authorizes filing THIS receipt only.
 */
import { useRef, useState } from 'react'
import {
  BUSINESS_ENTITIES, EXPENSE_CATEGORIES, CAPTURE_PRIMARY_CATEGORIES, CAPTURE_MORE_CATEGORIES,
  attentionReasonLabel, centsToDollars,
} from '@/apps/expenses/types'
import { fileReceiptAction } from '@/apps/expenses/actions'
import { OTHER_PAYMENT_MAX_LENGTH, RECEIPT_PAYMENT_CHOICES, resolveReceiptPayment } from '@/apps/expenses/payment'

export interface VehicleOption { id: string; label: string }

// The server preserves the ORIGINAL uploaded bytes as evidence, so we never re-encode the file we send.
// The platform caps request bodies (~4.5 MB); reject an oversized ORIGINAL up front (never silently shrink
// the only stored copy). Kept a touch below the server cap for multipart overhead.
const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024

type Step = 'q1' | 'q2' | 'q2more' | 'q3' | 'confirm' | 'saving'
type UploadState = 'uploading' | 'ready' | 'duplicate' | 'error'
interface Proposal { vendor: string | null; date: string | null; totalCents: number | null }
interface UploadResult { ok: boolean; receiptId?: string; fileToken?: string; duplicate?: boolean; aiStatus?: string; proposal?: Proposal; error?: string }
const entityLabel = (k: string) => BUSINESS_ENTITIES.find((b) => b.key === k)?.label ?? k
const categoryLabel = (k: string) => EXPENSE_CATEGORIES.find((c) => c.key === k)?.label ?? k

// Large, accessible selection bubble. `selected` gets a clear ring; everything is a real <button>.
function Bubble({ children, onClick, selected = false, variant = 'default' }: { children: React.ReactNode; onClick: () => void; selected?: boolean; variant?: 'default' | 'muted' }) {
  const base = 'w-full text-left rounded-2xl px-4 py-4 text-lg font-semibold border transition active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400'
  const tone = selected
    ? 'bg-indigo-600 border-indigo-400 text-white'
    : variant === 'muted'
      ? 'bg-gray-900 border-gray-800 text-gray-400'
      : 'bg-gray-800 border-gray-700 text-white'
  return <button type="button" aria-pressed={selected} onClick={onClick} className={`${base} ${tone}`}>{children}</button>
}

// One step's chrome: the question title, a small preview thumbnail, the live upload badge and a Back link.
// Hoisted to module scope (never re-created during render) so its children keep their state across steps.
function StepShell({ title, children, onBack, previewUrl, uploadBadge }: { title: string; children: React.ReactNode; onBack?: () => void; previewUrl: string | null; uploadBadge: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-gray-900 border border-gray-800 p-4" role="group" aria-label={title}>
      <div className="flex items-start gap-3 mb-3">
        {previewUrl && <img src={previewUrl} alt="receipt preview" className="w-14 h-14 rounded-lg object-cover bg-black/40 border border-gray-800" />}
        <div className="flex-1">
          <h2 className="text-white font-bold text-lg leading-tight">{title}</h2>
          <p className="text-xs mt-0.5">{uploadBadge}</p>
        </div>
        {onBack && <button type="button" onClick={onBack} className="text-gray-500 text-sm">Back</button>}
      </div>
      {children}
    </section>
  )
}

export default function CaptureExpense({ vehicles = [] }: { vehicles?: VehicleOption[] }) {
  const camRef = useRef<HTMLInputElement>(null)
  const upRef = useRef<HTMLInputElement>(null)
  const uploadPromise = useRef<Promise<UploadResult> | null>(null)

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [started, setStarted] = useState(false)          // in the flow (vs idle)
  const [step, setStep] = useState<Step>('q1')
  const [pickErr, setPickErr] = useState<string | null>(null)

  const [uploadState, setUploadState] = useState<UploadState>('uploading')
  const [upload, setUpload] = useState<UploadResult | null>(null)

  // Answers
  const [entity, setEntity] = useState('')
  const [categoryMode, setCategoryMode] = useState<'single' | 'mixed' | 'unsure'>('single')
  const [categoryKey, setCategoryKey] = useState('')
  const [paymentChoice, setPaymentChoice] = useState('')
  const [otherPayment, setOtherPayment] = useState('')
  // Confirmed purchase facts (prefilled from the AI proposal when it arrives, unless already typed)
  const [vendor, setVendor] = useState('')
  const [date, setDate] = useState('')
  const [total, setTotal] = useState('')
  const [showExtras, setShowExtras] = useState(false)
  const [vehicleId, setVehicleId] = useState('')
  const [note, setNote] = useState('')

  // Result
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ status: string; reasons: string[] } | null>(null)

  function resetAll() {
    if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null)
    setStarted(false); setStep('q1'); setPickErr(null)
    setUploadState('uploading'); setUpload(null); uploadPromise.current = null
    setEntity(''); setCategoryMode('single'); setCategoryKey(''); setPaymentChoice(''); setOtherPayment('')
    setVendor(''); setDate(''); setTotal(''); setShowExtras(false); setVehicleId(''); setNote('')
    setSaveErr(null); setResult(null)
    if (camRef.current) camRef.current.value = ''
    if (upRef.current) upRef.current.value = ''
  }

  async function doUpload(f: File): Promise<UploadResult> {
    try {
      const fd = new FormData(); fd.set('receipt', f)
      const res = await fetch('/api/expenses/receipt', { method: 'POST', body: fd })
      const j = (await res.json().catch(() => ({}))) as UploadResult
      if (!res.ok || !j.ok) return { ok: false, error: j.error || 'Could not send the photo — try again.' }
      return j
    } catch { return { ok: false, error: 'No connection — try again in a moment.' } }
  }

  function pick(f: File | null) {
    if (!f) return
    if (f.size > MAX_ORIGINAL_BYTES) { setPickErr('This photo is too large. Retake it at a lower resolution (under 4 MB).'); return }
    setPickErr(null)
    setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(f) })
    // Fire the upload in the BACKGROUND; the employee answers the questions meanwhile.
    setUploadState('uploading'); setUpload(null)
    const p = doUpload(f)
    uploadPromise.current = p
    p.then((r) => {
      setUpload(r)
      setUploadState(!r.ok ? 'error' : r.duplicate ? 'duplicate' : 'ready')
      // Prefill the confirm fields from the proposal, but never clobber anything already typed.
      if (r.ok && r.proposal) {
        if (r.proposal.vendor) setVendor((v) => v || r.proposal!.vendor || '')
        if (r.proposal.date) setDate((d) => d || r.proposal!.date || '')
        if (r.proposal.totalCents != null) setTotal((t) => t || centsToDollars(r.proposal!.totalCents))
      }
    })
    setStarted(true); setStep('q1')
  }

  async function save() {
    const payment = resolveReceiptPayment(paymentChoice, otherPayment)
    if (!payment.ok) { setSaveErr(payment.error); setStep('q3'); return }
    setSaveErr(null); setStep('saving')
    // The upload may still be in flight — wait for it (overlapped with the human answering).
    let up = upload
    if (!up && uploadPromise.current) up = await uploadPromise.current
    if (!up || !up.ok) { setSaveErr(up?.error || 'The photo didn’t upload — go back and retake it.'); setStep('confirm'); return }
    if (up.duplicate || !up.receiptId) { setSaveErr('This receipt was already captured — no need to send it again.'); setStep('confirm'); return }
    const res = await fileReceiptAction({
      id: up.receiptId, token: up.fileToken,
      entity, category: categoryKey, categoryMode, paymentChoice, otherPayment,
      vendor, receiptDate: date, total,
      filingNote: note || undefined,
      inventoryVehicleId: vehicleId || undefined,
    })
    if (!res.ok) { setSaveErr(res.error || 'Could not save — try again.'); setStep('confirm'); return }
    setResult({ status: res.status ?? 'needs_review', reasons: res.reasons ?? [] })
  }

  // ── IDLE ──
  if (!started && !result) {
    return (
      <section className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
        <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <input ref={upRef} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <div className="space-y-3">
          <button type="button" onClick={() => camRef.current?.click()} className="w-full bg-indigo-600 active:bg-indigo-700 text-white text-lg font-bold py-5 rounded-2xl">📷 Snap a Receipt</button>
          <button type="button" onClick={() => upRef.current?.click()} className="w-full border border-gray-700 text-gray-200 text-base font-semibold py-3 rounded-2xl">Upload a Photo</button>
          {pickErr && <p className="text-amber-400 text-sm">{pickErr}</p>}
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
        <button type="button" onClick={resetAll} className="w-full bg-indigo-600 active:bg-indigo-700 text-white text-base font-bold py-4 rounded-2xl mt-2">Capture Another</button>
      </section>
    )
  }

  // ── FLOW ──
  const uploadBadge =
    uploadState === 'uploading' ? <span className="text-gray-500">reading photo…</span>
    : uploadState === 'ready' ? <span className="text-emerald-400">photo read ✓</span>
    : uploadState === 'duplicate' ? <span className="text-amber-300">already captured</span>
    : <span className="text-red-400">upload failed</span>

  const shell = { previewUrl, uploadBadge }

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
      <StepShell title="What did you buy?" onBack={() => setStep('q1')} {...shell}>
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
    return (
      <StepShell title="How did we pay for it?" onBack={() => setStep('q2')} {...shell}>
        <div className="space-y-3">
          {RECEIPT_PAYMENT_CHOICES.map((c) => (
            <Bubble key={c.key} selected={paymentChoice === c.key}
              onClick={() => { setPaymentChoice(c.key); setSaveErr(null); if (c.key !== 'other') { setOtherPayment(''); setStep('confirm') } }}>{c.label}</Bubble>
          ))}
          {paymentChoice === 'other' && (
            <div className="space-y-3">
              <label className="block text-sm text-gray-300">How was it paid?
                <input autoFocus value={otherPayment} onChange={(e) => setOtherPayment(e.target.value)} maxLength={OTHER_PAYMENT_MAX_LENGTH}
                  placeholder="e.g. company Amex" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
              </label>
              <button type="button" disabled={!resolveReceiptPayment(paymentChoice, otherPayment).ok} onClick={() => setStep('confirm')}
                className="w-full bg-indigo-600 text-white font-bold py-3 rounded-xl disabled:opacity-50">Continue</button>
              <p className="text-xs text-gray-500">A manager will clarify this payment source.</p>
            </div>
          )}
          <button type="button" className="text-gray-400 text-sm py-2" onClick={() => { setPaymentChoice('unpaid'); setOtherPayment(''); setStep('confirm') }}>Not paid yet</button>
          {saveErr && <p className="text-red-400 text-sm">{saveErr}</p>}
        </div>
      </StepShell>
    )
  }

  // confirm / saving
  const saving = step === 'saving'
  const catText = categoryMode === 'single' ? categoryLabel(categoryKey) : categoryMode === 'mixed' ? 'More than one category' : 'Other / Not sure'
  const fundText = paymentChoice === 'other' ? `Other: ${otherPayment.trim()}` : paymentChoice === 'unpaid' ? 'Not paid yet' : RECEIPT_PAYMENT_CHOICES.find((c) => c.key === paymentChoice)?.label ?? '—'
  const missing = (v: string) => v.trim() === ''
  return (
    <StepShell title="Check the details" onBack={saving ? undefined : () => setStep('q3')} {...shell}>
      <div className="space-y-3">
        <div className="text-xs text-gray-400 flex flex-wrap gap-x-2 gap-y-1">
          <span className="text-gray-300">{entityLabel(entity)}</span><span>·</span>
          <span className="text-gray-300">{catText}</span><span>·</span>
          <span className="text-gray-300">{fundText}</span>
        </div>

        {paymentChoice === 'personal' && <p className="text-amber-300 text-sm">Personal payment — saved for manager review. This does not record a reimbursement.</p>}

        <label className="block text-xs text-gray-500">Store / vendor {missing(vendor) && <span className="text-amber-400">· needed</span>}
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} disabled={saving} placeholder="e.g. O’Reilly Auto Parts" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-gray-500">Date {missing(date) && <span className="text-amber-400">· needed</span>}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={saving} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
          </label>
          <label className="block text-xs text-gray-500">Total {missing(total) && <span className="text-amber-400">· needed</span>}
            <input value={total} onChange={(e) => setTotal(e.target.value)} disabled={saving} inputMode="decimal" placeholder="0.00" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
          </label>
        </div>

        {!showExtras ? (
          <button type="button" onClick={() => setShowExtras(true)} className="text-indigo-300 text-sm">+ Add a vehicle or note (optional)</button>
        ) : (
          <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
            <label className="block text-xs text-gray-500">Vehicle (optional — only if this was for a specific inventory vehicle)
              <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} disabled={saving} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white">
                <option value="">Not for a specific vehicle</option>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </label>
            <label className="block text-xs text-gray-500">Note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} placeholder="Anything a manager should know" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white" />
            </label>
          </div>
        )}

        {uploadState === 'duplicate' && <p className="text-amber-300 text-sm rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2">This receipt was already captured — no need to send it again.</p>}
        {uploadState === 'error' && <p className="text-red-400 text-sm">The photo didn’t upload. Go back and retake it.</p>}
        {saveErr && <p className="text-red-400 text-sm">{saveErr}</p>}

        <button type="button" onClick={save} disabled={saving || uploadState === 'duplicate' || uploadState === 'error'}
          className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl disabled:opacity-50">
          {saving ? (uploadState === 'uploading' ? 'Finishing upload…' : 'Saving…') : 'Save receipt'}
        </button>
        <p className="text-gray-600 text-xs text-center">You’re filing this yourself. If anything’s missing we’ll flag it for a manager.</p>
      </div>
    </StepShell>
  )
}
