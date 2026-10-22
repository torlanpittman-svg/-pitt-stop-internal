'use client'

/**
 * Shared Invoice Draft UI (extracted from OrderDetail so the Job page's sheet, the Completion Summary,
 * and the unified Estimate & Invoice page all render the SAME component over the SAME endpoints —
 * no parallel pricing or QuickBooks logic).
 */
import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { createDraftSequencer, invoiceActionsLocked, interpretDraftResponse, draftActionReady } from './invoice-draft-sync'
import { InvoicePaymentSection } from './InvoicePaymentSection'
import { paymentLocksInvoice } from '@/apps/quickbooks/retail-payment'
import type { InvoicePaymentState } from '@/apps/workflow/invoice-draft'
import type { SharedInvoiceState } from '@/apps/quickbooks/shared-invoice'
import { SharedInvoiceSection } from '@/app/components/SharedInvoice'
import type { CombineState } from '@/apps/quickbooks/invoice-consolidation'
import { CombineInvoicesSection } from '@/app/components/CombineInvoices'

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
  qb: { status: string; linked: boolean; invoiceNumber: string | null; error: string | null; syncNeeded: boolean; needsReview: boolean; sent: boolean; resendRecommended: boolean; sentAt: string | null; payment: InvoicePaymentState }
  /** One QuickBooks invoice billing several of this customer's vehicles (either side), or null. */
  shared?: SharedInvoiceState | null
  /** Combine unpaid invoices touching this Job: unfinished (blocks billing on both invoices) or the last finished one. */
  combine?: CombineState | null
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
  shared_pending: 'A linked vehicle’s charges aren’t on this invoice yet — review and update the shared invoice first.',
  shared_member_unready: 'A vehicle on this shared invoice isn’t ready to bill — review the shared invoice.',
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
  paid: 'A payment is recorded on this invoice — correct it in QuickBooks.',
  pricing: 'The service prices don’t match the agreed Work Price — reconcile them in the Estimate first.',
  stale: 'The invoice changed in QuickBooks — review it again.',
  lines_changed: 'The invoice’s lines were changed in QuickBooks — reconcile it there first.',
  member_unready: 'A linked vehicle isn’t ready to bill yet — finish its pricing first.',
  member_customer_mismatch: 'A linked vehicle no longer belongs to this invoice’s customer — keep it separate.',
}

function ChargeRow({ label, cents, waived, canEdit, busy, onToggle }: {
  label: string; cents: number; waived: boolean; canEdit: boolean; busy: boolean; onToggle: (removed: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-gray-800">
      <div className="min-w-0">
        <p className={`text-sm ${waived ? 'text-gray-500 line-through' : 'text-gray-300'}`}>{label}</p>
        {waived && <p className="text-gray-500 text-xs">Removed — not billed</p>}
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        {/* Small, subtle, translucent — beside the price, never louder than it. */}
        {canEdit && (
          <button type="button" onClick={() => onToggle(!waived)} disabled={busy} aria-label={`${waived ? 'Restore' : 'Remove'} ${label}`}
            className={`min-h-8 rounded-md border px-2 text-[11px] font-medium backdrop-blur-sm active:opacity-70 disabled:opacity-40 ${waived ? 'border-blue-400/25 bg-blue-400/10 text-blue-300 hover:bg-blue-400/15' : 'border-white/10 bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200'}`}>
            {waived ? 'Restore' : 'Remove'}
          </button>
        )}
        <span className={`text-sm tabular-nums ${waived ? 'text-gray-500' : 'text-gray-200'}`}>{waived ? '—' : money(cents)}</span>
      </div>
    </div>
  )
}

export type ChargeField = 'shop_supplies' | 'payment'

/**
 * The money summary shown ONCE under the item list: subtotal, the applicable charges (each with a
 * Remove/Restore), tax, total. Pure presentation over the authoritative draft — every number comes
 * from the server's fee engine (GET /invoice or the estimate summary); nothing is recalculated here.
 * A charge row appears when it applies (amount > 0) or was removed (so it can be restored).
 */
export function InvoiceTotals({ draft, subtotal, canEdit, busy, onToggle, tax, totalLabel = 'Total' }: {
  draft: Pick<InvoiceDraftData, 'workPriceCents' | 'shopSupplies' | 'paymentCharge' | 'tax' | 'totalCents'>
  /** Custom subtotal row (e.g. an editable flat Work Total); default = the draft's work price. */
  subtotal?: ReactNode
  canEdit: boolean; busy: boolean; onToggle: (field: ChargeField, removed: boolean) => void
  /** Custom tax row (Invoice Draft's admin exemption control); default = a plain line when tax applies. */
  tax?: ReactNode
  totalLabel?: string
}) {
  return (
    <div>
      {subtotal ?? (
        <div className="flex items-center justify-between py-2.5 border-b border-gray-800">
          <p className="text-sm text-gray-300">Subtotal</p>
          <span className="text-sm tabular-nums text-gray-200">{money(draft.workPriceCents)}</span>
        </div>
      )}
      {(draft.shopSupplies.cents > 0 || draft.shopSupplies.waived) && (
        <ChargeRow label="Shop supplies" cents={draft.shopSupplies.cents} waived={draft.shopSupplies.waived}
          canEdit={canEdit} busy={busy} onToggle={(removed) => onToggle('shop_supplies', removed)} />
      )}
      {(draft.paymentCharge.cents > 0 || draft.paymentCharge.waived) && (
        <ChargeRow label={draft.paymentCharge.label} cents={draft.paymentCharge.cents} waived={draft.paymentCharge.waived}
          canEdit={canEdit} busy={busy} onToggle={(removed) => onToggle('payment', removed)} />
      )}
      {tax ?? ((draft.tax.applicable || draft.tax.cents > 0) && (
        <div className="flex items-center justify-between py-2.5 border-b border-gray-800">
          <p className="text-sm text-gray-300">Sales tax{draft.tax.needsReview ? ' (pending review)' : ''}</p>
          <span className="text-sm tabular-nums text-gray-200">{money(draft.tax.cents)}</span>
        </div>
      ))}
      <div className="flex items-center justify-between pt-4">
        <p className="text-white font-bold text-base">{totalLabel}</p>
        <span className="text-white font-bold text-lg tabular-nums">{money(draft.totalCents)}</span>
      </div>
    </div>
  )
}

/** "Invoice Draft" until a QuickBooks invoice exists; then its number and true state (never implies a send). */
export function invoiceHeading(qb: (Omit<InvoiceDraftData['qb'], 'payment'> & { payment?: Pick<InvoicePaymentState, 'status'> & Partial<Pick<InvoicePaymentState, 'balanceState'>> }) | null | undefined): { title: string; status: string | null } {
  if (!qb?.linked) return { title: 'Invoice Draft', status: null }
  const title = qb.invoiceNumber ? `Invoice #${qb.invoiceNumber}` : 'Invoice'
  // Paid only once QuickBooks confirmed a zero balance (payment.status='paid'); partial = money applied, balance open.
  const status = qb.payment?.status === 'paid' ? 'Paid'
    : qb.payment?.balanceState === 'partial' ? 'Partially paid'
    : qb.needsReview ? 'Needs review'
    : qb.status === 'error' ? 'Sync failed'
    : qb.syncNeeded ? (qb.sent ? 'Sent · sync needed' : 'Created in QuickBooks · sync needed')
    : qb.sent ? 'Sent' : 'Created in QuickBooks · not sent'
  return { title, status }
}

/**
 * Invoice Draft — the authoritative billing review (work, shop supplies, payment charge, tax, total)
 * from GET /invoice, plus the explicit, role-gated QuickBooks Create / Sync / Send actions. Nothing
 * here runs on open. `embedded` = shown inside the unified Estimate & Invoice page, under the
 * estimate editor: the who/what header and the "fix it in the Estimate" links are dropped because
 * the estimate is right above.
 */
export function InvoiceDraftPanel({ orderId, embedded = false, mode = 'full', subtotal, refreshKey, onDraft, editorBusy = false, onBusyChange }: {
  orderId: string; embedded?: boolean
  /** 'totals' = under the combined Invoice item list: no header, no per-service breakdown and no pricing
   *  warnings (the list above already shows them) — just subtotal (from `subtotal`), charges, tax, total
   *  and the QuickBooks actions. */
  mode?: 'full' | 'totals'
  subtotal?: ReactNode
  /** Changes after each confirmed item edit → re-read the authoritative draft in place (no remount). */
  refreshKey?: string
  onDraft?: (draft: InvoiceDraftData) => void
  /** The item editor above is mid-save — the invoice actions must be inert so they can't act on a draft
   *  that is about to change. */
  editorBusy?: boolean
  /** Report whether an invoice action (fee override / create / sync / send) is in flight, so the page can
   *  disable item editing while it runs (mirrors EstimateActions). */
  onBusyChange?: (busy: boolean) => void
}) {
  const totalsOnly = mode === 'totals'
  const onDraftRef = useRef(onDraft)
  useEffect(() => { onDraftRef.current = onDraft }, [onDraft])
  // Only the most recently started read may write `draft`, so an older refresh can't clobber a newer
  // fee override's draft when responses resolve out of order.
  const seq = useRef(createDraftSequencer()).current
  const didInit = useRef(false)
  const [draft, setDraft] = useState<InvoiceDraftData | null>(null)
  const [qbEnabled, setQbEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
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
  const [paymentEnabled, setPaymentEnabled] = useState(false)
  const [sharedEnabled, setSharedEnabled] = useState(false)
  const [combineEnabled, setCombineEnabled] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [confirmSentSync, setConfirmSentSync] = useState(false)   // two-tap confirm for a sent invoice
  // Ambiguous QB customer: the colliding candidates to choose from (null = picker closed).
  const [custCandidates, setCustCandidates] = useState<QbCandidate[] | null>(null)
  const [savingCust, setSavingCust] = useState(false)

  const aliveRef = useRef(true)
  useEffect(() => {
    // React Strict Mode replays setup/cleanup in development; each setup must reactivate reads.
    aliveRef.current = true
    return () => { aliveRef.current = false; seq.begin() }
  }, [seq])

  // Read the authoritative draft. 'refresh' = the items changed underneath (re-read in place): show
  // "Updating totals…", drop any open send/customer confirmation (its total/recipient is now stale), and
  // FAIL CLOSED on ANY failure — a non-2xx, a missing/malformed draft, or a network error clears the
  // draft so the old total is never presented as current/actionable; a Retry re-reads it. Only the latest
  // read may apply (the sequencer), and the finally always settles the current read, so a superseded or
  // in-flight request can't strand the panel in a loading/refreshing state across order/key changes.
  const loadDraft = useCallback(async (mode: 'initial' | 'refresh') => {
    const token = seq.begin()
    if (mode === 'refresh') { setRefreshing(true); setSendPreview(null); setResendMode(false); setConfirmSentSync(false); setSyncMsg(null); setCustCandidates(null) }
    try {
      const r = await fetch(`/api/workflow/orders/${orderId}/invoice`, { cache: 'no-store' })
      const d = await r.json().catch(() => null) as { draft?: InvoiceDraftData; error?: string; qbEnabled?: boolean; qbSendEnabled?: boolean; qbSyncEnabled?: boolean; qbPaymentEnabled?: boolean; qbSharedEnabled?: boolean; qbCombineEnabled?: boolean } | null
      if (!aliveRef.current || !seq.isCurrent(token)) return
      const res = interpretDraftResponse(r.ok, d)
      if (res.draft) { setDraft(res.draft); setErr(null); setQbEnabled(!!d?.qbEnabled); setSendEnabled(!!d?.qbSendEnabled); setSyncEnabled(!!d?.qbSyncEnabled); setPaymentEnabled(!!d?.qbPaymentEnabled); setSharedEnabled(!!d?.qbSharedEnabled); setCombineEnabled(!!d?.qbCombineEnabled) }
      else { setDraft(null); setErr(res.error) }
    } catch {
      if (aliveRef.current && seq.isCurrent(token)) { setDraft(null); setErr('Could not load the invoice totals. Try again.') }
    } finally {
      if (aliveRef.current && seq.isCurrent(token)) { setLoading(false); setRefreshing(false) }
    }
  }, [orderId, seq])

  useEffect(() => {
    const first = !didInit.current
    didInit.current = true
    void loadDraft(first ? 'initial' : 'refresh')
  }, [orderId, refreshKey, loadDraft])
  useEffect(() => { if (draft) onDraftRef.current?.(draft) }, [draft])
  // Let the page disable item editing while an invoice action is in flight (symmetric with editorBusy).
  useEffect(() => { onBusyChange?.(busy || creating || sending || syncing || savingCust) }, [busy, creating, sending, syncing, savingCust, onBusyChange])

  const refetch = useCallback(async () => {
    const token = seq.begin()
    const r = await fetch(`/api/workflow/orders/${orderId}/invoice`, { cache: 'no-store' })
    const d = await r.json()
    if (!seq.isCurrent(token)) return
    if (d.draft) { setDraft(d.draft); setQbEnabled(!!d.qbEnabled); setSendEnabled(!!d.qbSendEnabled); setSyncEnabled(!!d.qbSyncEnabled); setPaymentEnabled(!!d.qbPaymentEnabled); setSharedEnabled(!!d.qbSharedEnabled); setCombineEnabled(!!d.qbCombineEnabled) }
  }, [orderId, seq])

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
    const token = seq.begin()
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/override`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, removed, reason }),
      })
      const data = await res.json()
      if (!seq.isCurrent(token)) return   // a newer read/override won — don't apply this stale draft
      if (!res.ok) { setErr(data.error ?? 'That change was not allowed.'); return }
      setDraft(data.draft)
      setTaxReasonOpen(false); setTaxReason('')
    } catch { if (seq.isCurrent(token)) setErr('Network error — please try again.') }
    finally { setBusy(false) }
  }, [orderId, seq])

  const isAdmin = draft?.role === 'admin'
  // Every action (fee toggle, Create/Sync/Send/Resend, tax exemption) is inert while the draft is being
  // re-read, the item editor is saving, or another action is already running — never acts on a stale draft.
  const locked = invoiceActionsLocked({ refreshing, editorBusy, busy, creating, sending, syncing, savingCust })
  // A confirmed/affirmative dialog action (Send, Choose customer) may run only against a current, loaded
  // draft — never while it is loading/refreshing or after a failed refresh dropped it.
  const currentDraftReady = draftActionReady({ draft: !!draft, loading, refreshing })

  return (
      <div>
        {loading && <p className="text-gray-500 text-sm py-8 text-center">Loading…</p>}

        {/* Re-reading the totals after an item edit: show it plainly, never the subtotal-new / total-old mix. */}
        {!loading && refreshing && (
          <div>
            {totalsOnly && subtotal}
            <p className="text-gray-500 text-sm py-6 text-center" role="status" aria-live="polite">Updating totals…</p>
          </div>
        )}

        {/* Fail closed: a failed totals refresh (non-2xx / missing draft / network) shows no stale total and
            no actionable charge controls — only the error and a Retry that re-reads the authoritative draft. */}
        {!loading && !refreshing && !draft && (
          <div role="alert" className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3">
            {totalsOnly && <div className="mb-2">{subtotal}</div>}
            <p className="text-red-300 text-sm font-semibold">Totals unavailable</p>
            <p className="text-red-300/80 text-xs mt-0.5">{err ?? 'Could not load the invoice totals.'}</p>
            <button type="button" onClick={() => void loadDraft('refresh')} className="mt-3 min-h-11 rounded-lg bg-red-600 text-white font-semibold px-4 active:opacity-80">Retry</button>
          </div>
        )}

        {!loading && !refreshing && draft && (
          <>
            {/* Header: who / what */}
            {!embedded && !totalsOnly && <div className="mb-4">
              {draft.customer && <p className="text-white text-base font-semibold">{draft.customer}</p>}
              <p className="text-gray-400 text-sm">{draft.vehicle}</p>
              {draft.services.length > 0 && <p className="text-gray-500 text-xs mt-1">{draft.services.join(' · ')}</p>}
            </div>}

            {draft.isDealer ? (
              <p className="text-gray-400 text-sm bg-gray-800/60 rounded-xl px-4 py-4">
                This is a Dealer Job — billed through Dealer Check-In / QuickBooks. No retail Shop Supplies, Payment Charge, or sales tax apply.
              </p>
            ) : !draft.priced && totalsOnly ? (
              <>
                {subtotal}
                <p className="text-gray-400 text-xs pt-3">Shop supplies, any card charge, tax and the total appear once the work is priced.</p>
              </>
            ) : !draft.priced ? (
              <p className="text-gray-400 text-sm bg-gray-800/60 rounded-xl px-4 py-4">
                No Work Price yet. Set a Work Price in Quick Entry (manager pricing) before an invoice draft can be prepared.
              </p>
            ) : (
              <>
                {/* Incomplete itemized pricing → show the agreed amount as a reference and flag the
                    total below as partial. Creating an invoice is blocked until pricing is finished. */}
                {draft.pricingIncomplete && !totalsOnly && (
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
                {!draft.pricingIncomplete && draft.referenceCents != null && !totalsOnly && (
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
                {/* Work: per-service breakdown (itemized) or a single Work line (flat) — or, in totals mode,
                    the caller's Subtotal row (the editable item list sits right above). Then the charges,
                    tax and total via the shared InvoiceTotals. */}
                <InvoiceTotals draft={draft} canEdit busy={locked} onToggle={(field, removed) => override(field, removed)}
                  subtotal={totalsOnly ? subtotal : (
                    <>
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
                          <button onClick={itemize} disabled={locked}
                            className="mt-1.5 text-blue-400 text-xs font-semibold active:opacity-70 disabled:opacity-40">Set individual service prices →</button>
                        )}
                      </div>
                    )}
                    </>
                  )}
                  tax={(draft.tax.applicable || draft.tax.exempt) ? (
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
                          ? <button onClick={() => override('tax_exempt', false)} disabled={locked}
                              className="text-xs font-semibold px-2.5 py-1 rounded-lg text-blue-400 border border-blue-900/60 active:opacity-70 disabled:opacity-40">Restore</button>
                          : <button onClick={() => setTaxReasonOpen((v) => !v)} disabled={locked}
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
                        <button onClick={() => override('tax_exempt', true, taxReason)} disabled={locked || !taxReason.trim()}
                          className="mt-2 w-full h-11 rounded-xl bg-amber-600 active:bg-amber-700 text-white text-sm font-bold disabled:opacity-40">
                          {busy ? 'Saving…' : 'Confirm tax exempt'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : false} />

                {/* QuickBooks — INVOICE-ID-FIRST. Linked → Sync/Send/Resend (never Create). */}
                {draft.qb.linked ? (() => {
                  const q = draft.qb
                  const stale = q.needsReview || q.syncNeeded || q.status === 'error'
                  // A recorded / in-flight / unconfirmed payment freezes the invoice: no Sync, and the unpaid
                  // Send/Resend give way to Email Paid Invoice (in the payment section below).
                  const payLocked = paymentLocksInvoice(q.payment)
                  // Another vehicle linked but not yet on the invoice → the invoice is stale: no Send, no payment
                  // until a manager reviews and updates it (the server enforces this too).
                  const sharedPending = (draft.shared?.pendingCount ?? 0) > 0
                  // An unfinished Combine unpaid invoices blocks every billing action on BOTH invoices (server-enforced too).
                  const combining = !!draft.combine?.active || q.status === 'consolidating'
                  const current = !q.syncNeeded && !q.needsReview && q.status !== 'error' && !payLocked && !sharedPending && !combining  // Send/Resend allowed
                  // Offer Combine only on a settled, unpaid invoice of its own that isn't already shared.
                  const canCombine = !draft.shared && !combining && !payLocked && q.payment.status === 'none' && (q.status === 'created' || q.status === 'sent') && !q.needsReview && !q.syncNeeded
                  return (
                  <div className={`mt-4 rounded-xl border px-4 py-3 ${stale || q.resendRecommended ? 'border-amber-900/60 bg-amber-950/30' : 'border-green-900/60 bg-green-950/40'}`}>
                    <p className={`text-sm font-semibold ${stale || q.resendRecommended ? 'text-amber-300' : 'text-green-300'}`}>QuickBooks Invoice{q.invoiceNumber ? ` #${q.invoiceNumber}` : ''}</p>
                    <p className="text-gray-400 text-xs mt-0.5">
                      {combining ? 'Being combined with another invoice — see below'
                        : q.payment.status === 'paid' ? 'Paid'
                        : q.payment.balanceState === 'partial' ? 'Partially paid'
                        : q.needsReview ? 'Needs review'
                        : q.status === 'error' ? 'Sync failed'
                        : q.syncNeeded ? (q.sent ? 'Sent · Sync needed' : 'Sync needed')
                        : q.resendRecommended ? 'Updated after last email · Resend recommended'
                        : q.sent ? `Sent${sentTo ? ` to ${sentTo}` : ''}${q.sentAt ? ` · ${new Date(q.sentAt).toLocaleString()}` : ''}`
                        : 'Current'}
                    </p>
                    {q.needsReview && q.error && <p className="text-amber-400/80 text-xs mt-1">{q.error}</p>}

                    {draft.shared && <SharedInvoiceSection orderId={orderId} shared={draft.shared} enabled={sharedEnabled} canOffer={false} disabled={locked || combining} onChanged={refetch} />}
                    <CombineInvoicesSection orderId={orderId} state={draft.combine} enabled={combineEnabled} canOffer={canCombine} disabled={locked} onChanged={refetch} />

                    {/* Sync (manager + admin) — offered when stale/failed, never on needs-review. */}
                    {(q.syncNeeded || q.status === 'error') && !q.needsReview && syncEnabled && !payLocked && !combining && (
                      <button onClick={syncQb} disabled={locked}
                        className="mt-3 w-full text-white font-semibold text-base py-3 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                        {syncing ? 'Syncing…' : q.status === 'error' ? 'Retry Sync' : 'Sync QuickBooks'}
                      </button>
                    )}
                    {syncMsg && <p className="text-amber-400 text-xs mt-2">{syncMsg}</p>}

                    {/* Send (manager + admin) — current + unsent only. */}
                    {current && !q.sent && sendEnabled && (
                      <button onClick={() => openSend(false)} disabled={locked}
                        className="mt-3 w-full text-white font-semibold text-base py-3 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                        {sending ? 'Checking…' : 'Send Invoice'}
                      </button>
                    )}
                    {/* Resend (manager + admin) — explicit, once already sent + current. */}
                    {current && q.sent && sendEnabled && (
                      <button onClick={() => openSend(true)} disabled={locked}
                        className={`mt-3 w-full font-semibold text-sm py-2.5 rounded-2xl active:opacity-80 disabled:opacity-50 ${q.resendRecommended ? 'bg-amber-600 text-white' : 'border border-gray-700 text-gray-300'}`}>
                        {sending ? 'Checking…' : 'Resend Invoice'}
                      </button>
                    )}

                    {/* Record Payment → Paid → Email / Print Paid Invoice (stays available after Send until
                        QuickBooks confirms a zero balance). */}
                    {(paymentEnabled || q.payment.status !== 'none') && (
                      <InvoicePaymentSection orderId={orderId} qb={q} paymentEnabled={paymentEnabled && !q.needsReview && !sharedPending && !combining} sendEnabled={sendEnabled}
                        disabled={locked} onChanged={refetch} onToast={(m) => { setToast(m); setTimeout(() => setToast(null), 5000) }} />
                    )}
                    {toast && <p className="text-green-400 text-sm mt-2" role="status">{toast}</p>}
                  </div>
                  )
                })() : draft.shared ? (
                  // Billed on another vehicle's invoice — never Create a separate one (the server refuses too).
                  <>
                    <SharedInvoiceSection orderId={orderId} shared={draft.shared} enabled={sharedEnabled} canOffer={false} disabled={locked || !!draft.combine?.active} onChanged={refetch} />
                    <CombineInvoicesSection orderId={orderId} state={draft.combine} enabled={combineEnabled} canOffer={false} disabled={locked} onChanged={refetch} />
                  </>
                ) : (draft.pricingIncomplete || draft.referenceCents != null) ? (embedded ? (
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
                    <button onClick={createQb} disabled={locked}
                      className="w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                      {creating ? 'Creating…' : draft.qb.status === 'error' ? 'Retry — Create QuickBooks Invoice' : 'Create QuickBooks Invoice'}
                    </button>
                    {draft.qb.status === 'error' && draft.qb.error && <p className="text-amber-400 text-xs mt-2">Last attempt: {draft.qb.error}</p>}
                    <SharedInvoiceSection orderId={orderId} shared={null} enabled={sharedEnabled} canOffer={draft.qb.status === 'none' || draft.qb.status === 'error'} disabled={locked} onChanged={refetch} />
                    {/* After "Bill separately": explains why this Job needs a NEW invoice (its old one stays voided). */}
                    <CombineInvoicesSection orderId={orderId} state={draft.combine} enabled={combineEnabled} canOffer={false} disabled={locked} onChanged={refetch} />
                  </div>
                ) : (
                  <p className="text-gray-600 text-xs mt-4">QuickBooks invoicing is turned off.</p>
                )}

                {!draft.qb.linked && !draft.shared && (
                  <p className="text-gray-600 text-xs mt-4">Draft only — no invoice has been created or sent. Every change is recorded.</p>
                )}
              </>
            )}
            {/* Not priced yet: a linked vehicle still shows its shared invoice, and an unlinked retail Job may still
                join one (its charges go on only after it is priced and the invoice is reviewed). */}
            {!draft.isDealer && !draft.priced && (
              <SharedInvoiceSection orderId={orderId} shared={draft.shared} enabled={sharedEnabled}
                canOffer={!draft.shared && (draft.qb.status === 'none' || draft.qb.status === 'error')} disabled={locked} onChanged={refetch} />
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
                <button onClick={confirmSend} disabled={sending || !currentDraftReady} className="flex-1 py-3.5 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">{sending ? 'Sending…' : (resendMode ? 'Resend Invoice' : 'Send Invoice')}</button>
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
                  <button key={c.id} onClick={() => chooseCustomer(c.id)} disabled={savingCust || !currentDraftReady}
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

        {/* Action error (fee / create / sync / send) while a current draft is shown. A LOAD error is
            surfaced by the fail-closed card above, so it isn't repeated here. */}
        {err && draft && !refreshing && <p className="text-red-400 text-sm mt-4">{err}</p>}
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
