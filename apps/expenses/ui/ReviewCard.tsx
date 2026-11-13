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
  attentionReasonLabel, canAcknowledgeOutstanding, displayAttentionReasons, outstandingKindLabel,
  centsToDollars, formatMoney,
} from '@/apps/expenses/types'
import { fileReceiptAction, rejectReceiptAction, reopenReceiptAction, retryExtractionAction, checkReadingAction, type ReadingCheck } from '@/apps/expenses/actions'
import { linkReceiptAction, removeAllocationAction } from '@/apps/expenses/job-actions'
import { amountsWarning, receiptDateWarning, todayBusinessDate } from '@/apps/expenses/checks'
import { summarizeAllocations } from '@/apps/expenses/allocations'
import type { ReceiptAllocationView } from '@/apps/expenses/job-expenses'
import JobPicker, { type PickedJob } from './JobPicker'
import type { ReviewCardData } from '@/apps/expenses/view'
import {
  OTHER_PAYMENT_MAX_LENGTH, OTHER_PAYMENT_FUNDINGS, OTHER_PAYMENT_METHODS, RECEIPT_PAYMENT_CHOICES,
  otherPaymentDescription, otherPaymentFunding, receiptPaymentChoice, receiptPaymentLabel,
} from '@/apps/expenses/payment'

export type { ReviewCardData }
export interface VehicleOption { id: string; label: string }
const box = 'bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-base text-white w-full'
const lbl = 'text-xs text-gray-500'

export default function ReviewCard({ r, vehicles = [], allocations = [] }: { r: ReviewCardData; vehicles?: VehicleOption[]; allocations?: ReceiptAllocationView[] }) {
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
  const [paymentChoice, setPaymentChoice] = useState(receiptPaymentChoice(r))
  const [otherPayment, setOtherPayment] = useState(otherPaymentDescription(r) ?? '')
  // A stored Other source reopens with its existing classification (from the row's funding/method, not its text).
  const storedOther = otherPaymentDescription(r) !== null
  const [otherFunding, setOtherFunding] = useState(storedOther ? otherPaymentFunding(r) : '')
  const [otherPaymentMethod, setOtherPaymentMethod] = useState(storedOther && r.funding === 'business' ? (r.paymentMethod ?? '') : '')
  const [inventoryVehicleId, setInventoryVehicleId] = useState(r.inventoryVehicleId ?? '')
  const [memo, setMemo] = useState(r.memo ?? '')
  const [shipping, setShipping] = useState(centsToDollars(r.shippingCents))
  const [invoiceNumber, setInvoiceNumber] = useState(r.invoiceNumber ?? '')
  const [orderNumber, setOrderNumber] = useState(r.orderNumber ?? '')
  const [description, setDescription] = useState(r.description ?? '')
  // Assign this purchase (or part of it) to a customer job / overhead — a link, never a second expense.
  const [pickJob, setPickJob] = useState<PickedJob | null>(null)
  const [assignAmount, setAssignAmount] = useState('')
  const [reading, setReading] = useState<ReadingCheck | null>(null)
  const [readingBusy, setReadingBusy] = useState(false)
  async function checkReading() {
    if (readingBusy) return
    setReadingBusy(true); setReading(null)
    try { setReading(await checkReadingAction({ id: r.id })) } catch { setReading({ ok: false, error: 'Could not reach the server.' }) }
    setReadingBusy(false)
  }
  const showVal = (k: string, v: string | number | null | undefined) => (v == null ? '—' : k.endsWith('Cents') ? formatMoney(v as number) : String(v))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const suggested = (k: string) => r.present?.[k] ? <span className="text-indigo-400/70"> · suggested</span> : null

  async function run(fn: () => Promise<{ ok: boolean; error?: string; alreadyFiled?: boolean; status?: string; clarified?: boolean; reasons?: string[] }>, okNote: string) {
    if (busy) return
    setBusy(true); setErr(null); setNote(null)
    try {
      const res = await fn()
      if (!res.ok) setErr(res.error ?? 'Something went wrong.')
      else {
        // Distinguish clean filing, acknowledged-outstanding, and still-in-backlog outcomes honestly.
        const msg = res.alreadyFiled ? 'Already filed.'
          : res.status === 'filed' ? 'Filed.'
          : res.clarified ? 'Reviewed — moved to Outstanding (payment/allocation still open).'
          : res.status === 'needs_review' ? `Saved — still needs: ${(res.reasons ?? []).map(attentionReasonLabel).join(', ') || 'attention'}.`
          : okNote
        setNote(msg); router.refresh()
      }
    } catch { setErr('Could not reach the server.') }
    setBusy(false)
  }

  const formFields = () => ({
    id: r.id, entity, category, categoryMode: 'single', funding, paymentMethod: paymentMethod || undefined,
    paymentChoice: paymentChoice || undefined, otherPayment,
    otherFunding: otherFunding || undefined, otherPaymentMethod: otherPaymentMethod || undefined,
    vendor, receiptDate, subtotal, tax, total, memo, inventoryVehicleId,
    shipping, invoiceNumber, orderNumber, description,
    // The manager is looking at the date (any warning is shown right under it) — their filing confirms it.
    dateConfirmed: true,
  })
  const cents = (v: string) => (v.trim() === '' ? null : Math.round(parseFloat(v.replace(/[^0-9.]/g, '') || '0') * 100))
  const dateWarn = receiptDateWarning(receiptDate, todayBusinessDate())
  const sumWarn = amountsWarning({ subtotalCents: cents(subtotal), taxCents: cents(tax), shippingCents: cents(shipping), totalCents: cents(total) })
  const purchase = summarizeAllocations(r.totalCents, allocations)
  const assign = (target: 'job' | 'overhead') => run(async () => {
    const res = await linkReceiptAction({ receiptId: r.id, target, serviceOrderId: pickJob?.id, amount: assignAmount })
    if (res.ok) { setPickJob(null); setAssignAmount('') }
    return res
  }, target === 'job' ? 'Attached to the job.' : 'Marked as overhead.')
  // Manager files via the SAME operational path as the employee (categoryMode 'single' with the chosen key).
  const fileNow = () => run(() => fileReceiptAction(formFields()), 'Filed.')
  // Manager ACKNOWLEDGES a still-outstanding exception (reimbursement/unpaid/allocation): reviewed, leaves
  // the backlog — funding/category are NOT falsified. Server honors this only when every reason is outstanding.
  const acknowledgeNow = () => run(() => fileReceiptAction({ ...formFields(), acknowledge: true }), 'Reviewed.')

  const decided = r.status === 'filed' || r.status === 'approved' || r.status === 'rejected'
  // What to SHOW: a receipt flagged before the payment reasons existed stored the generic 'missing_info'.
  // Re-derive what it actually means from this row's facts so the queue never claims a missing vendor/date/
  // total on a complete receipt. The stored history is untouched; the server recomputes on the next filing.
  const shownReasons = displayAttentionReasons(r.attentionReasons, r)
  // Offer "Mark reviewed" when the remaining reasons are all real-world outstanding items (never for a
  // receipt that just needs a field supplied — that must be fixed, not acknowledged). The server re-checks.
  const acknowledgeable = r.status === 'needs_review' && canAcknowledgeOutstanding(shownReasons)

  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
      <div className="grid md:grid-cols-2">
        {/* Original evidence */}
        <div className="bg-black/40 p-3 flex flex-col">
          {!r.imageUrl
            ? <div className="flex-1 grid place-items-center text-gray-600 text-sm min-h-40">No stored receipt</div>
            : r.contentType === 'application/pdf' || r.contentType === 'text/plain'
              ? <a href={r.imageUrl} target="_blank" rel="noreferrer" className="flex-1 grid place-items-center min-h-40 rounded-xl border border-gray-800 text-indigo-300 text-sm underline">{r.contentType === 'application/pdf' ? 'Open the PDF invoice' : 'Open the pasted receipt text'}</a>
              : <a href={r.imageUrl} target="_blank" rel="noreferrer"><img src={r.imageUrl} alt="receipt" className="w-full rounded-xl max-h-[28rem] object-contain" /></a>}
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

          {/* Why it needs attention (or, once reviewed, what remains outstanding) */}
          {r.status === 'needs_review' && shownReasons.length > 0 && (
            <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 px-3 py-2">
              <p className="text-amber-300 text-xs font-semibold">{r.clarifiedAt ? `Reviewed — still outstanding: ${outstandingKindLabel(shownReasons)}` : 'Needs attention'}</p>
              <ul className="text-amber-200/80 text-xs mt-1 list-disc list-inside">
                {shownReasons.map((k) => <li key={k}>{attentionReasonLabel(k)}</li>)}
              </ul>
              {r.clarifiedAt && <p className="text-gray-500 text-[11px] mt-1">Reviewed by {r.clarifiedBy ?? 'manager'} — the receipt info is confirmed; the payment/allocation is still open.</p>}
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
            <label className={lbl}>Shipping (inside the total)<br /><input value={shipping} onChange={(e) => setShipping(e.target.value)} disabled={decided} inputMode="decimal" placeholder="" className={box} /></label>
            <label className={lbl}>Invoice #<br /><input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} disabled={decided} maxLength={80} className={box} /></label>
            <label className={lbl}>Order #<br /><input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} disabled={decided} maxLength={80} className={box} /></label>
            <label className={lbl}>What was bought<br /><input value={description} onChange={(e) => setDescription(e.target.value)} disabled={decided} maxLength={300} className={box} /></label>
          </div>
          {dateWarn && (
            <div role="alert" className="rounded-xl border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
              {dateWarn.message}
              {dateWarn.suggestion && !decided && <button type="button" onClick={() => setReceiptDate(dateWarn.suggestion as string)} className="ml-2 underline text-indigo-300">Use {dateWarn.suggestion}</button>}
            </div>
          )}
          {sumWarn && <p role="alert" className="text-amber-300 text-xs">{sumWarn}</p>}

          <label className={lbl}>Paid with<br />
            <select value={paymentChoice} onChange={(e) => {
              setPaymentChoice(e.target.value)
              if (e.target.value !== 'other') { setOtherPayment(''); setOtherFunding(''); setOtherPaymentMethod('') }
              else if (!otherFunding) setOtherFunding('unclassified') // explicit default — the select never implies a classification nobody made
            }} disabled={decided} className={box}>
              <option value="">{receiptPaymentLabel(r)} (existing details)</option>
              {RECEIPT_PAYMENT_CHOICES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              <option value="unpaid">Not paid yet</option>
            </select>
          </label>
          {paymentChoice === 'other' && <div className="grid grid-cols-1 gap-3">
            <label className={lbl}>Other payment source (kept as entered)<br />
              <input value={otherPayment} onChange={(e) => setOtherPayment(e.target.value)} maxLength={OTHER_PAYMENT_MAX_LENGTH} disabled={decided} className={box} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              {/* Explicit classification — the description is never read to decide funding. */}
              <label className={lbl}>Whose money{!otherFunding || otherFunding === 'unclassified' ? <span className="text-amber-400"> · needs classifying</span> : null}<br />
                <select value={otherFunding} onChange={(e) => { setOtherFunding(e.target.value); if (e.target.value !== 'business') setOtherPaymentMethod('') }} disabled={decided} className={box}>
                  {OTHER_PAYMENT_FUNDINGS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select></label>
              {otherFunding === 'business' && (
                <label className={lbl}>Method{!otherPaymentMethod && <span className="text-amber-400"> · required</span>}<br />
                  <select value={otherPaymentMethod} onChange={(e) => setOtherPaymentMethod(e.target.value)} disabled={decided} className={box}>
                    <option value="">—</option>
                    {OTHER_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m === 'ach' ? 'ACH / bank transfer' : m}</option>)}
                  </select></label>
              )}
            </div>
          </div>}
          {!paymentChoice && <div className="grid grid-cols-2 gap-3">
            <label className={lbl}>Funding<br />
              <select value={funding} onChange={(e) => setFunding(e.target.value)} disabled={decided} className={box}>
                {FUNDING_SOURCES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select></label>
            <label className={lbl}>Method{suggested('paymentMethod')}<br />
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} disabled={decided} className={box}>
                <option value="">—</option>{PAYMENT_METHODS.filter((m) => m !== 'unknown').map((m) => <option key={m} value={m}>{m}</option>)}
              </select></label>
          </div>}

          {/* Which job / overhead this purchase was for. A link to THIS receipt — it never adds an expense. */}
          {r.status !== 'rejected' && (
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-3 space-y-2">
              <p className="text-gray-400 text-sm">Customer job</p>
              {allocations.length === 0 && <p className="text-gray-500 text-xs">Not assigned to a job. That is normal for a general shop expense.</p>}
              {allocations.map((a) => (
                <div key={a.id} className="flex items-start gap-2 text-sm">
                  <span className="flex-1 min-w-0 break-words text-gray-200">
                    {a.target === 'job'
                      ? (a.serviceOrderId ? <a href={`/orders/${a.serviceOrderId}`} className="underline text-indigo-300">{a.jobLabel ?? 'Job'}</a> : 'Job')
                      : 'Overhead (no job)'}
                    <span className="text-gray-400"> · {a.amountCents == null ? 'whole purchase' : formatMoney(a.amountCents)}</span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => { const reason = window.prompt('Why is this being removed from the job?'); if (reason !== null) run(() => removeAllocationAction({ allocationId: a.id, fromOrderId: a.serviceOrderId ?? undefined, reason }), 'Removed from the job.') }}
                    className="shrink-0 text-gray-400 text-xs underline py-1 disabled:opacity-50">Remove</button>
                </div>
              ))}
              {purchase.state === 'partial' && <p className="text-amber-300 text-xs">{formatMoney(purchase.unallocatedCents)} of {formatMoney(purchase.totalCents)} is not assigned yet.</p>}
              {purchase.state === 'over' && <p role="alert" className="text-red-300 text-xs">Assigned {formatMoney(purchase.overCents)} more than the purchase total — fix the amounts.</p>}
              {purchase.state !== 'full' && !purchase.whole && (
                <div className="space-y-2 pt-1">
                  <JobPicker value={pickJob} onChange={setPickJob} disabled={busy} />
                  <label className={lbl}>Amount for this job (blank = {allocations.length === 0 ? 'the whole purchase' : 'enter the split amount'})<br />
                    <input value={assignAmount} onChange={(e) => setAssignAmount(e.target.value)} inputMode="decimal" placeholder={allocations.length === 0 ? 'Whole purchase' : centsToDollars(purchase.unallocatedCents)} className={box} /></label>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => assign('job')} disabled={busy || !pickJob} className="flex-1 bg-indigo-600 text-white text-sm font-semibold py-3 rounded-xl disabled:opacity-50">Attach to job</button>
                    {allocations.length > 0 && <button type="button" onClick={() => assign('overhead')} disabled={busy || !assignAmount.trim()} className="flex-1 border border-gray-700 text-gray-200 text-sm font-semibold py-3 rounded-xl disabled:opacity-50">Rest is overhead</button>}
                  </div>
                </div>
              )}
            </div>
          )}

          <details className="rounded-xl border border-gray-800 bg-gray-900/60">
            <summary className="px-3 py-2 text-gray-400 text-sm cursor-pointer list-none">Sales-inventory vehicle &amp; note ▾</summary>
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

          {/* Diagnostic: what does the reader see in the stored document right now? Saves nothing. */}
          {r.imageUrl && (
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-3">
              <button type="button" onClick={checkReading} disabled={readingBusy} className="text-indigo-300 text-sm underline min-h-11 disabled:opacity-50">{readingBusy ? 'Reading the stored document…' : 'Check the reading (saves nothing)'}</button>
              <div aria-live="polite">
                {reading && !reading.ok && <p role="alert" className="text-amber-300 text-xs mt-1">{reading.error}</p>}
                {reading?.ok && reading.aiStatus !== 'extracted' && <p role="alert" className="text-amber-300 text-xs mt-1">The reader could not read this document. Nothing was changed.</p>}
                {reading?.ok && reading.aiStatus === 'extracted' && reading.read && reading.saved && (
                  <div className="mt-2">
                    <table className="w-full text-xs">
                      <thead><tr className="text-gray-500 text-left"><th className="font-normal py-1 pr-2">Field</th><th className="font-normal py-1 pr-2">Read now</th><th className="font-normal py-1">Saved</th></tr></thead>
                      <tbody>
                        {Object.keys(reading.read).map((k) => {
                          const differs = reading.differences?.includes(k)
                          return (<tr key={k} className={differs ? 'text-amber-200' : 'text-gray-300'}><td className="py-1 pr-2 text-gray-500">{k.replace(/Cents$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()}</td><td className="py-1 pr-2 break-all">{showVal(k, reading.read?.[k])}</td><td className="py-1 break-all">{showVal(k, reading.saved?.[k])}{differs ? ' ≠' : ''}</td></tr>)
                        })}
                      </tbody>
                    </table>
                    <p className="text-gray-500 text-[11px] mt-2">{reading.differences?.length ? `The reading differs from what is saved in ${reading.differences.length} field${reading.differences.length === 1 ? '' : 's'}. The saved values were confirmed by a person and were not changed.` : 'The reading agrees with what is saved.'} Payment card identified from the document: {reading.paymentSourceRead ?? 'none (never guessed)'}.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {r.status === 'rejected' && r.rejectedReason && <p className="text-gray-400 text-xs">Rejected: {r.rejectedReason}</p>}
          {r.status === 'filed' && <p className="text-emerald-400/80 text-xs">Filed by {r.filedBy ?? 'shop'} · operational filing (not yet in QuickBooks)</p>}
          {r.status === 'approved' && <p className="text-emerald-400/80 text-xs">Approved by {r.approvedBy ?? 'manager'} · legacy record (not yet in QuickBooks)</p>}
          {err && <p className="text-red-400 text-sm">{err}</p>}
          {note && <p className="text-emerald-400 text-sm">{note}</p>}

          {!decided ? (
            <div className="space-y-2">
              <button type="button" onClick={fileNow} disabled={busy} className="w-full bg-green-600 active:bg-green-700 text-white font-bold py-3 rounded-xl disabled:opacity-50">File receipt</button>
              {acknowledgeable && (
                <button type="button" onClick={acknowledgeNow} disabled={busy} className="w-full border border-amber-800/70 text-amber-200 font-semibold py-3 rounded-xl disabled:opacity-50">
                  Mark reviewed — {outstandingKindLabel(r.attentionReasons)} stays open
                </button>
              )}
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
