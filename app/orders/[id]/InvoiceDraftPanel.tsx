'use client'

/**
 * Shared Invoice Draft UI (extracted from OrderDetail so the Job page's sheet, the Completion Summary,
 * and the unified Estimate & Invoice page all render the SAME component over the SAME endpoints —
 * no parallel pricing or QuickBooks logic).
 */
import { useState, useCallback, useEffect, useRef } from 'react'

export interface InvoiceDraftData {
  priced: boolean; isDealer: boolean
  customer: string | null; vehicle: string; services: string[]
  workPriceCents: number
  shopSupplies: { cents: number; waived: boolean }
  paymentCharge: { cents: number; waived: boolean; label: string }
  tax: { cents: number; applicable: boolean; needsReview: boolean; exempt: boolean }
  totalCents: number; role: string
  itemized: boolean
  serviceBreakdown: { title: string; cents: number }[]
  pricingIncomplete: boolean
  referenceCents: number | null
  qb: { status: string; linked: boolean; invoiceNumber: string | null; error: string | null; syncNeeded: boolean; needsReview: boolean; sent: boolean; resendRecommended: boolean; sentAt: string | null }
}
export interface SendPreview { ok: boolean; block?: string; recipient?: string | null; invoiceNumber?: string | null; draftTotalCents?: number; qbTotalCents?: number; error?: string }
/** A colliding QB customer offered to the manager when email/name resolution is ambiguous. */
export interface QbCandidate { id: string; displayName: string | null; email: string | null; phone: string | null; active: boolean | null }
export const money = (c: number) => `$${(c / 100).toFixed(2)}`
export const SEND_BLOCK_MSG: Record<string, string> = {
  no_invoice: 'No QuickBooks invoice is linked. Create it first.',
  total_mismatch: 'QuickBooks invoice is out of sync with Pitt Stop. Sync it first.',
  sync_needed: 'Sync the QuickBooks invoice before sending.',
  needs_review: 'This invoice needs review before it can be sent.',
  identity_mismatch: 'This invoice could not be verified in QuickBooks — needs review.',
  customer_mismatch: 'The customer no longer matches this invoice — review before sending.',
  invoice_missing: 'This invoice no longer exists in QuickBooks — needs review.',
  email_required: 'A customer email address is required before sending.',
  email_conflict: 'The Pitt Stop email and the QuickBooks invoice email differ — review before sending.',
  qb_read_failed: 'Could not read the linked QuickBooks invoice. Try again.',
  sending: 'A send is already in progress.',
  send_failed: 'Could not send the invoice. Try again.',
  not_priced: 'Add a Work Price first.',
  dealer: 'Dealer invoices are handled by Dealer Check-In.',
}
export const SYNC_BLOCK_MSG: Record<string, string> = {
  customer_mismatch: 'The customer no longer matches this invoice — review before syncing.',
  identity_mismatch: 'This invoice could not be verified in QuickBooks — needs review.',
  invoice_missing: 'This invoice no longer exists in QuickBooks — needs review.',
  not_priced: 'Add pricing before syncing.',
  total_mismatch: 'Totals did not match after syncing — please try again.',
  syncing: 'A sync is already in progress.',
  dealer: 'Dealer invoices are handled by Dealer Check-In.',
  sync_failed: 'Could not sync the QuickBooks invoice.',
}

function ChargeRow({ label, cents, waived, canEdit, busy, onToggle }: {
  label: string; cents: number; waived: boolean; canEdit: boolean; busy: boolean; onToggle: (removed: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-800">
      <div className="min-w-0">
        <p className={`text-sm ${waived ? 'text-gray-600 line-through' : 'text-gray-300'}`}>{label}</p>
        {waived && <p className="text-gray-600 text-xs">Removed — not billed</p>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`text-sm tabular-nums ${waived ? 'text-gray-600 line-through' : 'text-gray-200'}`}>{money(cents)}</span>
        {canEdit && (
          <button onClick={() => onToggle(!waived)} disabled={busy}
            className={`text-xs font-semibold px-2.5 py-1 rounded-lg active:opacity-70 disabled:opacity-40 ${waived ? 'text-blue-400 border border-blue-900/60' : 'text-gray-400 border border-gray-700'}`}>
            {waived ? 'Restore' : 'Remove'}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Invoice Draft — the authoritative billing review (work, shop supplies, payment charge, tax, total)
 * from GET /invoice, plus the explicit, role-gated QuickBooks Create / Sync / Send actions. Nothing
 * here runs on open. `embedded` = shown inside the unified Estimate & Invoice page, under the
 * estimate editor: the who/what header and the "fix it in the Estimate" links are dropped because
 * the estimate is right above.
 */
export function InvoiceDraftPanel({ orderId, embedded = false }: { orderId: string; embedded?: boolean }) {
  const [draft, setDraft] = useState<InvoiceDraftData | null>(null)
  const [qbEnabled, setQbEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [taxReasonOpen, setTaxReasonOpen] = useState(false)
  const [taxReason, setTaxReason] = useState('')
  const createReqId = useRef<string>(`${orderId}-${Date.now()}`)
  const [sendEnabled, setSendEnabled] = useState(false)
  const [sendPreview, setSendPreview] = useState<SendPreview | null>(null)   // confirmation dialog
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [resendMode, setResendMode] = useState(false)   // the pending confirm is a deliberate Resend
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [confirmSentSync, setConfirmSentSync] = useState(false)   // two-tap confirm for a sent invoice
  // Ambiguous QB customer: the colliding candidates to choose from (null = picker closed).
  const [custCandidates, setCustCandidates] = useState<QbCandidate[] | null>(null)
  const [savingCust, setSavingCust] = useState(false)

  useEffect(() => {
    let ok = true
    fetch(`/api/workflow/orders/${orderId}/invoice`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (ok) { if (d.draft) { setDraft(d.draft); setQbEnabled(!!d.qbEnabled); setSendEnabled(!!d.qbSendEnabled); setSyncEnabled(!!d.qbSyncEnabled) } else setErr(d.error ?? 'Could not load the invoice draft.') } })
      .catch(() => { if (ok) setErr('Could not load the invoice draft.') })
      .finally(() => { if (ok) setLoading(false) })
    return () => { ok = false }
  }, [orderId])

  const refetch = useCallback(async () => {
    const r = await fetch(`/api/workflow/orders/${orderId}/invoice`, { cache: 'no-store' })
    const d = await r.json()
    if (d.draft) { setDraft(d.draft); setQbEnabled(!!d.qbEnabled); setSendEnabled(!!d.qbSendEnabled); setSyncEnabled(!!d.qbSyncEnabled) }
  }, [orderId])

  // Sync (UPDATE) the linked invoice from the current draft. Two-tap confirm for a sent invoice
  // (first tap → confirm_required → inline warning; second tap → confirmSent). Never resends.
  const syncQb = useCallback(async () => {
    if (syncing) return
    setSyncing(true); setSyncMsg(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/sync-qb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, confirmSent: confirmSentSync }),
      })
      const d = await res.json().catch(() => ({}))
      if (d.block === 'confirm_required') { setConfirmSentSync(true); setSyncMsg('This invoice was already sent — tap Sync again to update it (it will not be resent).') }
      else if (!res.ok || !d.ok) { setSyncMsg(d.error ?? SYNC_BLOCK_MSG[d.block ?? ''] ?? 'Could not sync the invoice.'); setConfirmSentSync(false) }
      else { setConfirmSentSync(false); setSyncMsg(d.noop ? 'Already up to date' : 'QuickBooks invoice updated') }
      await refetch()
    } catch { setSyncMsg('Network error — please try again.') }
    finally { setSyncing(false) }
  }, [orderId, syncing, confirmSentSync, refetch])

  // Send / Resend (manager + admin): preview (read-only) → confirmation dialog → confirmed
  // send. Never creates; resend=true only on a deliberate Resend of an already-sent invoice.
  const openSend = useCallback(async (resend = false) => {
    setErr(null); setSending(true); setResendMode(resend)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/send-qb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: false }),
      })
      const d = await res.json()
      const p: SendPreview = d.preview ?? { ok: false, error: d.error }
      if (!p.ok) { setErr(p.error ?? SEND_BLOCK_MSG[p.block ?? ''] ?? 'Cannot send this invoice.'); await refetch(); return }
      setSendPreview(p)   // opens confirmation
    } catch { setErr('Network error — please try again.') }
    finally { setSending(false) }
  }, [orderId, refetch])

  const confirmSend = useCallback(async () => {
    setSending(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/send-qb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, resend: resendMode }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? SEND_BLOCK_MSG[d.block ?? ''] ?? 'Send failed.'); return }
      setSentTo(d.recipient ?? sendPreview?.recipient ?? null)
      setSendPreview(null)
      await refetch()
    } catch { setErr('Network error — please try again.') }
    finally { setSending(false) }
  }, [orderId, sendPreview, resendMode, refetch])

  // Break a flat Work Total into editable per-service prices (reuses the Estimate engine's
  // proportional allocation; preserves the Work Total exactly). Fine-tune on the Estimate screen.
  const itemize = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/estimate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'itemize' }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d.error ?? 'Could not set service prices.'); return }
      await refetch()
    } catch { setErr('Network error — please try again.') }
    finally { setBusy(false) }
  }, [orderId, refetch])

  // Create the QuickBooks invoice (idempotent server-side; a stable requestId dedupes taps).
  const createQb = useCallback(async () => {
    if (creating) return
    setCreating(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/create-qb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: createReqId.current }),
      })
      const data = await res.json()
      // Ambiguous QB customer → open the picker (manager chooses the right one) instead of a dead end.
      if (data.status === 'ambiguous' && Array.isArray(data.candidates) && data.candidates.length) {
        setCustCandidates(data.candidates); setErr(data.error ?? null)
      } else if (!res.ok || !data.ok) setErr(data.error ?? 'Could not create the QuickBooks invoice.')
      await refetch()
    } catch { setErr('Network error — please try again.') }
    finally { setCreating(false) }
  }, [orderId, creating, refetch])

  // Persist the manager's chosen QB customer (directory cache), then re-run Create so the invoice
  // is created against that exact CustomerRef. Future invoices reuse the mapping automatically.
  const chooseCustomer = useCallback(async (qbCustomerId: string) => {
    if (savingCust) return
    setSavingCust(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/customer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qbCustomerId }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setErr(data.error ?? 'Could not save the QuickBooks customer.'); return }
      setCustCandidates(null)
      await createQb()
    } catch { setErr('Network error — please try again.') }
    finally { setSavingCust(false) }
  }, [orderId, savingCust, createQb])

  const override = useCallback(async (field: 'shop_supplies' | 'payment' | 'tax_exempt', removed: boolean, reason?: string) => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/override`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, removed, reason }),
      })
      const data = await res.json()
      if (!res.ok) { setErr(data.error ?? 'That change was not allowed.'); return }
      setDraft(data.draft)
      setTaxReasonOpen(false); setTaxReason('')
    } catch { setErr('Network error — please try again.') }
    finally { setBusy(false) }
  }, [orderId])

  const isAdmin = draft?.role === 'admin'

  return (
      <div>
        {loading && <p className="text-gray-500 text-sm py-8 text-center">Loading…</p>}

        {!loading && draft && (
          <>
            {/* Header: who / what */}
            {!embedded && <div className="mb-4">
              {draft.customer && <p className="text-white text-base font-semibold">{draft.customer}</p>}
              <p className="text-gray-400 text-sm">{draft.vehicle}</p>
              {draft.services.length > 0 && <p className="text-gray-500 text-xs mt-1">{draft.services.join(' · ')}</p>}
            </div>}

            {draft.isDealer ? (
              <p className="text-gray-400 text-sm bg-gray-800/60 rounded-xl px-4 py-4">
                This is a Dealer Job — billed through Dealer Check-In / QuickBooks. No retail Shop Supplies, Payment Charge, or sales tax apply.
              </p>
            ) : !draft.priced ? (
              <p className="text-gray-400 text-sm bg-gray-800/60 rounded-xl px-4 py-4">
                No Work Price yet. Set a Work Price in Quick Entry (manager pricing) before an invoice draft can be prepared.
              </p>
            ) : (
              <>
                {/* Incomplete itemized pricing → show the agreed amount as a reference and flag the
                    total below as partial. Creating an invoice is blocked until pricing is finished. */}
                {draft.pricingIncomplete && (
                  <div className="rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3 mb-1">
                    <p className="text-amber-300 text-sm font-semibold">Pricing incomplete</p>
                    {draft.referenceCents != null && (
                      <div className="mt-1 flex items-center justify-between text-sm">
                        <span className="text-amber-200/80">Agreed amount (reference)</span>
                        <span className="text-amber-100 font-bold tabular-nums">{money(draft.referenceCents)}</span>
                      </div>
                    )}
                    <p className="text-amber-200/60 text-xs mt-2">Some services still need a price, so the total below is partial — not the agreed amount. Finish pricing every service in the Estimate before creating the invoice.</p>
                  </div>
                )}
                {/* Complete, but the itemized total differs from the agreed amount and hasn't been
                    accepted yet → show the difference; the manager must accept it in the Estimate. */}
                {!draft.pricingIncomplete && draft.referenceCents != null && (
                  <div className="rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3 mb-1">
                    <p className="text-amber-300 text-sm font-semibold">Itemized work total differs from the agreed amount</p>
                    {/* Both are pre-tax WORK prices (shop supplies / card / tax are added separately). */}
                    <div className="mt-1 flex items-center justify-between text-sm">
                      <span className="text-amber-200/80">Agreed work price</span><span className="text-amber-100 tabular-nums">{money(draft.referenceCents)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-amber-200/80">Itemized work price</span><span className="text-amber-100 font-bold tabular-nums">{money(draft.workPriceCents)}</span>
                    </div>
                    <p className="text-amber-200/60 text-xs mt-2">Accept the itemized total in the Estimate (or adjust a service price) before creating the invoice.</p>
                  </div>
                )}
                {/* Work — per-service breakdown (itemized) or a single Work total (flat) */}
                {draft.serviceBreakdown.length > 0 ? (
                  <>
                    {draft.serviceBreakdown.map((s, i) => (
                      <div key={i} className="flex items-center justify-between py-2 border-b border-gray-800">
                        <p className="text-sm text-gray-300 truncate pr-3">{s.title}</p>
                        <span className="text-sm tabular-nums text-gray-200">{money(s.cents)}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between py-1.5">
                      <p className="text-xs text-gray-500">Work total</p>
                      <span className="text-xs tabular-nums text-gray-400">{money(draft.workPriceCents)}</span>
                    </div>
                  </>
                ) : (
                  <div className="py-2.5 border-b border-gray-800">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-gray-300">Work</p>
                      <span className="text-sm tabular-nums text-gray-200">{money(draft.workPriceCents)}</span>
                    </div>
                    {draft.qb.status !== 'created' && !embedded && (
                      <button onClick={itemize} disabled={busy || creating}
                        className="mt-1.5 text-blue-400 text-xs font-semibold active:opacity-70 disabled:opacity-40">Set individual service prices →</button>
                    )}
                  </div>
                )}

                {/* Shop supplies — manager + admin */}
                <ChargeRow label="Shop supplies" cents={draft.shopSupplies.cents} waived={draft.shopSupplies.waived}
                  canEdit busy={busy} onToggle={(removed) => override('shop_supplies', removed)} />

                {/* Payment charge — manager + admin */}
                <ChargeRow label={draft.paymentCharge.label} cents={draft.paymentCharge.cents} waived={draft.paymentCharge.waived}
                  canEdit busy={busy} onToggle={(removed) => override('payment', removed)} />

                {/* Tax — only when it applies; exemption is admin-only + reason */}
                {(draft.tax.applicable || draft.tax.exempt) && (
                  <div className="py-2.5 border-b border-gray-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className={`text-sm ${draft.tax.exempt ? 'text-gray-600 line-through' : 'text-gray-300'}`}>
                          Sales tax{draft.tax.needsReview && !draft.tax.exempt ? ' (pending review)' : ''}
                        </p>
                        {draft.tax.exempt && <p className="text-gray-600 text-xs">Tax exempt</p>}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-sm tabular-nums ${draft.tax.exempt ? 'text-gray-600 line-through' : 'text-gray-200'}`}>{money(draft.tax.cents)}</span>
                        {isAdmin && (draft.tax.exempt
                          ? <button onClick={() => override('tax_exempt', false)} disabled={busy}
                              className="text-xs font-semibold px-2.5 py-1 rounded-lg text-blue-400 border border-blue-900/60 active:opacity-70 disabled:opacity-40">Restore</button>
                          : <button onClick={() => setTaxReasonOpen((v) => !v)} disabled={busy}
                              className="text-xs font-semibold px-2.5 py-1 rounded-lg text-gray-400 border border-gray-700 active:opacity-70 disabled:opacity-40">Exempt</button>
                        )}
                      </div>
                    </div>
                    {isAdmin && taxReasonOpen && !draft.tax.exempt && (
                      <div className="mt-3">
                        <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Reason for exemption (required)</p>
                        <textarea value={taxReason} onChange={(e) => setTaxReason(e.target.value)} rows={2}
                          placeholder="e.g. resale certificate on file / government entity"
                          className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-sm" />
                        <button onClick={() => override('tax_exempt', true, taxReason)} disabled={busy || !taxReason.trim()}
                          className="mt-2 w-full h-11 rounded-xl bg-amber-600 active:bg-amber-700 text-white text-sm font-bold disabled:opacity-40">
                          {busy ? 'Saving…' : 'Confirm tax exempt'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Total */}
                <div className="flex items-center justify-between pt-4">
                  <p className="text-white font-bold text-base">Total</p>
                  <span className="text-white font-bold text-lg tabular-nums">{money(draft.totalCents)}</span>
                </div>

                {/* QuickBooks — INVOICE-ID-FIRST. Linked → Sync/Send/Resend (never Create). */}
                {draft.qb.linked ? (() => {
                  const q = draft.qb
                  const stale = q.needsReview || q.syncNeeded || q.status === 'error'
                  const current = !q.syncNeeded && !q.needsReview && q.status !== 'error'  // Send/Resend allowed
                  return (
                  <div className={`mt-4 rounded-xl border px-4 py-3 ${stale || q.resendRecommended ? 'border-amber-900/60 bg-amber-950/30' : 'border-green-900/60 bg-green-950/40'}`}>
                    <p className={`text-sm font-semibold ${stale || q.resendRecommended ? 'text-amber-300' : 'text-green-300'}`}>QuickBooks Invoice{q.invoiceNumber ? ` #${q.invoiceNumber}` : ''}</p>
                    <p className="text-gray-400 text-xs mt-0.5">
                      {q.needsReview ? 'Needs review'
                        : q.status === 'error' ? 'Sync failed'
                        : q.syncNeeded ? (q.sent ? 'Sent · Sync needed' : 'Sync needed')
                        : q.resendRecommended ? 'Updated after last email · Resend recommended'
                        : q.sent ? `Sent${sentTo ? ` to ${sentTo}` : ''}${q.sentAt ? ` · ${new Date(q.sentAt).toLocaleString()}` : ''}`
                        : 'Current'}
                    </p>
                    {q.needsReview && q.error && <p className="text-amber-400/80 text-xs mt-1">{q.error}</p>}

                    {/* Sync (manager + admin) — offered when stale/failed, never on needs-review. */}
                    {(q.syncNeeded || q.status === 'error') && !q.needsReview && syncEnabled && (
                      <button onClick={syncQb} disabled={syncing || busy}
                        className="mt-3 w-full text-white font-semibold text-base py-3 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                        {syncing ? 'Syncing…' : q.status === 'error' ? 'Retry Sync' : 'Sync QuickBooks'}
                      </button>
                    )}
                    {syncMsg && <p className="text-amber-400 text-xs mt-2">{syncMsg}</p>}

                    {/* Send (manager + admin) — current + unsent only. */}
                    {current && !q.sent && sendEnabled && (
                      <button onClick={() => openSend(false)} disabled={sending}
                        className="mt-3 w-full text-white font-semibold text-base py-3 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                        {sending ? 'Checking…' : 'Send Invoice'}
                      </button>
                    )}
                    {/* Resend (manager + admin) — explicit, once already sent + current. */}
                    {current && q.sent && sendEnabled && (
                      <button onClick={() => openSend(true)} disabled={sending}
                        className={`mt-3 w-full font-semibold text-sm py-2.5 rounded-2xl active:opacity-80 disabled:opacity-50 ${q.resendRecommended ? 'bg-amber-600 text-white' : 'border border-gray-700 text-gray-300'}`}>
                        {sending ? 'Checking…' : 'Resend Invoice'}
                      </button>
                    )}
                  </div>
                  )
                })() : (draft.pricingIncomplete || draft.referenceCents != null) ? (embedded ? (
                  <p className="mt-4 rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
                    {draft.pricingIncomplete ? 'Finish pricing every line above before creating the invoice.' : 'Resolve the total above before creating the invoice.'}
                  </p>
                ) : (
                  <a href={`/orders/${orderId}/estimate`}
                    className="mt-4 block w-full text-center text-white font-semibold text-base py-3.5 rounded-2xl bg-amber-600 active:opacity-80">
                    {draft.pricingIncomplete ? 'Finish pricing in the Estimate →' : 'Resolve the total in the Estimate →'}
                  </a>
                )) : qbEnabled ? (
                  <div className="mt-4">
                    <button onClick={createQb} disabled={creating || busy}
                      className="w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                      {creating ? 'Creating…' : draft.qb.status === 'error' ? 'Retry — Create QuickBooks Invoice' : 'Create QuickBooks Invoice'}
                    </button>
                    {draft.qb.status === 'error' && draft.qb.error && <p className="text-amber-400 text-xs mt-2">Last attempt: {draft.qb.error}</p>}
                  </div>
                ) : (
                  <p className="text-gray-600 text-xs mt-4">QuickBooks invoicing is turned off.</p>
                )}

                {!draft.qb.linked && (
                  <p className="text-gray-600 text-xs mt-4">Draft only — no invoice has been created or sent. Every change is recorded.</p>
                )}
              </>
            )}
          </>
        )}

        {/* Pre-send confirmation (customer-facing) */}
        {sendPreview?.ok && (
          <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !sending && setSendPreview(null)}>
            <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-white font-bold text-lg mb-3">{resendMode ? 'Resend' : 'Send'} QuickBooks Invoice{sendPreview.invoiceNumber ? ` #${sendPreview.invoiceNumber}` : ''}</h3>
              {draft?.customer && <><p className="text-gray-400 text-sm">Customer</p><p className="text-white text-base font-semibold mb-2">{draft.customer}</p></>}
              <p className="text-gray-400 text-sm">To</p>
              <p className="text-white text-base font-semibold mb-3">{sendPreview.recipient}</p>
              <p className="text-gray-400 text-sm">Total</p>
              <p className="text-white text-2xl font-bold tabular-nums mb-5">{money(sendPreview.draftTotalCents ?? 0)}</p>
              <div className="flex gap-3">
                <button onClick={() => setSendPreview(null)} disabled={sending} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
                <button onClick={confirmSend} disabled={sending} className="flex-1 py-3.5 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">{sending ? 'Sending…' : (resendMode ? 'Resend Invoice' : 'Send Invoice')}</button>
              </div>
            </div>
          </div>
        )}

        {/* Ambiguous QB customer — manager chooses the right existing customer; the choice is
            saved so future invoices for this person skip the email ambiguity. */}
        {custCandidates && (
          <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !savingCust && setCustCandidates(null)}>
            <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-white font-bold text-lg mb-1">Choose the QuickBooks customer</h3>
              <p className="text-gray-400 text-sm mb-1">
                {draft?.customer ? <>“{draft.customer}” matches </> : 'This customer matches '}
                more than one QuickBooks customer, so we won’t guess. Pick the right one — we’ll use it for this invoice and remember it next time.
              </p>
              <p className="text-amber-300/80 text-xs mb-4">Not sure? Check the email, phone, and past invoices in QuickBooks before choosing.</p>
              <div className="space-y-2.5">
                {custCandidates.map((c) => (
                  <button key={c.id} onClick={() => chooseCustomer(c.id)} disabled={savingCust}
                    className="w-full text-left rounded-2xl border border-gray-700 bg-gray-800/40 px-4 py-3 active:opacity-70 disabled:opacity-40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-white font-semibold text-base">{c.displayName || '(no name)'}</span>
                      <span className="text-gray-500 text-xs tabular-nums">QB #{c.id}{c.active === false ? ' · inactive' : ''}</span>
                    </div>
                    {c.email && <div className="text-gray-400 text-sm mt-0.5">{c.email}</div>}
                    {c.phone && <div className="text-gray-400 text-sm">{c.phone}</div>}
                  </button>
                ))}
              </div>
              <button onClick={() => setCustCandidates(null)} disabled={savingCust}
                className="mt-5 w-full py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">
                {savingCust ? 'Saving…' : 'Cancel'}
              </button>
            </div>
          </div>
        )}

        {err && <p className="text-red-400 text-sm mt-4">{err}</p>}
      </div>
  )
}

/** The Invoice Draft as a bottom sheet (Completion Summary, and the Job page when the estimate layer is off). */
export function InvoiceDraftModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-xl">Invoice Draft</h2>
          <button onClick={onClose} className="text-gray-500 text-sm">Close</button>
        </div>
        <InvoiceDraftPanel orderId={orderId} />
      </div>
    </div>
  )
}
