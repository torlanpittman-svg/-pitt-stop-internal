'use client'
/**
 * Auto-Sales — ONE unified "Add Expense" (replaces the two competing buttons). Tap "+ Add Expense" →
 * Take Receipt Photo · Upload Receipt · Enter Manually. Camera is the preferred path: photo → AI reads
 * it → verify → Save. Manual entry is the fallback (no receipt / unreadable / type it).
 *
 * SMART RETURNS: when the AI reads the receipt as a return/refund/credit, the scan API also proposes
 * links to this vehicle's prior purchases. The verify screen shows a STRONG match to confirm, asks when
 * AMBIGUOUS, or saves as an unmatched (flagged) return when there's no reliable match — never inventing a
 * link. Cash vs non-cash is preserved via the refund kind. No accounting/DB jargon on this screen.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RECEIPT_CATEGORIES, REFUND_KINDS, IN_SCOPE_ACCOUNTS, labelFor, refundKindForDocType, type EconomicCategory } from '@/apps/auto-sales/types'
import { saveReceiptAction, addExpenseAction, type SaveReceiptForm } from '@/apps/auto-sales/actions'

type Returnable = { id: string; label: string }
type Candidate = { eventId: string; label: string; matchedLineLabel: string | null; reasons: string[]; suggestedReturnCents: number | null; returnedLineRef: string | null }
type ReturnMatch = { classification: 'strong' | 'ambiguous' | 'none'; candidates: Candidate[]; returnedAmountCents: number | null; returnedLabel: string | null }
type Mode = 'idle' | 'preview' | 'scanning' | 'verify' | 'manual'
const box = 'bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full'
const today = () => new Date().toISOString().slice(0, 10)
const EXPENSE_CATS: EconomicCategory[] = ['part', 'recon_labor', 'mechanic', 'bodywork', 'pdr', 'paint', 'transport', 'title_tax', 'registration', 'auction_fee', 'buyer_fee', 'other']

export default function AddExpense({ vehicleId, returnable }: { vehicleId: string; returnable: Returnable[] }) {
  const router = useRouter()
  const camRef = useRef<HTMLInputElement>(null)
  const upRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<Mode>('idle')
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
  // return fields
  const [isReturn, setIsReturn] = useState(false)
  const [refundKind, setRefundKind] = useState('card_refund')
  const [originalEventId, setOriginalEventId] = useState('')   // '' = unmatched
  const [returnMatch, setReturnMatch] = useState<ReturnMatch | null>(null)
  const [returnedLineRef, setReturnedLineRef] = useState<string | null>(null)
  const [matchReasons, setMatchReasons] = useState<string[]>([])
  const [referencedReceipt, setReferencedReceipt] = useState<string | null>(null)

  function pick(f: File | null) {
    if (!f) return
    setFile(f); setErr(null)
    setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(f) })
    setMode('preview')
  }
  function reset() {
    setMode('idle'); setFile(null); setDocumentId(''); setAiFailed(false); setDup(null); setErr(null)
    setVendor(''); setDate(today()); setCategory('Parts'); setTotal(''); setAmount('')
    setIsReturn(false); setRefundKind('card_refund'); setOriginalEventId(''); setReturnMatch(null); setReturnedLineRef(null); setMatchReasons([]); setReferencedReceipt(null)
    if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null)
  }

  async function usePhoto() {
    if (!file) return
    setMode('scanning'); setBusy(true); setErr(null)
    try {
      const fd = new FormData(); fd.set('receipt', file); fd.set('inventoryVehicleId', vehicleId)
      const res = await fetch('/api/auto-sales/receipt/scan', { method: 'POST', body: fd })
      const j = await res.json()
      if (!res.ok || !j.ok) { setErr(j.error || 'Could not process — enter it manually.'); setMode('preview'); setBusy(false); return }
      setDocumentId(j.documentId)
      setDup(j.duplicateWarning ? { sameVehicle: j.duplicateWarning.sameVehicle, when: String(j.duplicateWarning.when).slice(0, 10) } : null)
      const p = j.proposal ?? {}
      setAiFailed(j.aiStatus !== 'extracted')
      setVendor(p.vendor ?? '')
      setDate(p.date ?? today())
      setCategory(p.categoryLabel ?? 'Parts')
      const t = p.totalCents != null ? (p.totalCents / 100).toFixed(2) : ''
      setTotal(t)
      const ret = Boolean(p.isReturn)
      setIsReturn(ret)
      setReferencedReceipt(p.originalReference ?? null)
      setRefundKind(refundKindForDocType(p.documentType))
      const rm: ReturnMatch | null = j.returnMatch ?? null
      setReturnMatch(rm)
      if (ret && rm && rm.classification === 'strong' && rm.candidates[0]) {
        applyCandidate(rm.candidates[0], t)
      } else if (ret && rm && rm.returnedAmountCents != null) {
        setAmount((rm.returnedAmountCents / 100).toFixed(2)); setOriginalEventId('')
      } else {
        setAmount(t)
      }
      setMode('verify')
    } catch { setErr('No connection — you can enter this expense manually.'); setMode('preview') }
    setBusy(false)
  }

  function applyCandidate(c: Candidate, fallbackTotal: string) {
    setOriginalEventId(c.eventId)
    setReturnedLineRef(c.returnedLineRef)
    setMatchReasons(c.reasons ?? [])
    setAmount(c.suggestedReturnCents != null ? (c.suggestedReturnCents / 100).toFixed(2) : fallbackTotal)
  }

  async function save() {
    setBusy(true); setErr(null)
    const form: SaveReceiptForm = {
      documentId, vehicleId, categoryLabel: category, amountDollars: amount || total, totalDollars: total || amount,
      eventDate: date, vendor: vendor || undefined,
      isReturn, refundKind: isReturn ? refundKind : undefined,
      originalEventId: isReturn && originalEventId ? originalEventId : undefined,
      unmatched: isReturn && !originalEventId,
      matchConfidence: isReturn ? (returnMatch?.classification ?? 'manual') : undefined,
      matchReasons: isReturn ? matchReasons : undefined,
      returnedLineRef: isReturn && originalEventId ? (returnedLineRef ?? undefined) : undefined,
      referencedReceipt: isReturn ? (referencedReceipt ?? undefined) : undefined,
    }
    const r = await saveReceiptAction(form)
    setBusy(false)
    if (r.ok) { reset(); router.refresh() } else setErr(r.error ?? 'Could not save.')
  }

  const saveLabel = !isReturn ? 'Save Receipt' : originalEventId ? 'Confirm Return' : 'Save as Unmatched Return'

  return (
    <details className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden" open={mode !== 'idle'}>
      <summary className="px-4 py-4 cursor-pointer list-none text-white font-bold text-lg flex items-center justify-between">+ Add Expense <span className="text-gray-500 text-sm">▾</span></summary>
      <div className="px-4 pb-4">
        <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <input ref={upRef} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />

        {mode === 'idle' && (
          <div className="space-y-3">
            <button type="button" onClick={() => camRef.current?.click()} className="w-full bg-indigo-600 active:bg-indigo-700 text-white text-lg font-bold py-5 rounded-2xl">📷 Take Receipt Photo</button>
            <button type="button" onClick={() => upRef.current?.click()} className="w-full border border-gray-700 text-gray-200 text-base font-semibold py-3 rounded-2xl">Upload Receipt</button>
            <button type="button" onClick={() => { reset(); setMode('manual') }} className="w-full text-gray-400 text-base py-3">Enter Manually</button>
          </div>
        )}

        {mode === 'preview' && (
          <div className="space-y-3">
            {previewUrl && <img src={previewUrl} alt="receipt" className="w-full rounded-xl max-h-80 object-contain bg-black/40" />}
            {err && <p className="text-amber-400 text-sm">{err}</p>}
            <button type="button" onClick={usePhoto} disabled={busy} className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl disabled:opacity-50">Use Photo</button>
            <button type="button" onClick={reset} className="w-full text-gray-400 py-2">Retake / cancel</button>
          </div>
        )}

        {mode === 'scanning' && <div className="py-8 text-center text-gray-400">Reading receipt…</div>}

        {mode === 'manual' && (
          <form action={addExpenseAction} className="space-y-3">
            <input type="hidden" name="inventoryVehicleId" value={vehicleId} />
            <label className="text-xs text-gray-500">What was it?<br /><select name="category" className={box} defaultValue="part">{EXPENSE_CATS.map((c) => <option key={c} value={c}>{labelFor(c)}</option>)}</select></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500">Amount<br /><input name="amount" type="number" step="0.01" min="0" inputMode="decimal" required className={box} /></label>
              <label className="text-xs text-gray-500">Date<br /><input name="eventDate" type="date" defaultValue={today()} required className={box} /></label>
            </div>
            <label className="text-xs text-gray-500">Vendor<br /><input name="vendor" placeholder="e.g. O’Reilly" className={box} /></label>
            <details className="rounded-xl border border-gray-800 bg-gray-900/60"><summary className="px-3 py-2 text-gray-400 text-sm cursor-pointer list-none">More (paid from, note) ▾</summary>
              <div className="px-3 pb-3 space-y-2">
                <label className="text-xs text-gray-500">Paid from<br /><select name="account" className={box} defaultValue="unknown">{IN_SCOPE_ACCOUNTS.map((a) => <option key={a.ref} value={a.ref}>{a.ref}</option>)}</select></label>
                <label className="text-xs text-gray-500">Note<br /><input name="memo" className={box} /></label>
              </div>
            </details>
            <button className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl">Add Expense</button>
            <button type="button" onClick={reset} className="w-full text-gray-400 py-2">Cancel</button>
          </form>
        )}

        {mode === 'verify' && (
          <div className="space-y-3">
            {previewUrl && <img src={previewUrl} alt="receipt" className="w-full rounded-xl max-h-52 object-contain bg-black/40" />}
            {aiFailed && <p className="text-amber-400 text-sm">Couldn’t read this one — enter the details.</p>}
            {dup && <p className="text-amber-300 text-sm rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2">⚠ Looks like a receipt you already added{dup.sameVehicle ? '' : ' (on another vehicle)'} on {dup.when}. Save again only if it’s different.</p>}

            {/* Smart return banner */}
            {isReturn && returnMatch?.classification === 'strong' && originalEventId && (
              <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/15 p-3">
                <p className="text-emerald-300 text-sm font-semibold">Looks like a return</p>
                {returnMatch.returnedLabel && <p className="text-gray-200 text-sm mt-1">Returned: {returnMatch.returnedLabel}</p>}
                <p className="text-gray-400 text-sm">Original purchase: {returnMatch.candidates.find((c) => c.eventId === originalEventId)?.label}</p>
                {matchReasons[0] && <p className="text-gray-500 text-xs mt-1">{matchReasons[0]}</p>}
              </div>
            )}
            {isReturn && returnMatch?.classification === 'ambiguous' && (
              <div className="rounded-xl border border-amber-900/50 bg-amber-950/15 p-3 space-y-2">
                <p className="text-amber-300 text-sm font-semibold">Which purchase was this returned from?</p>
                {returnMatch.candidates.map((c) => (
                  <label key={c.eventId} className="flex items-start gap-2 text-sm text-gray-200">
                    <input type="radio" name="candidate" className="mt-1 w-4 h-4" checked={originalEventId === c.eventId} onChange={() => applyCandidate(c, total)} />
                    <span>{c.label}{c.matchedLineLabel ? <span className="block text-gray-500 text-xs">{c.matchedLineLabel}</span> : null}</span>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm text-gray-400"><input type="radio" name="candidate" className="w-4 h-4" checked={!originalEventId} onChange={() => { setOriginalEventId(''); setReturnedLineRef(null) }} /> None of these — save as unmatched</label>
              </div>
            )}
            {isReturn && (!returnMatch || returnMatch.classification === 'none') && (
              <p className="text-amber-300 text-sm rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2">This looks like a return. No matching purchase found — it’ll be saved as an <b>unmatched return</b> for review.</p>
            )}

            <label className="text-xs text-gray-500">Vendor<br /><input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. O’Reilly Auto Parts" className={box} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500">Date<br /><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={box} /></label>
              {!isReturn
                ? <label className="text-xs text-gray-500">Category<br /><select value={category} onChange={(e) => setCategory(e.target.value)} className={box}>{RECEIPT_CATEGORIES.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}</select></label>
                : <label className="text-xs text-gray-500">Refund type<br /><select value={refundKind} onChange={(e) => setRefundKind(e.target.value)} className={box}>{REFUND_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></label>}
              <label className="text-xs text-gray-500">{isReturn ? 'Return total' : 'Receipt total'}<br /><input value={total} onChange={(e) => { setTotal(e.target.value); if (!amount) setAmount(e.target.value) }} inputMode="decimal" placeholder="0.00" className={box} /></label>
              <label className="text-xs text-gray-500">{isReturn ? 'Returned for this vehicle' : 'For this vehicle'}<br /><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className={box} /></label>
            </div>
            {total && amount && parseFloat(amount) < parseFloat(total) && <p className="text-gray-500 text-xs">Assigning {money(amount)} of the {money(total)} {isReturn ? 'return' : 'receipt'} to this vehicle. The rest isn’t assigned here.</p>}

            {/* Manual return toggle (fallback when the AI didn't detect it and there's something to return) */}
            {!returnMatch && returnable.length > 0 && (
              <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3 space-y-2">
                <label className="text-sm text-gray-300 flex items-center gap-2"><input type="checkbox" checked={isReturn} onChange={(e) => { setIsReturn(e.target.checked); if (e.target.checked && !originalEventId) setOriginalEventId(returnable[0].id) }} className="w-5 h-5" /> This is a return / refund</label>
                {isReturn && <label className="text-xs text-gray-500">Against which purchase?<br /><select value={originalEventId} onChange={(e) => setOriginalEventId(e.target.value)} className={box}><option value="">Unmatched (needs review)</option>{returnable.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>}
              </div>
            )}

            {err && <p className="text-red-400 text-sm">{err}</p>}
            <button type="button" onClick={save} disabled={busy || !(amount || total)} className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl disabled:opacity-50">{busy ? 'Saving…' : saveLabel}</button>
            <button type="button" onClick={reset} className="w-full text-gray-400 py-2">Cancel</button>
          </div>
        )}
      </div>
    </details>
  )
}

function money(v: string | number) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : String(v) }
