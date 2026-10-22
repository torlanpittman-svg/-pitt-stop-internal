'use client'

/**
 * Shared retail invoice UI (manager/admin) — one QuickBooks invoice billing several of the same customer's
 * vehicles. Three pieces, all over /api/workflow/orders/[id]/invoice/shared:
 *  - useSharedInvoiceDiscovery + SharedInvoiceOfferSheet: "Kelvin Cooper has an open invoice. Add this vehicle?"
 *    (after Quick Entry saves a retail Job, and on demand from the Invoice Draft). Linking only ASSOCIATES the
 *    Job — nothing is charged or sent until a manager reviews and updates the invoice.
 *  - SharedInvoiceSection: the shared state on either Job's Invoice Draft (vehicles, pending, Keep separate).
 *  - SharedInvoiceReviewSheet: per-vehicle breakdown + combined total → update the SAME invoice (never resends).
 * The server re-checks every rule; this UI never decides eligibility on its own.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import type { DiscoveryResult, SharedCandidate, SharedInvoiceState, SharedPreview } from '@/apps/quickbooks/shared-invoice'

const money = (c: number) => `$${(c / 100).toFixed(2)}`
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : null)
const api = (orderId: string) => `/api/workflow/orders/${orderId}/invoice/shared`

const UPDATE_BLOCK_MSG: Record<string, string> = {
  stale: 'The invoice changed in QuickBooks since you opened this review. Review it again.',
  lines_changed: 'The invoice’s lines were changed in QuickBooks — reconcile it there before adding vehicles.',
  member_unready: 'A linked vehicle isn’t ready to bill yet — finish its pricing first.',
  member_customer_mismatch: 'A linked vehicle no longer belongs to this invoice’s customer — keep it separate.',
  syncing: 'This invoice is already being updated.',
  paid: 'A payment is recorded on this invoice — correct it in QuickBooks.',
  no_invoice: 'This Job isn’t on a shared invoice.',
}

export type DiscoveryStatus = 'idle' | 'loading' | 'done' | 'error'

async function fetchDiscovery(orderId: string): Promise<{ status: DiscoveryStatus; result: DiscoveryResult | null }> {
  try {
    const r = await fetch(`${api(orderId)}?discover=1`, { cache: 'no-store' })
    const d = await r.json().catch(() => null) as { ok?: boolean; enabled?: boolean; discovery?: DiscoveryResult } | null
    if (!r.ok || !d?.ok) return { status: r.status === 403 ? 'done' : 'error', result: null }
    if (!d.enabled || !d.discovery) return { status: 'done', result: null }
    return { status: d.discovery.error ? 'error' : 'done', result: d.discovery }
  } catch { return { status: 'error', result: null } }
}

/**
 * Read-only lookup of this Job's eligible open invoices. With `auto`, it runs once per `orderId`; `retry` (re)runs
 * it on demand. A result is only ever shown for the Job it was fetched for.
 */
export function useSharedInvoiceDiscovery(orderId: string | null, auto: boolean) {
  const [state, setState] = useState<{ key: string | null; status: DiscoveryStatus; result: DiscoveryResult | null }>({ key: null, status: 'idle', result: null })
  const latest = useRef(0)
  const load = useCallback(async (id: string) => {
    const n = ++latest.current
    const r = await fetchDiscovery(id)
    if (n === latest.current) setState({ key: id, ...r })
  }, [])
  useEffect(() => { if (auto && orderId) void load(orderId) }, [auto, orderId, load])
  const retry = useCallback(() => {
    if (!orderId) return
    setState({ key: orderId, status: 'loading', result: null })
    void load(orderId)
  }, [orderId, load])
  const current = state.key === orderId
  const status: DiscoveryStatus = !orderId ? 'idle' : current ? state.status : auto ? 'loading' : 'idle'
  const result = current ? state.result : null
  const eligible = result?.candidates.filter((c) => c.eligible) ?? []
  return { status, result, eligible, retry }
}

function CandidateCard({ c, selected, onSelect }: { c: SharedCandidate; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} disabled={!c.eligible} aria-pressed={selected}
      className={`w-full text-left rounded-2xl border px-4 py-3 active:opacity-80 disabled:opacity-50 ${selected ? 'border-emerald-500 bg-emerald-950/40' : 'border-gray-700 bg-gray-800/40'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-white font-semibold text-base">Invoice #{c.invoiceNumber ?? c.invoiceId}</span>
        <span className="text-white font-bold tabular-nums">{money(c.balanceCents)} <span className="text-gray-500 text-xs font-normal">open</span></span>
      </div>
      <ul className="mt-1 space-y-0.5">
        {c.vehicles.map((v, i) => <li key={i} className="text-gray-300 text-sm truncate">{v}</li>)}
      </ul>
      <p className={`text-xs mt-1.5 ${c.emailed ? 'text-amber-300' : 'text-gray-500'}`}>
        {c.emailed ? `Already emailed${c.sentAt ? ` ${when(c.sentAt)}` : ''} — the customer has the current version` : 'Not emailed yet'}
        {c.txnDate ? ` · dated ${c.txnDate}` : ''}
      </p>
      {!c.eligible && c.reason && <p className="text-gray-400 text-xs mt-1">Can’t add: {c.reason}</p>}
    </button>
  )
}

/**
 * The offer. `discovery` comes from useSharedInvoiceDiscovery. "Keep separate" just closes — nothing was linked.
 * "Add to invoice" links this Job as PENDING (no QuickBooks write, no email).
 */
export function SharedInvoiceOfferSheet({ orderId, discovery, onClose, onLinked }: {
  orderId: string; discovery: DiscoveryResult; onClose: () => void; onLinked?: (invoiceNumber: string | null) => void
}) {
  const eligible = discovery.candidates.filter((c) => c.eligible)
  const [pick, setPick] = useState<string | null>(eligible.length === 1 ? eligible[0].invoiceId : null)
  const [linking, setLinking] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [reqId] = useState(() => `${orderId}-${Date.now()}`)   // one id per offer: a double-tap links once
  const chosen = discovery.candidates.find((c) => c.invoiceId === pick && c.eligible) ?? null
  const name = discovery.customerName || 'This customer'

  const link = useCallback(async () => {
    if (!chosen || linking) return
    setLinking(true); setErr(null)
    try {
      const r = await fetch(api(orderId), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'link', anchorOrderId: chosen.anchorOrderId, invoiceId: chosen.invoiceId, syncToken: chosen.syncToken, requestId: reqId }),
      })
      const d = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; invoiceNumber?: string | null }
      if (!r.ok || !d.ok) { setErr(d.error ?? 'Couldn’t add this vehicle to that invoice. The Job is saved — try again from its invoice.'); return }
      const num = d.invoiceNumber ?? chosen.invoiceNumber
      setDone(num); onLinked?.(num)
    } catch { setErr('Network error — the Job is saved. Try again from its invoice.') }
    finally { setLinking(false) }
  }, [chosen, linking, orderId, reqId, onLinked])

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !linking && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="shared-offer-title"
        className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[92vh] overflow-y-auto text-left" onClick={(e) => e.stopPropagation()}>
        {done !== null ? (
          <>
            <h3 id="shared-offer-title" className="text-white font-bold text-lg mb-1">Added to invoice{done ? ` #${done}` : ''}</h3>
            <p className="text-gray-300 text-sm">This vehicle is linked but <span className="font-semibold">not charged yet</span>. Its charges go on the invoice when a manager reviews and updates it from either Job’s invoice. Nothing was emailed.</p>
            <button onClick={onClose} className="mt-5 w-full h-12 rounded-2xl bg-white text-black font-bold active:opacity-80">Done</button>
          </>
        ) : eligible.length === 0 ? (
          <>
            <h3 id="shared-offer-title" className="text-white font-bold text-lg mb-1">No open invoice to add to</h3>
            <p className="text-gray-400 text-sm">{discovery.message ?? `${name} has no unpaid Pitt Stop invoice this vehicle can join. It will be billed on its own.`}</p>
            {discovery.candidates.length > 0 && <div className="space-y-2.5 mt-4">{discovery.candidates.map((c) => <CandidateCard key={c.invoiceId} c={c} selected={false} onSelect={() => {}} />)}</div>}
            <button onClick={onClose} className="mt-5 w-full h-12 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70">Close</button>
          </>
        ) : (
          <>
            <h3 id="shared-offer-title" className="text-white font-bold text-lg mb-1">
              {name} has {eligible.length > 1 ? 'open invoices' : 'an open invoice'}.
            </h3>
            <p className="text-gray-300 text-sm mb-4">
              Would you like to add this vehicle{discovery.vehicle ? ` (${discovery.vehicle})` : ''} to {eligible.length > 1 ? 'one of them' : 'that invoice'}?
            </p>
            <div className="space-y-2.5">
              {discovery.candidates.map((c) => <CandidateCard key={c.invoiceId} c={c} selected={pick === c.invoiceId} onSelect={() => setPick(c.invoiceId)} />)}
            </div>
            {chosen?.emailed && (
              <p className="mt-3 rounded-xl border border-amber-800/70 bg-amber-950/30 px-3 py-2 text-amber-200 text-xs">
                This invoice was already emailed. Adding a vehicle won’t resend it — you’ll review the updated total, and resending stays a separate, deliberate step.
              </p>
            )}
            <p className="text-gray-500 text-xs mt-3">Adding only links the vehicle. Nothing is charged or emailed until a manager reviews the combined invoice and updates it.</p>
            {err && <p className="text-red-400 text-sm mt-3" role="alert">{err}</p>}
            <div className="flex gap-3 mt-5">
              <button onClick={onClose} disabled={linking} className="flex-1 h-12 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Keep separate</button>
              <button onClick={link} disabled={!chosen || linking} className="flex-1 h-12 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">
                {linking ? 'Adding…' : 'Add to invoice'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

async function fetchSharedPreview(orderId: string): Promise<{ preview: SharedPreview | null; error: string | null }> {
  try {
    const r = await fetch(api(orderId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'preview' }) })
    const d = await r.json().catch(() => null) as SharedPreview | null
    return { preview: d, error: d?.ok ? null : d?.error ?? 'Couldn’t read the shared invoice. Try again.' }
  } catch { return { preview: null, error: 'Network error — try again.' } }
}

/** Review the combined invoice (per-vehicle breakdown + total) and update the SAME QuickBooks invoice. */
export function SharedInvoiceReviewSheet({ orderId, onClose, onUpdated }: { orderId: string; onClose: () => void; onUpdated: () => void }) {
  const [preview, setPreview] = useState<SharedPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [ackSent, setAckSent] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Initial read: state is only set once it resolves, and never after the sheet closes.
  useEffect(() => {
    let alive = true
    fetchSharedPreview(orderId).then((r) => { if (alive) { setPreview(r.preview); setErr(r.error); setLoading(false) } })
    return () => { alive = false }
  }, [orderId])
  const load = useCallback(async () => {
    setLoading(true); setErr(null); setAckSent(false)
    const r = await fetchSharedPreview(orderId)
    setPreview(r.preview); setErr(r.error); setLoading(false)
  }, [orderId])

  const blockers = preview?.blockers ?? []
  const canUpdate = !!preview?.ok && !!preview.syncToken && blockers.length === 0 && (!preview.emailed || ackSent) && !updating

  const update = useCallback(async () => {
    if (!preview?.syncToken || updating) return
    setUpdating(true); setErr(null)
    try {
      const r = await fetch(api(orderId), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', syncToken: preview.syncToken, confirmSent: !!preview.emailed && ackSent }),
      })
      const d = await r.json().catch(() => ({})) as { ok?: boolean; block?: string; error?: string }
      if (r.ok && d.ok) { onUpdated(); onClose(); return }
      if (d.block === 'confirm_required') { setAckSent(false); setErr('This invoice was already emailed — confirm below to update it (it will not be resent).'); return }
      setErr(d.error ?? UPDATE_BLOCK_MSG[d.block ?? ''] ?? 'Couldn’t update the invoice.')
      if (d.block === 'stale') await load()
    } catch { setErr('Network error — check the invoice before trying again.') }
    finally { setUpdating(false) }
  }, [preview, updating, ackSent, orderId, onUpdated, onClose, load])

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !updating && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="shared-review-title"
        className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 id="shared-review-title" className="text-white font-bold text-lg mb-1">
          Review shared invoice{preview?.invoiceNumber ? ` #${preview.invoiceNumber}` : ''}
        </h3>
        {loading ? <p className="text-gray-500 text-sm py-6 text-center" role="status">Loading the combined invoice…</p> : preview?.ok && preview.parts ? (
          <>
            <p className="text-gray-400 text-sm mb-4">Each vehicle keeps its own Job, pricing and history. The invoice is rebuilt from all of them below.</p>
            <div className="space-y-3">
              {preview.parts.map((p, i) => (
                <div key={p.orderId} className="rounded-2xl border border-gray-800 bg-gray-800/30 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-white text-sm font-semibold truncate">Vehicle {i + 1} · {p.vehicle}</p>
                    <span className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full ${p.state === 'pending' ? 'bg-amber-900/60 text-amber-200' : 'bg-gray-800 text-gray-400'}`}>
                      {p.state === 'pending' ? 'Being added' : 'On invoice'}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-sm">
                    {p.services.map((s, j) => (
                      <div key={j} className="flex justify-between gap-3"><span className="text-gray-300 truncate">{s.title}</span><span className="tabular-nums text-gray-200">{money(s.cents)}</span></div>
                    ))}
                    {p.shopSuppliesCents > 0 && <div className="flex justify-between"><span className="text-gray-400">Shop supplies</span><span className="tabular-nums text-gray-300">{money(p.shopSuppliesCents)}</span></div>}
                    {p.paymentChargeCents > 0 && <div className="flex justify-between"><span className="text-gray-400">{p.paymentChargeLabel}</span><span className="tabular-nums text-gray-300">{money(p.paymentChargeCents)}</span></div>}
                    {p.taxCents > 0 && <div className="flex justify-between"><span className="text-gray-400">Sales tax</span><span className="tabular-nums text-gray-300">{money(p.taxCents)}</span></div>}
                    <div className="flex justify-between pt-1 border-t border-gray-800"><span className="text-gray-300 font-semibold">Vehicle total</span><span className="tabular-nums text-white font-semibold">{money(p.totalCents)}</span></div>
                  </div>
                  {p.issue && <p className="text-amber-300 text-xs mt-2">{p.issue}</p>}
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-gray-300 font-semibold">Combined total</span>
              <span className="text-white text-2xl font-bold tabular-nums">{money(preview.combinedTotalCents ?? 0)}</span>
            </div>
            {preview.qbTotalCents != null && (
              <p className="text-gray-500 text-xs text-right">QuickBooks invoice now: {money(preview.qbTotalCents)}</p>
            )}
            {blockers.length > 0 && (
              <ul className="mt-3 rounded-xl border border-amber-800/70 bg-amber-950/30 px-3 py-2 text-amber-200 text-xs space-y-1" role="alert">
                {blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            )}
            {preview.emailed && (
              <label className="mt-3 flex items-start gap-3 rounded-xl border border-amber-800/70 bg-amber-950/30 px-3 py-3 text-amber-100 text-sm">
                <input type="checkbox" checked={ackSent} onChange={(e) => setAckSent(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-amber-500" />
                <span>This invoice was already emailed{preview.sentAt ? ` (${when(preview.sentAt)})` : ''}. I’ve reviewed the new total. Updating it will <span className="font-semibold">not</span> resend it — resending is a separate step.</span>
              </label>
            )}
            {err && <p className="text-red-400 text-sm mt-3" role="alert">{err}</p>}
            <div className="flex gap-3 mt-5">
              <button onClick={onClose} disabled={updating} className="flex-1 h-12 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
              <button onClick={update} disabled={!canUpdate} className="flex-1 h-12 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">
                {updating ? 'Updating…' : 'Update invoice'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-red-400 text-sm mt-2" role="alert">{err ?? 'Couldn’t read the shared invoice.'}</p>
            <div className="flex gap-3 mt-5">
              <button onClick={onClose} className="flex-1 h-12 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70">Close</button>
              <button onClick={() => void load()} className="flex-1 h-12 rounded-2xl bg-gray-700 text-white font-semibold active:opacity-80">Retry</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The shared-invoice block on a Job's Invoice Draft. Shows the shared state (either side) and, for a retail Job
 * not yet invoiced, an "Add to an open invoice" action. `enabled` = the feature flag (state still shows when off).
 */
export function SharedInvoiceSection({ orderId, shared, enabled, canOffer, disabled, onChanged }: {
  orderId: string; shared: SharedInvoiceState | null | undefined; enabled: boolean
  /** Retail, priced-or-not, no QuickBooks invoice of its own yet → may join another vehicle's invoice. */
  canOffer: boolean
  disabled?: boolean
  onChanged: () => void
}) {
  const [offerOpen, setOfferOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const linkedRef = useRef(false)   // refresh the draft only once the "Added" confirmation is closed
  const disc = useSharedInvoiceDiscovery(orderId, false)
  const closeOffer = useCallback(() => {
    setOfferOpen(false)
    if (linkedRef.current) { linkedRef.current = false; onChanged() }
  }, [onChanged])

  const keepSeparate = useCallback(async () => {
    if (unlinking) return
    setUnlinking(true); setMsg(null)
    try {
      const r = await fetch(api(orderId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unlink' }) })
      const d = await r.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (!r.ok || !d.ok) setMsg(d.error ?? 'Couldn’t keep this vehicle separate. Try again.')
      else onChanged()
    } catch { setMsg('Network error — try again.') }
    finally { setUnlinking(false) }
  }, [orderId, unlinking, onChanged])

  if (shared) {
    const pending = shared.pendingCount > 0
    const isPendingMember = shared.role === 'member' && shared.memberState === 'pending'
    return (
      <div className={`mt-4 rounded-xl border px-4 py-3 ${pending ? 'border-amber-900/60 bg-amber-950/30' : 'border-sky-900/60 bg-sky-950/30'}`}>
        <p className={`text-sm font-semibold ${pending ? 'text-amber-300' : 'text-sky-300'}`}>
          Shared invoice{shared.invoiceNumber ? ` #${shared.invoiceNumber}` : ''} · {shared.vehicles.length} vehicles
        </p>
        <ul className="mt-1.5 space-y-1">
          {shared.vehicles.map((v) => (
            <li key={v.orderId} className="flex items-center justify-between gap-2 text-sm">
              {v.orderId === orderId
                ? <span className="text-white truncate">{v.vehicle} <span className="text-gray-500 text-xs">(this Job)</span></span>
                : <a href={`/orders/${v.orderId}`} className="text-blue-300 truncate underline-offset-2 hover:underline">{v.vehicle}</a>}
              <span className={`shrink-0 text-xs ${v.state === 'pending' ? 'text-amber-300' : 'text-gray-400'}`}>
                {v.state === 'pending' ? 'Not on invoice yet' : v.state === 'anchor' ? 'Invoice owner' : v.appliedTotalCents != null ? `On invoice · ${money(v.appliedTotalCents)}` : 'On invoice'}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-gray-400 text-xs mt-2">
          {pending
            ? `${shared.pendingCount === 1 ? 'A linked vehicle’s charges aren’t' : `${shared.pendingCount} linked vehicles’ charges aren’t`} on the invoice yet. Sending and payments wait until the invoice is reviewed and updated.`
            : shared.invoice.sent ? `Invoice emailed${shared.invoice.sentAt ? ` ${when(shared.invoice.sentAt)}` : ''}.` : 'Invoice not emailed yet.'}
          {shared.role === 'member' && ' This vehicle is billed on that invoice — it never gets a separate one.'}
        </p>
        {enabled && pending && (
          <button onClick={() => setReviewOpen(true)} disabled={disabled}
            className="mt-3 w-full text-white font-semibold text-base py-3 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
            Review &amp; update invoice
          </button>
        )}
        {isPendingMember && (
          <button onClick={keepSeparate} disabled={disabled || unlinking}
            className="mt-2 w-full font-semibold text-sm py-2.5 rounded-2xl border border-gray-700 text-gray-300 active:opacity-80 disabled:opacity-50">
            {unlinking ? 'Removing…' : 'Keep separate instead'}
          </button>
        )}
        {msg && <p className="text-amber-400 text-xs mt-2">{msg}</p>}
        {reviewOpen && <SharedInvoiceReviewSheet orderId={orderId} onClose={() => setReviewOpen(false)} onUpdated={onChanged} />}
      </div>
    )
  }

  if (!enabled || !canOffer) return null
  return (
    <div className="mt-3">
      <button onClick={() => { setOfferOpen(true); disc.retry() }} disabled={disabled || (offerOpen && disc.status === 'loading')}
        className="w-full font-semibold text-sm py-2.5 rounded-2xl border border-gray-700 text-gray-300 active:opacity-80 disabled:opacity-50">
        Add to this customer’s open invoice…
      </button>
      {offerOpen && disc.status === 'loading' && (
        <p className="text-gray-500 text-xs mt-2" role="status">Checking QuickBooks for open invoices…</p>
      )}
      {offerOpen && disc.status === 'error' && (
        <p className="text-amber-400 text-xs mt-2" role="alert">
          {disc.result?.error ?? 'Couldn’t check QuickBooks for open invoices.'}{' '}
          <button onClick={() => void disc.retry()} className="underline font-semibold">Retry</button>
        </p>
      )}
      {offerOpen && disc.status === 'done' && disc.result && (
        <SharedInvoiceOfferSheet orderId={orderId} discovery={disc.result} onClose={closeOffer} onLinked={() => { linkedRef.current = true }} />
      )}
    </div>
  )
}
