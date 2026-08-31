'use client'
/**
 * Auto-Sales B2 — mobile receipt capture. Add Receipt → Take Photo / Upload → preview → Use Photo →
 * AI reads it → simple verification screen → Save. Employee never transcribes unless AI fails; a
 * failed/blurry extraction still preserves the image and drops into manual entry. "Amount for this
 * vehicle" allows a partial split while the full receipt total is preserved. No confidence %, no
 * accounting/cash-flow/DB jargon on this screen (§4).
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RECEIPT_CATEGORIES } from '@/apps/auto-sales/types'
import { saveReceiptAction, type SaveReceiptForm } from '@/apps/auto-sales/actions'

type Returnable = { id: string; label: string }
type Step = 'idle' | 'preview' | 'scanning' | 'verify'
const box = 'bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full'
const today = () => new Date().toISOString().slice(0, 10)

export default function ReceiptCapture({ vehicleId, returnable }: { vehicleId: string; returnable: Returnable[] }) {
  const router = useRouter()
  const camRef = useRef<HTMLInputElement>(null)
  const upRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // verify fields
  const [documentId, setDocumentId] = useState('')
  const [aiFailed, setAiFailed] = useState(false)
  const [dup, setDup] = useState<{ sameVehicle: boolean; when: string } | null>(null)
  const [vendor, setVendor] = useState(''); const [date, setDate] = useState(today())
  const [category, setCategory] = useState('Parts'); const [total, setTotal] = useState(''); const [amount, setAmount] = useState('')
  const [isReturn, setIsReturn] = useState(false); const [originalEventId, setOriginalEventId] = useState(returnable[0]?.id ?? '')

  function pick(f: File | null) {
    if (!f) return
    setFile(f); setErr(null)
    setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(f) })
    setStep('preview')
  }
  function reset() {
    setStep('idle'); setFile(null); setDocumentId(''); setAiFailed(false); setDup(null); setErr(null)
    setVendor(''); setDate(today()); setCategory('Parts'); setTotal(''); setAmount(''); setIsReturn(false)
    if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null)
  }

  async function usePhoto() {
    if (!file) return
    setStep('scanning'); setBusy(true); setErr(null)
    try {
      const fd = new FormData(); fd.set('receipt', file); fd.set('inventoryVehicleId', vehicleId)
      const res = await fetch('/api/auto-sales/receipt/scan', { method: 'POST', body: fd })
      const j = await res.json()
      if (!res.ok || !j.ok) { setErr(j.error || 'Could not process — enter it manually.'); setStep('preview'); setBusy(false); return }
      setDocumentId(j.documentId)
      setDup(j.duplicateWarning ? { sameVehicle: j.duplicateWarning.sameVehicle, when: String(j.duplicateWarning.when).slice(0, 10) } : null)
      const p = j.proposal ?? {}
      const failed = j.aiStatus !== 'extracted'
      setAiFailed(failed)
      setVendor(p.vendor ?? '')
      setDate(p.date ?? today())
      setCategory(p.categoryLabel ?? 'Parts')
      const t = p.totalCents != null ? (p.totalCents / 100).toFixed(2) : ''
      setTotal(t); setAmount(t)                        // amount for this vehicle defaults to the total
      setIsReturn(Boolean(p.isReturn))
      setStep('verify')
    } catch { setErr('No connection — you can enter this expense manually below.'); setStep('preview') }
    setBusy(false)
  }

  async function save() {
    setBusy(true); setErr(null)
    const form: SaveReceiptForm = {
      documentId, vehicleId, categoryLabel: category, amountDollars: amount || total, totalDollars: total || amount,
      eventDate: date, vendor: vendor || undefined, isReturn, originalEventId: isReturn ? originalEventId : undefined,
    }
    const r = await saveReceiptAction(form)
    setBusy(false)
    if (r.ok) { reset(); router.refresh() } else setErr(r.error ?? 'Could not save.')
  }

  return (
    <details className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden" open={step !== 'idle'}>
      <summary className="px-4 py-4 cursor-pointer list-none text-white font-bold text-lg flex items-center justify-between">📷 Add Receipt <span className="text-gray-500 text-sm">▾</span></summary>
      <div className="px-4 pb-4">
        <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <input ref={upRef} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />

        {step === 'idle' && (
          <div className="space-y-3">
            <button type="button" onClick={() => camRef.current?.click()} className="w-full bg-indigo-600 active:bg-indigo-700 text-white text-lg font-bold py-5 rounded-2xl">📷 Take Photo</button>
            <button type="button" onClick={() => upRef.current?.click()} className="w-full border border-gray-700 text-gray-200 text-base font-semibold py-3 rounded-2xl">Upload Photo</button>
          </div>
        )}

        {step === 'preview' && (
          <div className="space-y-3">
            {previewUrl && <img src={previewUrl} alt="receipt" className="w-full rounded-xl max-h-80 object-contain bg-black/40" />}
            {err && <p className="text-amber-400 text-sm">{err}</p>}
            <button type="button" onClick={usePhoto} disabled={busy} className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl disabled:opacity-50">Use Photo</button>
            <button type="button" onClick={reset} className="w-full text-gray-400 py-2">Retake / cancel</button>
          </div>
        )}

        {step === 'scanning' && <div className="py-8 text-center text-gray-400">Reading receipt…</div>}

        {step === 'verify' && (
          <div className="space-y-3">
            {previewUrl && <img src={previewUrl} alt="receipt" className="w-full rounded-xl max-h-52 object-contain bg-black/40" />}
            {aiFailed && <p className="text-amber-400 text-sm">Couldn’t read this one — enter the details.</p>}
            {dup && <p className="text-amber-300 text-sm rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2">⚠ Looks like a receipt you already added{dup.sameVehicle ? '' : ' (on another vehicle)'} on {dup.when}. Save again only if it’s different.</p>}

            <label className="text-xs text-gray-500">Vendor<br /><input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. O’Reilly Auto Parts" className={box} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500">Date<br /><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={box} /></label>
              <label className="text-xs text-gray-500">Category<br /><select value={category} onChange={(e) => setCategory(e.target.value)} className={box}>{RECEIPT_CATEGORIES.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}</select></label>
              <label className="text-xs text-gray-500">Receipt total<br /><input value={total} onChange={(e) => { setTotal(e.target.value); if (amount === '' ) setAmount(e.target.value) }} inputMode="decimal" placeholder="0.00" className={box} /></label>
              <label className="text-xs text-gray-500">For this vehicle<br /><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className={box} /></label>
            </div>
            {total && amount && parseFloat(amount) < parseFloat(total) && <p className="text-gray-500 text-xs">Assigning {money(amount)} of the {money(total)} receipt to this vehicle. The rest isn’t assigned here.</p>}

            {returnable.length > 0 && (
              <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3 space-y-2">
                <label className="text-sm text-gray-300 flex items-center gap-2"><input type="checkbox" checked={isReturn} onChange={(e) => setIsReturn(e.target.checked)} className="w-5 h-5" /> This is a return / refund</label>
                {isReturn && <label className="text-xs text-gray-500">Against which purchase?<br /><select value={originalEventId} onChange={(e) => setOriginalEventId(e.target.value)} className={box}>{returnable.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>}
              </div>
            )}

            {err && <p className="text-red-400 text-sm">{err}</p>}
            <button type="button" onClick={save} disabled={busy || !(amount || total)} className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl disabled:opacity-50">{busy ? 'Saving…' : 'Save Receipt'}</button>
            <button type="button" onClick={reset} className="w-full text-gray-400 py-2">Cancel</button>
          </div>
        )}
      </div>
    </details>
  )
}

function money(v: string) { const n = parseFloat(v); return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : v }
