'use client'

/**
 * Combine unpaid invoices (manager/admin) — two of the same customer's retail Jobs each already have their own
 * unpaid Pitt Stop invoice; combine them into ONE (works after both Jobs are completed). All over
 * /api/workflow/orders/[id]/invoice/combine:
 *  - CombineInvoicesSection: the entry button on a Job's own invoice, and — whenever a combine is unfinished — the
 *    status panel with its recovery path (Retry / Finish, Cancel, Bill separately).
 *  - CombineInvoicesSheet: pick the other invoice → review (both invoices, each vehicle, combined total, which one
 *    stays, what happens to the other, emailed state) → explicit confirm.
 * The server re-checks every rule; this UI never decides eligibility. Nothing here ever emails.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import type { CombineDiscovery, CombinePreview, CombineSide, CombineState, CombineResult } from '@/apps/quickbooks/invoice-consolidation'
import type { SharedPreview } from '@/apps/quickbooks/shared-invoice'

const money = (c: number) => `$${(c / 100).toFixed(2)}`
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : null)
const api = (orderId: string) => `/api/workflow/orders/${orderId}/invoice/combine`
async function post<T>(orderId: string, body: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(api(orderId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => ({})) as T }
}

async function fetchCombineDiscovery(orderId: string): Promise<{ discovery: CombineDiscovery | null; error: string | null }> {
  try {
    const r = await fetch(`${api(orderId)}?discover=1`, { cache: 'no-store' })
    const d = await r.json().catch(() => null) as { ok?: boolean; discovery?: CombineDiscovery; error?: string } | null
    if (!r.ok || !d?.discovery) return { discovery: null, error: d?.error ?? 'Couldn’t check this customer’s other invoices.' }
    return { discovery: d.discovery, error: null }
  } catch { return { discovery: null, error: 'Network error — nothing was changed. Try again.' } }
}

function SideCard({ s, keeps }: { s: CombineSide; keeps: boolean }) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${keeps ? 'border-emerald-700 bg-emerald-950/30' : 'border-gray-700 bg-gray-800/30'}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-white text-sm font-semibold">Invoice #{s.invoiceNumber ?? s.invoiceId}</p>
        <span className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full ${keeps ? 'bg-emerald-900/70 text-emerald-200' : 'bg-red-950/70 text-red-200'}`}>
          {keeps ? 'Stays · bills both' : 'Voided · $0'}
        </span>
      </div>
      <p className="text-gray-300 text-sm mt-0.5 truncate">{s.vehicle}{s.orderNumber ? <span className="text-gray-500"> · {s.orderNumber}</span> : null}</p>
      <p className="text-gray-500 text-xs">
        {s.jobStatus === 'ready' || s.completedAt ? `Completed${s.completedAt ? ` ${when(s.completedAt)}` : ''}` : s.jobStatus}
        {' · '}
        <span className={s.emailed ? 'text-amber-300' : ''}>{s.emailed ? `Emailed${s.sentAt ? ` ${when(s.sentAt)}` : ''}` : 'Not emailed'}</span>
      </p>
      <div className="mt-2 space-y-1 text-sm">
        {s.services.map((x, i) => (
          <div key={i} className="flex justify-between gap-3"><span className="text-gray-300 truncate">{x.title}</span><span className="tabular-nums text-gray-200">{money(x.cents)}</span></div>
        ))}
        {s.shopSuppliesCents > 0 && <div className="flex justify-between"><span className="text-gray-400">Shop supplies</span><span className="tabular-nums text-gray-300">{money(s.shopSuppliesCents)}</span></div>}
        {s.paymentChargeCents > 0 && <div className="flex justify-between"><span className="text-gray-400">{s.paymentChargeLabel}</span><span className="tabular-nums text-gray-300">{money(s.paymentChargeCents)}</span></div>}
        {s.taxCents > 0 && <div className="flex justify-between"><span className="text-gray-400">Sales tax</span><span className="tabular-nums text-gray-300">{money(s.taxCents)}</span></div>}
        <div className="flex justify-between pt-1 border-t border-gray-800"><span className="text-gray-300 font-semibold">Invoice total</span><span className="tabular-nums text-white font-semibold">{money(s.totalCents)}</span></div>
      </div>
    </div>
  )
}

/** Pick → review → confirm. Closes with `changed` when a combine was started (success OR a recoverable stop). */
export function CombineInvoicesSheet({ orderId, onClose }: { orderId: string; onClose: (changed: boolean) => void }) {
  const [disc, setDisc] = useState<CombineDiscovery | null>(null)
  const [loadingDisc, setLoadingDisc] = useState(true)
  const [other, setOther] = useState<string | null>(null)
  const [retain, setRetain] = useState<string | null>(null)
  const [preview, setPreview] = useState<CombinePreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [ack, setAck] = useState(false)
  const [working, setWorking] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<CombineResult | null>(null)
  const reqId = useRef<string>('')
  const latest = useRef(0)


  const loadPreview = useCallback(async (otherId: string, retainId: string | null) => {
    const n = ++latest.current
    setLoadingPreview(true); setErr(null); setAck(false)
    try {
      const { data } = await post<CombinePreview>(orderId, { action: 'preview', otherOrderId: otherId, retainOrderId: retainId })
      if (n !== latest.current) return
      setPreview(data)
      // A fresh review is a fresh confirmation: a new request id, so a double tap on THIS review combines once.
      reqId.current = `${orderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      if (data.ok && data.retained) setRetain(data.retained.orderId)
    } catch { if (n === latest.current) setErr('Network error — nothing was changed. Try again.') }
    finally { if (n === latest.current) setLoadingPreview(false) }
  }, [orderId])
  const choose = useCallback((otherId: string) => { setOther(otherId); setRetain(null); void loadPreview(otherId, null) }, [loadPreview])

  // The manager always taps the invoice to review — nothing is pre-chosen. `discKey` re-runs the read (Retry).
  const [discKey, setDiscKey] = useState(0)
  useEffect(() => {
    let alive = true
    fetchCombineDiscovery(orderId).then((r) => {
      if (!alive) return
      setLoadingDisc(false)
      if (r.discovery) { setDisc(r.discovery); setErr(null) } else setErr(r.error)
    })
    return () => { alive = false }
  }, [orderId, discKey])

  const confirm = useCallback(async () => {
    if (!preview?.ok || !preview.retained || !preview.replaced || working) return
    setWorking(true); setErr(null)
    try {
      const { data } = await post<CombineResult>(orderId, {
        action: 'start', retainedOrderId: preview.retained.orderId, replacedOrderId: preview.replaced.orderId, requestId: reqId.current,
        expected: { retainedSyncToken: preview.retained.syncToken, replacedSyncToken: preview.replaced.syncToken, combinedTotalCents: preview.combinedTotalCents },
        acknowledgeEmailed: !!preview.emailedAny && ack,
      })
      if (data.status) { setDone(data); return }   // claimed: finished, or stopped somewhere recoverable
      if (data.block === 'stale' && other) { setErr(data.error ?? 'An invoice changed — review again.'); await loadPreview(other, retain); return }
      setErr(data.error ?? 'Couldn’t combine the invoices. Nothing was changed.')
    } catch { setErr('Network error — the combine may or may not have started. Close and reopen this invoice to see its status.') }
    finally { setWorking(false) }
  }, [preview, working, ack, orderId, loadPreview, other, retain])

  const canConfirm = !!preview?.ok && !working && !loadingPreview && (!preview.emailedAny || ack)
  const close = () => !working && onClose(!!done)

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={close}>
      <div role="dialog" aria-modal="true" aria-labelledby="combine-title"
        className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[92vh] overflow-y-auto text-left" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <>
            <h3 id="combine-title" className="text-white font-bold text-lg mb-1">
              {done.status === 'completed' ? `Combined into #${done.retainedInvoiceNumber}` : done.status === 'cancelled' ? 'Nothing was combined' : 'Combine not finished'}
            </h3>
            <p className="text-gray-300 text-sm">
              {done.status === 'completed'
                ? `Invoice #${done.retainedInvoiceNumber} now bills both vehicles (${money(done.combinedTotalCents ?? 0)}). Invoice #${done.replacedInvoiceNumber} is voided in QuickBooks ($0, kept in its history). Nothing was emailed.`
                : done.error ?? 'Open the invoice to finish or undo it.'}
            </p>
            {done.status !== 'completed' && done.status !== 'cancelled' && (
              <p className="text-amber-300 text-xs mt-2">Both invoices stay blocked from sending and payments until this is finished, cancelled or billed separately — use the Combine panel on either Job’s invoice.</p>
            )}
            <button onClick={() => onClose(true)} className="mt-5 w-full h-12 rounded-2xl bg-white text-black font-bold active:opacity-80">Done</button>
          </>
        ) : (
          <>
            <h3 id="combine-title" className="text-white font-bold text-lg mb-1">Combine unpaid invoices</h3>
            {loadingDisc ? <p className="text-gray-500 text-sm py-6 text-center" role="status">Checking this customer’s invoices in QuickBooks…</p>
              : disc?.blocked ? <p className="text-gray-300 text-sm mt-2">This invoice can’t be combined: {disc.blocked}</p>
              : disc && disc.candidates.length === 0 ? <p className="text-gray-300 text-sm mt-2">This customer has no other unpaid Pitt Stop invoice to combine with. Customers are matched by their QuickBooks record (email / phone), never by name.</p>
              : disc ? (
                <>
                  <p className="text-gray-400 text-sm mb-3">Choose the other invoice for the same customer.</p>
                  <div className="space-y-2">
                    {disc.candidates.map((c) => (
                      <button key={c.orderId} type="button" disabled={!c.eligible || working} aria-pressed={other === c.orderId}
                        onClick={() => choose(c.orderId)}
                        className={`w-full text-left rounded-2xl border px-4 py-3 active:opacity-80 disabled:opacity-50 ${other === c.orderId ? 'border-emerald-500 bg-emerald-950/40' : 'border-gray-700 bg-gray-800/40'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-white font-semibold">Invoice #{c.invoiceNumber ?? c.invoiceId}</span>
                          <span className="text-white font-bold tabular-nums">{money(c.totalCents)}</span>
                        </div>
                        <p className="text-gray-300 text-sm truncate">{c.vehicle}{c.orderNumber ? ` · ${c.orderNumber}` : ''}</p>
                        <p className={`text-xs ${c.emailed ? 'text-amber-300' : 'text-gray-500'}`}>{c.emailed ? 'Emailed' : 'Not emailed'}</p>
                        {!c.eligible && c.reason && <p className="text-gray-400 text-xs mt-1">Can’t combine: {c.reason}</p>}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}

            {other && (loadingPreview ? <p className="text-gray-500 text-sm py-6 text-center" role="status">Preparing the review…</p> : preview && !preview.ok ? (
              <p className="text-amber-300 text-sm mt-4" role="alert">Can’t combine: {preview.error}</p>
            ) : preview?.ok && preview.retained && preview.replaced ? (
              <div className="mt-5">
                <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Review</p>
                <div className="space-y-3">
                  <SideCard s={preview.retained} keeps />
                  <SideCard s={preview.replaced} keeps={false} />
                </div>
                <button type="button" disabled={working} onClick={() => void loadPreview(other, preview.replaced!.orderId)}
                  className="mt-2 text-blue-400 text-xs font-semibold active:opacity-70 disabled:opacity-40">
                  Keep #{preview.replaced.invoiceNumber} instead →
                </button>
                <div className="mt-4 rounded-2xl border border-gray-800 bg-gray-800/20 px-4 py-3">
                  <p className="text-gray-400 text-xs mb-1">Invoice #{preview.retained.invoiceNumber} after combining</p>
                  <div className="space-y-0.5 text-sm">
                    {preview.combinedLines?.map((l, i) => (
                      <div key={i} className="flex justify-between gap-3">
                        <span className={l.cents == null ? 'text-gray-400 text-xs pt-1' : 'text-gray-300 truncate'}>{l.description}</span>
                        {l.cents != null && <span className="tabular-nums text-gray-200">{money(l.cents)}</span>}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 pt-2 border-t border-gray-800 flex items-center justify-between">
                    <span className="text-gray-300 font-semibold">Combined total</span>
                    <span className="text-white text-2xl font-bold tabular-nums">{money(preview.combinedTotalCents ?? 0)}</span>
                  </div>
                </div>
                <ul className="mt-3 space-y-1.5 text-gray-300 text-sm list-disc pl-5">
                  {preview.plan?.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
                {preview.emailedAny && (
                  <label className="mt-3 flex items-start gap-3 rounded-xl border border-amber-800/70 bg-amber-950/30 px-3 py-3 text-amber-100 text-sm">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-amber-500" />
                    <span>{preview.emailGuidance} I understand.</span>
                  </label>
                )}
              </div>
            ) : null)}

            {err && <p className="text-red-400 text-sm mt-3" role="alert">{err}</p>}
            <div className="flex gap-3 mt-5">
              <button onClick={close} disabled={working} className="flex-1 h-12 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
              {preview?.ok && (
                <button onClick={confirm} disabled={!canConfirm} className="flex-1 h-12 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">
                  {working ? 'Combining…' : 'Combine invoices'}
                </button>
              )}
              {!disc && !loadingDisc && <button onClick={() => { setLoadingDisc(true); setErr(null); setDiscKey((k) => k + 1) }} className="flex-1 h-12 rounded-2xl bg-gray-700 text-white font-semibold active:opacity-80">Retry</button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * On a Job's invoice: the "Combine unpaid invoices" entry (when `canOffer`) and, whenever a combine touching this
 * Job is unfinished, its status + recovery actions. `enabled` = the feature flag; an unfinished combine's status
 * always shows, but its recovery actions need the flag on (the panel says so).
 */
export function CombineInvoicesSection({ orderId, state, enabled, canOffer, disabled, onChanged }: {
  orderId: string; state: CombineState | null | undefined; enabled: boolean
  /** This Job has its own unpaid, settled retail invoice that isn't shared → it may be combined. */
  canOffer: boolean
  disabled?: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<null | 'resume' | 'cancel' | 'separate'>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirmSeparate, setConfirmSeparate] = useState(false)
  const [review, setReview] = useState<SharedPreview | null>(null)

  const act = useCallback(async (action: 'resume' | 'cancel' | 'separate', extra: Record<string, unknown> = {}) => {
    if (busy) return
    setBusy(action); setMsg(null)
    try {
      const { data } = await post<CombineResult>(orderId, { action, ...extra })
      if (action === 'resume' && !data.ok && data.block === 'stale') {
        // The retained invoice changed since the original review (e.g. an earlier update landed): review it fresh.
        const { data: rv } = await post<SharedPreview>(orderId, { action: 'review' })
        setReview(rv)
        setMsg(data.error ?? 'Review the combined invoice, then finish.')
        return
      }
      if (!data.ok) setMsg(data.error ?? 'That didn’t finish — check the status below.')
      setReview(null); setConfirmSeparate(false)
      onChanged()
    } catch { setMsg('Network error — check the status before trying again.') }
    finally { setBusy(null) }
  }, [busy, orderId, onChanged])

  if (state?.active) {
    const voided = state.status !== 'prepared'
    return (
      <div className="mt-4 rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3" role="status">
        <p className="text-amber-300 text-sm font-semibold">Combining #{state.replaced.invoiceNumber} into #{state.retained.invoiceNumber} — not finished</p>
        <p className="text-amber-100/90 text-sm mt-1">{state.summary}</p>
        {state.attention && <p className="text-amber-300/90 text-xs mt-2">Last problem: {state.attention}</p>}
        {state.emailGuidance && <p className="text-gray-300 text-xs mt-2">{state.emailGuidance}</p>}
        <p className="text-gray-400 text-xs mt-2">Sending, payments and other invoice changes are blocked on both invoices until this is resolved.</p>
        {!enabled ? (
          <p className="text-gray-500 text-xs mt-2">Combining invoices is turned off — turn it back on to finish or undo this.</p>
        ) : (
          <>
            {review?.ok && (
              <div className="mt-3 rounded-xl border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-300">Combined total now</span><span className="text-white font-bold tabular-nums">{money(review.combinedTotalCents ?? 0)}</span></div>
                {review.qbTotalCents != null && <div className="flex justify-between text-xs"><span className="text-gray-500">QuickBooks invoice now</span><span className="text-gray-400 tabular-nums">{money(review.qbTotalCents)}</span></div>}
                {(review.blockers?.length ?? 0) > 0 && <ul className="mt-1 text-amber-300 text-xs space-y-0.5">{review.blockers!.map((b, i) => <li key={i}>{b}</li>)}</ul>}
              </div>
            )}
            <button onClick={() => void act('resume', review?.ok ? { syncToken: review.syncToken, combinedTotalCents: review.combinedTotalCents, confirmSent: !!review.emailed } : {})}
              disabled={disabled || !!busy || (review != null && (!review.ok || (review.blockers?.length ?? 0) > 0))}
              className="mt-3 w-full text-white font-semibold text-base py-3 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
              {busy === 'resume' ? 'Working…' : review?.ok ? `Finish — update #${state.retained.invoiceNumber} to ${money(review.combinedTotalCents ?? 0)}` : voided ? 'Retry — finish combining' : 'Retry'}
            </button>
            {state.canCancel && (
              <button onClick={() => void act('cancel')} disabled={disabled || !!busy}
                className="mt-2 w-full font-semibold text-sm py-2.5 rounded-2xl border border-gray-700 text-gray-300 active:opacity-80 disabled:opacity-50">
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel — keep both invoices as they are'}
              </button>
            )}
            {state.canSeparate && (confirmSeparate ? (
              <div className="mt-2 rounded-xl border border-gray-700 px-3 py-3">
                <p className="text-gray-200 text-sm">#{state.replaced.invoiceNumber} stays voided. #{state.retained.invoiceNumber} keeps only its own charges. The other vehicle goes back to normal billing — create a <span className="font-semibold">new</span> invoice for it from its Job.</p>
                <div className="flex gap-2 mt-2">
                  <button onClick={() => setConfirmSeparate(false)} disabled={!!busy} className="flex-1 h-11 rounded-xl border border-gray-700 text-gray-300 text-sm font-semibold">Back</button>
                  <button onClick={() => void act('separate')} disabled={disabled || !!busy} className="flex-1 h-11 rounded-xl bg-amber-600 text-white text-sm font-bold disabled:opacity-50">{busy === 'separate' ? 'Working…' : 'Bill separately'}</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirmSeparate(true)} disabled={disabled || !!busy}
                className="mt-2 w-full font-semibold text-sm py-2.5 rounded-2xl border border-gray-700 text-gray-300 active:opacity-80 disabled:opacity-50">
                Bill that vehicle separately instead…
              </button>
            ))}
          </>
        )}
        {msg && <p className="text-amber-400 text-xs mt-2" role="alert">{msg}</p>}
      </div>
    )
  }

  return (
    <>
      {state && (state.status === 'completed' || state.status === 'separated') && (
        <p className="text-gray-500 text-xs mt-3">{state.summary}{state.status === 'completed' && state.emailGuidance ? ` ${state.emailGuidance}` : ''}</p>
      )}
      {enabled && canOffer && (
        <button onClick={() => setOpen(true)} disabled={disabled}
          className="mt-3 w-full font-semibold text-sm py-2.5 rounded-2xl border border-gray-700 text-gray-300 active:opacity-80 disabled:opacity-50">
          Combine unpaid invoices…
        </button>
      )}
      {open && <CombineInvoicesSheet orderId={orderId} onClose={(changed) => { setOpen(false); if (changed) onChanged() }} />}
    </>
  )
}
