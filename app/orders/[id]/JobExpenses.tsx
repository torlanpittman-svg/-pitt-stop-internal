'use client'
/**
 * Job screen → Expenses. What we actually SPENT on this customer's car, backed by receipts.
 *
 *   - "Add expense / receipt" (every role) opens receipt capture with this job, customer and vehicle already
 *     selected: open job → add receipt → review → save.
 *   - Managers see each recorded purchase (vendor, what, date, amount, payment account, the receipt itself)
 *     and the job total, can attach a receipt that is ALREADY filed (no re-upload), and can move, split or
 *     remove an assignment (audited).
 *
 * Every row is a LINK to one filed receipt — never a second expense, never a customer price, never an invoice
 * line. A receipt that still needs review is listed but kept out of the total.
 *
 * On the Job screen this is ONE row — "Expenses", the recorded total (managers), a chevron. Tapping it (or
 * choosing Expense from the Job's "+ Add" menu, via `openSignal`) opens everything above in place.
 */
import Link from 'next/link'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  loadJobExpensesAction, listLinkableReceiptsAction, linkReceiptAction, changeAllocationAction, removeAllocationAction,
} from '@/apps/expenses/job-actions'
import type { JobExpenses as JobExpensesData, JobExpenseItem, LinkableReceipt } from '@/apps/expenses/job-expenses'
import JobPicker, { type PickedJob } from '@/apps/expenses/ui/JobPicker'

const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const input = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-base text-white'
const ghost = 'rounded-xl border border-gray-700 px-3 py-3 text-sm font-semibold text-gray-200 disabled:opacity-40'

export default function JobExpenses({ orderId, manager, cancelled = false, openSignal = 0 }: {
  orderId: string; manager: boolean; cancelled?: boolean
  /** Bump to open the section and move focus to its first action (the Job's "+ Add" → Expense). */
  openSignal?: number
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const panel = useRef<HTMLDivElement>(null)
  // "+ Add" → Expense: open, then (once the opened section has rendered) bring it into view and focus its first action.
  const seenSignal = useRef(openSignal)
  const [focusRequest, setFocusRequest] = useState(0)
  useEffect(() => {
    if (openSignal === seenSignal.current) return
    seenSignal.current = openSignal
    setOpen(true); setFocusRequest((n) => n + 1)
  }, [openSignal])
  useEffect(() => {
    if (!focusRequest || !open) return
    const el = panel.current
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    ;(el.querySelector<HTMLElement>('a[href], button:not([disabled])') ?? el).focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per request, after the section is open
  }, [focusRequest])
  const [data, setData] = useState<JobExpensesData | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)

  const load = useCallback(async () => {
    if (!manager) return
    const res = await loadJobExpensesAction(orderId).catch(() => null)
    if (res?.ok && res.data) { setData(res.data); setLoadErr('') } else setLoadErr(res?.error || 'Could not load expenses. Check your connection and try again.')
  }, [orderId, manager])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch of this section's data
  useEffect(() => { load() }, [load])

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    if (busy) return false
    setBusy(true); setErr(''); setNote('')
    let ok = false
    try {
      const res = await fn()
      if (res.ok) { ok = true; setNote(done); setEditing(null); await load() } else setErr(res.error || 'Something went wrong.')
    } catch { setErr('Could not reach the server. Nothing was changed.') }
    setBusy(false)
    return ok
  }

  return (
    <section aria-labelledby="job-expenses-title" className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
      <h2 id="job-expenses-title">
        <button type="button" data-job-expenses-toggle aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}
          className="flex w-full min-h-14 items-center justify-between gap-3 px-4 py-3 text-left active:bg-gray-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/70">
          <span className="text-white font-semibold text-base">Expenses</span>
          <span className="flex items-center gap-3">
            {manager && data && <span className="text-white text-base tabular-nums"><span className="sr-only">recorded for this job: </span>{money(data.recordedCents)}</span>}
            <span aria-hidden className={`text-gray-400 text-lg transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
          </span>
        </button>
      </h2>
      <div id={panelId} ref={panel} tabIndex={-1} hidden={!open} className="border-t border-gray-800 p-4 outline-none">
      <p className="text-gray-500 text-xs">What we spent on this car. Our cost only — it never changes the customer’s invoice, and no customer price is needed.</p>

      {!cancelled && (
        <Link href={`/expenses?job=${orderId}`} className="mt-3 block w-full text-center bg-indigo-600 active:bg-indigo-700 text-white text-base font-bold py-4 rounded-2xl">
          Add expense / receipt
        </Link>
      )}
      {!manager && <p className="text-gray-500 text-xs mt-2">The receipt is attached to this job. Amounts are visible to managers.</p>}

      {manager && loadErr && <p role="alert" className="text-amber-300 text-sm mt-3">{loadErr} <button type="button" onClick={load} className="underline">Retry</button></p>}
      {manager && !data && !loadErr && <p className="text-gray-500 text-sm mt-3">Loading expenses…</p>}

      {manager && data && (
        <div className="mt-4 space-y-3">
          {data.items.length === 0 && <p className="text-gray-500 text-sm">No expenses recorded for this job yet.</p>}
          <ul className="space-y-3">
            {data.items.map((i) => (
              <li key={i.allocationId} className="rounded-xl border border-gray-800 bg-gray-950/40 p-3">
                <ExpenseRow i={i} />
                {editing === i.allocationId ? (
                  <EditAssignment i={i} orderId={orderId} parts={data.unlinkedPartCosts} busy={busy} onCancel={() => setEditing(null)} run={run} />
                ) : (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {i.receiptUrl && <a href={i.receiptUrl} target="_blank" rel="noreferrer" className="text-indigo-300 text-sm underline py-3 min-h-11 inline-flex items-center">View receipt{i.contentType === 'application/pdf' ? ' (PDF)' : ''}</a>}
                    <button type="button" onClick={() => { setEditing(i.allocationId); setErr(''); setNote('') }} className="text-gray-300 text-sm underline py-3 min-h-11 inline-flex items-center">Fix or move</button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {data.pendingCount > 0 && (
            <p className="text-amber-300 text-xs">{data.pendingCount} receipt{data.pendingCount === 1 ? '' : 's'} ({money(data.pendingCents)}) still need{data.pendingCount === 1 ? 's' : ''} review and {data.pendingCount === 1 ? 'is' : 'are'} not in the total yet. Finish {data.pendingCount === 1 ? 'it' : 'them'} in <Link href="/expenses/review" className="underline">Receipts</Link>.</p>
          )}

          {data.unlinkedPartCosts.length > 0 && (
            <div className="rounded-xl border border-gray-800 px-3 py-2">
              <p className="text-gray-300 text-sm">Part cost typed on this job, with no receipt attached: {money(data.unlinkedPartCostCents)}</p>
              <p className="text-gray-500 text-xs mt-1">Not added to the total above, because a part’s cost and its receipt are the same purchase. If the receipt is already here, use “Fix or move” on it and pick the part.</p>
              <ul className="text-gray-400 text-xs mt-1 list-disc list-inside">
                {data.unlinkedPartCosts.map((p) => <li key={p.partId}>{p.description} — {money(p.costCents)}</li>)}
              </ul>
            </div>
          )}

          {!cancelled && (linkOpen
            ? <LinkExisting orderId={orderId} busy={busy} run={run} onClose={() => setLinkOpen(false)} />
            : <button type="button" onClick={() => { setLinkOpen(true); setErr(''); setNote('') }} className={`${ghost} w-full`}>Link a receipt that is already filed</button>)}

          <div aria-live="polite">
            {err && <p role="alert" className="text-red-400 text-sm">{err}</p>}
            {note && <p className="text-emerald-400 text-sm">{note}</p>}
          </div>
          <p className="text-gray-600 text-xs">Recorded purchases only. Labor, chemicals, shop supplies and overhead are not included, so this is not the job’s profit.</p>
        </div>
      )}
      </div>
    </section>
  )
}

function ExpenseRow({ i }: { i: JobExpenseItem }) {
  const split = !i.wholePurchase
  const components = [
    i.shippingCents != null && i.shippingCents > 0 ? `shipping ${money(i.shippingCents)}` : null,
    i.taxCents != null ? `tax ${money(i.taxCents)}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-semibold break-words">{i.vendor || 'Vendor not recorded'}</p>
          {i.description && <p className="text-gray-300 text-sm break-words">{i.description}</p>}
        </div>
        <p className="shrink-0 text-white font-bold tabular-nums">{money(i.amountCents)}</p>
      </div>
      <dl className="mt-1 text-xs text-gray-400 space-y-0.5">
        <div><dt className="inline text-gray-500">Date: </dt><dd className="inline">{i.receiptDate ?? 'not recorded'}</dd></div>
        <div><dt className="inline text-gray-500">Paid with: </dt><dd className="inline break-words">{i.paymentLabel}</dd></div>
        {(i.invoiceNumber || i.orderNumber) && (
          <div className="break-words"><dt className="inline text-gray-500">Vendor ref: </dt><dd className="inline">{[i.invoiceNumber && `invoice ${i.invoiceNumber}`, i.orderNumber && `order ${i.orderNumber}`].filter(Boolean).join(' · ')}</dd></div>
        )}
        {components && <div><dt className="inline text-gray-500">Inside the total: </dt><dd className="inline">{components}</dd></div>}
        {split && <div><dt className="inline text-gray-500">Split: </dt><dd className="inline">{money(i.amountCents)} of a {money(i.receiptTotalCents)} purchase{i.purchase.state === 'partial' ? ` · ${money(i.purchase.unallocatedCents)} not assigned yet` : ''}</dd></div>}
      </dl>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
        {!i.recorded && <span className="rounded-full border border-amber-900/60 bg-amber-950/30 text-amber-300 px-2 py-0.5">Needs review — not in total</span>}
        {i.purchase.state === 'over' && <span className="rounded-full border border-red-900/60 bg-red-950/30 text-red-300 px-2 py-0.5">Assigned more than the purchase</span>}
        <span className="rounded-full border border-gray-700 text-gray-400 px-2 py-0.5">{i.bankMatch === 'confirmed' ? 'Bank: matched' : i.bankMatch === 'dismissed' ? 'Bank: no match expected' : 'Bank: not matched yet'}</span>
        <span className="rounded-full border border-gray-700 text-gray-400 px-2 py-0.5">{i.qbSyncStatus === 'synced' ? 'QuickBooks: posted' : 'QuickBooks: not posted'}</span>
      </div>
    </div>
  )
}

type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => Promise<boolean>

function EditAssignment({ i, orderId, parts, busy, onCancel, run }: {
  i: JobExpenseItem; orderId: string; parts: { partId: string; description: string; costCents: number }[]; busy: boolean; onCancel: () => void; run: Run
}) {
  const [moveTo, setMoveTo] = useState<PickedJob | null>(null)
  const [amount, setAmount] = useState(i.wholePurchase ? '' : ((i.amountCents ?? 0) / 100).toFixed(2))
  const [partId, setPartId] = useState(i.jobPartId ?? '')
  const [reason, setReason] = useState('')
  const amountChanged = amount.trim() !== (i.wholePurchase ? '' : ((i.amountCents ?? 0) / 100).toFixed(2))
  const partChanged = partId !== (i.jobPartId ?? '')
  return (
    <div className="mt-3 space-y-3 border-t border-gray-800 pt-3">
      <label className="block text-xs text-gray-500">Amount for this job (blank = the whole purchase)
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder={`Whole purchase (${money(i.receiptTotalCents)})`} disabled={busy} className={`mt-1 ${input}`} />
      </label>
      {(parts.length > 0 || i.jobPartId) && (
        <label className="block text-xs text-gray-500">This receipt is the purchase for a part on this job
          <select value={partId} onChange={(e) => setPartId(e.target.value)} disabled={busy} className={`mt-1 ${input}`}>
            <option value="">Not tied to a part line</option>
            {i.jobPartId && !parts.some((p) => p.partId === i.jobPartId) && <option value={i.jobPartId}>Current part</option>}
            {parts.map((p) => <option key={p.partId} value={p.partId}>{p.description} — {money(p.costCents)}</option>)}
          </select>
        </label>
      )}
      <div className="text-xs text-gray-500">Move to a different job
        <div className="mt-1"><JobPicker value={moveTo} onChange={setMoveTo} disabled={busy} /></div>
      </div>
      <label className="block text-xs text-gray-500">Reason (kept in the receipt’s history)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} disabled={busy} placeholder="e.g. attached to the wrong job" className={`mt-1 ${input}`} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={busy || !(moveTo || amountChanged || partChanged)} className="rounded-xl bg-indigo-600 px-3 py-3 text-sm font-bold text-white disabled:opacity-40"
          onClick={() => run(() => changeAllocationAction({
            allocationId: i.allocationId, fromOrderId: orderId, reason,
            serviceOrderId: moveTo?.id, amount: amountChanged ? amount : undefined, jobPartId: partChanged ? partId : undefined,
          }), moveTo ? 'Moved to the other job.' : 'Saved.')}>
          {busy ? 'Saving…' : moveTo ? 'Move' : 'Save'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={ghost}>Cancel</button>
      </div>
      <button type="button" disabled={busy} className="w-full text-sm text-red-300 underline py-3 min-h-11 disabled:opacity-40"
        onClick={() => { if (window.confirm('Take this purchase off this job? The receipt itself stays filed.')) run(() => removeAllocationAction({ allocationId: i.allocationId, fromOrderId: orderId, reason }), 'Removed from this job. The receipt is still filed.') }}>
        Remove from this job
      </button>
    </div>
  )
}

function LinkExisting({ orderId, busy, run, onClose }: { orderId: string; busy: boolean; run: Run; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<LinkableReceipt[] | null>(null)
  const [err, setErr] = useState('')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      const res = await listLinkableReceiptsAction(q).catch(() => null)
      if (!live) return
      if (res?.ok) { setRows(res.receipts); setErr('') } else setErr(res?.error || 'Could not load receipts.')
    }, q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [q])
  return (
    <div className="rounded-xl border border-gray-800 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-white text-sm font-semibold">Link a filed receipt</p>
        <button type="button" onClick={onClose} className="text-gray-400 text-sm px-2 py-2">Close</button>
      </div>
      <p className="text-gray-500 text-xs">Pick the receipt that is already in Receipts. Nothing is uploaded or entered again — it stays one expense.</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Vendor, invoice # or order #" aria-label="Search filed receipts" autoComplete="off" className={input} />
      {err && <p role="alert" className="text-amber-300 text-sm">{err}</p>}
      {!rows && !err && <p className="text-gray-500 text-sm">Loading receipts…</p>}
      {rows && rows.length === 0 && <p className="text-gray-500 text-sm">{q ? `No unassigned receipts match “${q}”.` : 'No unassigned receipts.'}</p>}
      <ul className="space-y-2">
        {(rows ?? []).map((r) => {
          const partial = r.purchase.state === 'partial'
          return (
            <li key={r.id} className="rounded-xl bg-gray-950/40 border border-gray-800 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-white text-sm font-semibold break-words">{r.vendor || 'Vendor not recorded'}</p>
                  <p className="text-gray-400 text-xs break-words">{[r.receiptDate, r.description, r.invoiceNumber && `invoice ${r.invoiceNumber}`, r.paymentLabel].filter(Boolean).join(' · ')}</p>
                  {r.status !== 'filed' && r.status !== 'approved' && <p className="text-amber-300 text-xs">Still needs review</p>}
                  {partial && <p className="text-amber-300 text-xs">{money(r.purchase.unallocatedCents)} of {money(r.totalCents)} not assigned yet</p>}
                </div>
                <p className="shrink-0 text-white font-bold tabular-nums">{money(r.totalCents)}</p>
              </div>
              <div className="mt-2 flex gap-2">
                <input value={amounts[r.id] ?? ''} onChange={(e) => setAmounts((a) => ({ ...a, [r.id]: e.target.value }))} inputMode="decimal"
                  aria-label={`Amount of the ${r.vendor ?? ''} receipt for this job`} placeholder={partial ? 'Amount for this job' : 'Whole purchase'} className={`${input} flex-1 min-w-0`} />
                <button type="button" disabled={busy || (partial && !(amounts[r.id] ?? '').trim())} className="shrink-0 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-40"
                  onClick={async () => { if (await run(() => linkReceiptAction({ receiptId: r.id, serviceOrderId: orderId, amount: amounts[r.id] ?? '' }), 'Receipt linked to this job. No new expense was created.')) onClose() }}>
                  Link
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
