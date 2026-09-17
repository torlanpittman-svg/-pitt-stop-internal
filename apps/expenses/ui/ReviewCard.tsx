'use client'
/**
 * Business Receipts — manager EXCEPTION card. Most receipts are now filed by employees and never appear
 * here; this card is for the "Needs attention" queue (missing info, mixed categories, personal money,
 * unpaid, possible duplicate, unreadable) plus inspecting/correcting already-filed or legacy-approved ones.
 *
 * A manager corrects the fields and taps "File receipt" (fileReceiptAction — the SAME operational-filing
 * path the employee uses, so resolving an exception produces a 'filed' receipt attributed to the manager,
 * never a misleading "approved"). Reject / Reopen / Retry-read remain. Real identity + the append-only
 * audit trail are handled server-side; this is presentation only.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  BUSINESS_ENTITIES, EXPENSE_CATEGORIES, PAYMENT_METHODS, FUNDING_SOURCES,
  attentionReasonLabel, centsToDollars, formatMoney,
} from '@/apps/expenses/types'
import { fileReceiptAction, rejectReceiptAction, reopenReceiptAction, retryExtractionAction } from '@/apps/expenses/actions'
import type { ReviewCardData } from '@/apps/expenses/view'

export type { ReviewCardData }
export interface VehicleOption { id: string; label: string }
const box = 'bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-base text-white w-full'
const lbl = 'text-xs text-gray-500'

export default function ReviewCard({ r, vehicles = [] }: { r: ReviewCardData; vehicles?: VehicleOption[] }) {
  const router = useRouter()
  const [entity, setEntity] = useState(r.entity)
  const [category, setCategory] = useState(r.category)
  const [funding, setFunding] = useState(r.funding || 'unknown')
  const [vendor, setVendor] = useState(r.vendor ?? '')
  const [receiptDate, setReceiptDate] = useState(r.receiptDate ?? '')
  const [subtotal, setSubtotal] = useState(centsToDollars(r.subtotalCents))
  const [tax, setTax] = useState(centsToDollars(r.taxCents))
  const [total, setTotal] = useState(centsToDollars(r.totalCents))
  const [paymentMethod, setPaymentMethod] = useState(r.paymentMethod ?? '')
  const [inventoryVehicleId, setInventoryVehicleId] = useState(r.inventoryVehicleId ?? '')
  const [memo, setMemo] = useState(r.memo ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const suggested = (k: string) => r.present?.[k] ? <span className="text-indigo-400/70"> · suggested</span> : null

  async function run(fn: () => Promise<{ ok: boolean; error?: string; alreadyFiled?: boolean; status?: string }>, okNote: string) {
    if (busy) return
    setBusy(true); setErr(null); setNote(null)
    try {
      const res = await fn()
      if (!res.ok) setErr(res.error ?? 'Something went wrong.')
      else { setNote(res.alreadyFiled ? 'Already filed.' : okNote); router.refresh() }
    } catch { setErr('Could not reach the server.') }
    setBusy(false)
  }

  // Manager files via the SAME operational path as the employee (categoryMode 'single' with the chosen key).
  const fileNow = () => run(() => fileReceiptAction({
    id: r.id, entity, category, categoryMode: 'single', funding, paymentMethod: paymentMethod || undefined,
    vendor, receiptDate, subtotal, tax, total, memo, inventoryVehicleId,
  }), 'Filed.')

  const decided = r.status === 'filed' || r.status === 'approved' || r.status === 'rejected'

  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
      <div className="grid md:grid-cols-2">
        {/* Original evidence */}
        <div className="bg-black/40 p-3 flex flex-col">
          {r.imageUrl
            ? <a href={r.imageUrl} target="_blank" rel="noreferrer"><img src={r.imageUrl} alt="receipt" className="w-full rounded-xl max-h-[28rem] object-contain" /></a>
            : <div className="flex-1 grid place-items-center text-gray-600 text-sm min-h-40">No stored image</div>}
          <div className="mt-2 text-xs text-gray-500">
            Uploaded by {r.uploadedBy ?? 'shop'} · {r.createdAt.slice(0, 10)}
            {r.aiStatus !== 'extracted' && <span className="text-amber-400"> · AI could not read it</span>}
          </div>
        </div>

        {/* Editable fields */}
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <StatusChip status={r.status} />
            {r.aiStatus !== 'extracted' && !decided && (
              <button type="button" onClick={() => run(() => retryExtractionAction({ id: r.id }), 'Re-read the receipt.')} disabled={busy} className="text-indigo-300 text-xs underline disabled:opacity-50">Retry read</button>
            )}
          </div>

          {/* Why it needs attention */}
          {r.status === 'needs_review' && r.attentionReasons.length > 0 && (
            <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 px-3 py-2">
              <p className="text-amber-300 text-xs font-semibold">Needs attention</p>
              <ul className="text-amber-200/80 text-xs mt-1 list-disc list-inside">
                {r.attentionReasons.map((k) => <li key={k}>{attentionReasonLabel(k)}</li>)}
              </ul>
            </div>
          )}
          {r.filingNote && <p className="text-gray-400 text-xs">Note from filer: “{r.filingNote}”</p>}

          <div className="grid grid-cols-2 gap-3">
            <label className={lbl}>Business{entity === 'unassigned' && <span className="text-amber-400"> · required</span>}<br />
              <select value={entity} onChange={(e) => setEntity(e.target.value)} disabled={decided} className={box}>
                {BUSINESS_ENTITIES.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select></label>
            <label className={lbl}>Category{category === 'uncategorized' && <span className="text-amber-400"> · flagged</span>}{suggested('category')}<br />
              <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={decided} className={box}>
                {EXPENSE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select></label>
          </div>

          <label className={lbl}>Vendor{suggested('vendor')}<br /><input value={vendor} onChange={(e) => setVendor(e.target.value)} disabled={decided} placeholder="e.g. O’Reilly Auto Parts" className={box} /></label>

          <div className="grid grid-cols-2 gap-3">
            <label className={lbl}>Date{suggested('date')}<br /><input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} disabled={decided} className={box} /></label>
            <label className={lbl}>Total{suggested('total')}<br /><input value={total} onChange={(e) => setTotal(e.target.value)} disabled={decided} inputMode="decimal" placeholder="0.00" className={box} /></label>
            <label className={lbl}>Subtotal{suggested('subtotal')}<br /><input value={subtotal} onChange={(e) => setSubtotal(e.target.value)} disabled={decided} inputMode="decimal" placeholder="" className={box} /></label>
            <label className={lbl}>Tax{suggested('tax')}<br /><input value={tax} onChange={(e) => setTax(e.target.value)} disabled={decided} inputMode="decimal" placeholder="" className={box} /></label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className={lbl}>Funding<br />
              <select value={funding} onChange={(e) => setFunding(e.target.value)} disabled={decided} className={box}>
                {FUNDING_SOURCES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select></label>
            <label className={lbl}>Method{suggested('paymentMethod')}<br />
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} disabled={decided} className={box}>
                <option value="">—</option>{PAYMENT_METHODS.filter((m) => m !== 'unknown').map((m) => <option key={m} value={m}>{m}</option>)}
              </select></label>
          </div>

          <details className="rounded-xl border border-gray-800 bg-gray-900/60">
            <summary className="px-3 py-2 text-gray-400 text-sm cursor-pointer list-none">Vehicle &amp; note ▾</summary>
            <div className="px-3 pb-3 grid grid-cols-1 gap-3">
              <label className={lbl}>Vehicle (optional — for an inventory-vehicle expense)<br />
                <select value={inventoryVehicleId} onChange={(e) => setInventoryVehicleId(e.target.value)} disabled={decided} className={box}>
                  <option value="">Not a vehicle expense</option>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                  {inventoryVehicleId && !vehicles.some((v) => v.id === inventoryVehicleId) && <option value={inventoryVehicleId}>Current (unavailable)</option>}
                </select></label>
              <label className={lbl}>Manager note<br /><input value={memo} onChange={(e) => setMemo(e.target.value)} disabled={decided} className={box} /></label>
            </div>
          </details>

          {r.status === 'rejected' && r.rejectedReason && <p className="text-gray-400 text-xs">Rejected: {r.rejectedReason}</p>}
          {r.status === 'filed' && <p className="text-emerald-400/80 text-xs">Filed by {r.filedBy ?? 'shop'} · operational filing (not yet in QuickBooks)</p>}
          {r.status === 'approved' && <p className="text-emerald-400/80 text-xs">Approved by {r.approvedBy ?? 'manager'} · legacy record (not yet in QuickBooks)</p>}
          {err && <p className="text-red-400 text-sm">{err}</p>}
          {note && <p className="text-emerald-400 text-sm">{note}</p>}

          {!decided ? (
            <div className="space-y-2">
              <button type="button" onClick={fileNow} disabled={busy} className="w-full bg-green-600 active:bg-green-700 text-white font-bold py-3 rounded-xl disabled:opacity-50">File receipt</button>
              <button type="button" onClick={() => { const reason = window.prompt('Reason for rejecting this receipt?') ?? undefined; if (reason !== undefined) run(() => rejectReceiptAction({ id: r.id, reason }), 'Rejected.') }} disabled={busy} className="w-full text-gray-500 text-sm py-2 disabled:opacity-50">Reject</button>
            </div>
          ) : (
            <button type="button" onClick={() => run(() => reopenReceiptAction({ id: r.id }), 'Reopened for review.')} disabled={busy} className="w-full border border-gray-700 text-gray-300 font-semibold py-3 rounded-xl disabled:opacity-50">Reopen</button>
          )}
          {!decided && total && <p className="text-gray-600 text-xs text-right">Filing records {formatMoney(Math.round(parseFloat(total || '0') * 100))} to receipt coverage (internal, not QuickBooks).</p>}
        </div>
      </div>
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    needs_review: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
    filed: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
    approved: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
    rejected: 'bg-gray-800 text-gray-400 border-gray-700',
    processing_failed: 'bg-red-950/40 text-red-300 border-red-900/60',
  }
  const text = status === 'needs_review' ? 'needs attention' : status.replace('_', ' ')
  return <span className={`text-xs px-2 py-1 rounded-full border ${map[status] ?? 'bg-gray-800 text-gray-300 border-gray-700'}`}>{text}</span>
}
