'use client'

/**
 * Record Payment / Paid state / Email Paid Invoice / Print Paid Invoice for a linked retail QuickBooks
 * invoice. Shared by the Invoice panel and the Completion Summary. Every decision is server-side
 * (apps/quickbooks/retail-payment-service.ts); this only drives the endpoints and shows their result.
 * "Paid" is shown ONLY from the server's QuickBooks-confirmed state — never optimistically.
 */
import { useCallback, useRef, useState } from 'react'
import { PAID_METHOD_LABEL, type PaidMethod, type PaymentMethodKey } from '@/apps/quickbooks/retail-payment'
import type { InvoiceDraftData } from './InvoiceDraftPanel'

const money = (c: number) => `$${(c / 100).toFixed(2)}`
const methodLabel = (m: string | null | undefined) => (m && PAID_METHOD_LABEL[m as PaidMethod]) || 'Recorded in QuickBooks'

interface Preview {
  ok: boolean; status: string; error?: string; amountCents?: number; invoiceNumber?: string | null
  methods?: { key: PaymentMethodKey; label: string; available: boolean; reason?: string }[]
  cardChargeCents?: number; cardChargeLabel?: string
  /** An unconfirmed earlier attempt: only it may be checked / retried, as this method. */
  pendingMethod?: PaymentMethodKey | null
  /** What Save records per method (server-computed by the pricing engine: Cash / Check without the card charge). */
  methodAmounts?: Partial<Record<PaymentMethodKey, number>>
  /** How much Cash / Check removes from the invoice (0 = nothing to remove). */
  cardFeeRemovalCents?: number
  /** The unconfirmed attempt already removed the card charge. */
  cardFeeRemoved?: boolean
}

/** The amount Save will confirm for a method — always the server's figure, never computed here. */
const amountFor = (pv: Preview, m: PaymentMethodKey) => pv.methodAmounts?.[m] ?? pv.amountCents ?? 0
const removesCardFee = (pv: Preview, m: PaymentMethodKey | null) => !!m && m !== 'card_terminal' && (pv.cardFeeRemovalCents ?? 0) > 0

export function InvoicePaymentSection({ orderId, qb, paymentEnabled, sendEnabled, disabled = false, onChanged, onToast }: {
  orderId: string
  qb: InvoiceDraftData['qb']
  paymentEnabled: boolean
  sendEnabled: boolean
  /** The surrounding panel is busy/refreshing — actions are inert. */
  disabled?: boolean
  /** Re-read the authoritative draft after any server change. */
  onChanged: () => void | Promise<void>
  onToast?: (msg: string) => void
}) {
  const p = qb.payment
  const paid = p.status === 'paid'
  const [preview, setPreview] = useState<Preview | null>(null)
  const [method, setMethod] = useState<PaymentMethodKey | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [emailPreview, setEmailPreview] = useState<{ recipient: string | null; invoiceNumber: string | null; resend: boolean } | null>(null)
  const [emailing, setEmailing] = useState(false)
  const [emailMsg, setEmailMsg] = useState<string | null>(null)
  const inFlight = useRef(false)   // double-tap guard (state updates are async)

  const callPayment = useCallback(async (body: object) => {
    const res = await fetch(`/api/workflow/orders/${orderId}/invoice/payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return (await res.json().catch(() => ({ ok: false, status: 'error', error: 'Unexpected response.' }))) as Preview & { method?: string }
  }, [orderId])

  // Opens the sheet: the server verifies the invoice and checks QuickBooks for an existing payment first.
  const openRecord = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true; setChecking(true); setMsg(null); setMethod(null)
    try {
      const d = await callPayment({ action: 'preview' })
      if (d.status === 'paid') { setPreview(null); onToast?.('QuickBooks already shows this invoice paid'); await onChanged(); return }
      if (!d.ok) { setMsg(d.error ?? 'Can’t record a payment right now.'); await onChanged(); return }
      setPreview(d)
      if (d.pendingMethod) setMethod(d.pendingMethod)
    } catch { setMsg('Network error — nothing was recorded. Try again.') }
    finally { inFlight.current = false; setChecking(false) }
  }, [callPayment, onChanged, onToast])

  const save = useCallback(async () => {
    if (inFlight.current || !preview || !method) return
    inFlight.current = true; setSaving(true); setMsg(null)
    try {
      const confirmed = amountFor(preview, method)
      const d = await callPayment({ action: 'record', method, confirmedAmountCents: confirmed })
      if (d.status === 'paid') {
        setPreview(null)
        onToast?.(d.method && d.method !== method ? 'QuickBooks already shows this invoice paid' : `Paid · ${methodLabel(d.method)}`)
      } else if (d.status === 'refused' && typeof d.amountCents === 'number' && d.amountCents !== confirmed) {
        // Nothing was saved: show the new amount for THIS method and require another tap to confirm it.
        setPreview({ ...preview, methodAmounts: { ...preview.methodAmounts, [method]: d.amountCents } }); setMsg(d.error ?? 'The amount changed — confirm the new amount.')
      } else {
        setMsg(d.error ?? 'The payment was not confirmed.')
        if (d.status !== 'refused') setPreview(null)
      }
      await onChanged()
    } catch {
      // The request may or may not have reached the server: show nothing as paid; the next open reconciles.
      setPreview(null); setMsg('Network error — the payment was not confirmed. Tap Check payment to see what QuickBooks recorded.')
      await onChanged()
    } finally { inFlight.current = false; setSaving(false) }
  }, [preview, method, callPayment, onChanged, onToast])

  const openEmail = useCallback(async (resend: boolean) => {
    if (inFlight.current) return
    inFlight.current = true; setEmailing(true); setEmailMsg(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/send-paid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: false }) })
      const d = await res.json().catch(() => ({}))
      const pv = d.preview
      if (!res.ok || !pv?.recipient) { setEmailMsg(pv?.error ?? d.error ?? 'Can’t email this invoice right now.'); await onChanged(); return }
      setEmailPreview({ recipient: pv.recipient, invoiceNumber: pv.invoiceNumber ?? qb.invoiceNumber, resend })
    } catch { setEmailMsg('Network error — please try again.') }
    finally { inFlight.current = false; setEmailing(false) }
  }, [orderId, qb.invoiceNumber, onChanged])

  const confirmEmail = useCallback(async () => {
    if (inFlight.current || !emailPreview) return
    inFlight.current = true; setEmailing(true); setEmailMsg(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/send-paid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, resend: emailPreview.resend }) })
      const d = await res.json().catch(() => ({}))
      if (d.ok) onToast?.(d.alreadySent && !emailPreview.resend ? 'QuickBooks already sent the paid invoice' : `QuickBooks sent the paid invoice to ${d.recipient ?? emailPreview.recipient}`)
      else setEmailMsg(d.error ?? 'The email was not sent. The payment is still recorded.')
      setEmailPreview(null)
      await onChanged()
    } catch { setEmailPreview(null); setEmailMsg('Network error — the email was not confirmed. The payment is still recorded.') }
    finally { inFlight.current = false; setEmailing(false) }
  }, [orderId, emailPreview, onChanged, onToast])

  // An earlier paid-invoice email QuickBooks hasn't confirmed: CHECK only (never sends). Sending another copy
  // is a separate, explicit choice (the first one may already be in the customer's inbox).
  const checkEmail = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true; setEmailing(true); setEmailMsg(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/send-paid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, checkOnly: true }) })
      const d = await res.json().catch(() => ({}))
      if (d.ok && d.status === 'sent') onToast?.('QuickBooks confirms it sent the paid invoice')
      else setEmailMsg(d.error ?? 'Still not confirmed by QuickBooks. The payment is still recorded.')
      await onChanged()
    } catch { setEmailMsg('Network error — nothing was sent. Try again.') }
    finally { inFlight.current = false; setEmailing(false) }
  }, [orderId, onChanged, onToast])

  const off = disabled || checking || saving || emailing
  const emailUnconfirmed = p.email.status === 'uncertain' || p.email.status === 'sending'
  const selected = preview?.methods?.find((m) => m.key === method)
  const removal = !!preview && removesCardFee(preview, method)

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      {paid ? (
        <div className="rounded-xl border border-green-800/70 bg-green-950/40 px-4 py-3" role="status">
          <div className="flex items-center justify-between gap-3">
            <p className="text-green-300 text-base font-bold">Paid</p>
            {p.amountCents != null && <span className="text-green-200 font-semibold tabular-nums">{money(p.amountCents)}</span>}
          </div>
          <p className="text-gray-300 text-sm mt-0.5">{methodLabel(p.method)}{p.paidAt ? ` · ${new Date(p.paidAt).toLocaleString()}` : ''}</p>
          <p className="text-gray-500 text-xs mt-0.5">QuickBooks shows a $0.00 balance.</p>
          {p.email.status === 'sent' && <p className="text-gray-400 text-xs mt-2">Paid invoice sent by QuickBooks{p.email.to ? ` to ${p.email.to}` : ''}{p.email.sentAt ? ` · ${new Date(p.email.sentAt).toLocaleString()}` : ''}</p>}
          {(p.email.status === 'error' || p.email.status === 'uncertain') && <p className="text-amber-400 text-xs mt-2">{p.email.status === 'uncertain' ? 'Paid invoice email not confirmed by QuickBooks — it may still have been sent' : 'Paid invoice email failed'} — the payment is still recorded.</p>}
        </div>
      ) : paymentEnabled ? (
        <>
          {(p.status === 'uncertain' || p.status === 'review' || p.status === 'error' || p.status === 'recording') && (
            <div className="mb-3 rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3" role="alert">
              <p className="text-amber-300 text-sm font-semibold">
                {p.status === 'review' ? 'Payment needs review in QuickBooks' : p.status === 'error' ? 'Payment not recorded' : p.status === 'recording' ? 'Payment being recorded…' : 'Payment not confirmed'}
              </p>
              <p className="text-amber-200/70 text-xs mt-0.5">{p.status === 'uncertain' || p.status === 'recording' ? 'Not shown as paid until QuickBooks confirms a $0.00 balance. Checking again will not record a second payment.' : (p.error ?? '')}</p>
            </div>
          )}
          <button type="button" onClick={openRecord} disabled={off}
            className="w-full text-white font-semibold text-base py-3 rounded-2xl bg-indigo-600 active:opacity-80 disabled:opacity-50">
            {checking ? 'Checking QuickBooks…' : p.status === 'uncertain' || p.status === 'recording' || p.status === 'review' ? 'Check payment' : 'Record Payment'}
          </button>
        </>
      ) : null}

      {paid && (
        <div className="mt-3 grid gap-2">
          {sendEnabled && emailUnconfirmed && (
            <>
              <button type="button" onClick={checkEmail} disabled={off}
                className="w-full font-semibold text-base py-3 rounded-2xl bg-emerald-600 text-white active:opacity-80 disabled:opacity-50">
                {emailing ? 'Checking…' : 'Check email status'}
              </button>
              <button type="button" onClick={() => openEmail(true)} disabled={off}
                className="w-full font-semibold text-sm py-2.5 rounded-2xl border border-gray-700 text-gray-300 active:opacity-70 disabled:opacity-50">
                Send another copy
              </button>
            </>
          )}
          {sendEnabled && !emailUnconfirmed && (
            <button type="button" onClick={() => openEmail(p.email.status === 'sent')} disabled={off}
              className={`w-full font-semibold text-base py-3 rounded-2xl active:opacity-80 disabled:opacity-50 ${p.email.status === 'sent' ? 'border border-gray-700 text-gray-300' : 'bg-emerald-600 text-white'}`}>
              {emailing ? 'Checking…' : p.email.status === 'sent' ? 'Resend Paid Invoice' : 'Email Paid Invoice'}
            </button>
          )}
          <a href={`/api/workflow/orders/${orderId}/invoice/pdf`} target="_blank" rel="noopener"
            className="block w-full text-center font-semibold text-sm py-2.5 rounded-2xl border border-gray-700 text-gray-300 active:opacity-70">
            Print Paid Invoice
          </a>
        </div>
      )}

      {msg && <p className="text-amber-400 text-sm mt-2" role="alert">{msg}</p>}
      {emailMsg && <p className="text-amber-400 text-sm mt-2" role="alert">{emailMsg}</p>}

      {/* Record Payment sheet: method → confirm amount → Save Payment. */}
      {preview && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !saving && setPreview(null)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" role="dialog" aria-modal="true" aria-label="Record Payment" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-bold text-lg">Record Payment</h3>
            <p className="text-gray-400 text-sm mb-4">Invoice{preview.invoiceNumber ? ` #${preview.invoiceNumber}` : ''} · records money already collected — no card is charged.</p>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">How did they pay?</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {(preview.methods ?? []).map((m) => {
                const locked = !!preview.pendingMethod && m.key !== preview.pendingMethod
                return (
                  <button key={m.key} type="button" disabled={!m.available || locked || saving} onClick={() => setMethod(m.key)} aria-pressed={method === m.key}
                    className={`min-h-14 rounded-xl border px-2 text-sm font-semibold disabled:opacity-40 ${method === m.key ? 'border-indigo-400 bg-indigo-500/20 text-white' : 'border-gray-700 bg-gray-800/50 text-gray-200'}`}>
                    {m.label}
                    {!m.available && <span className="block text-[10px] font-normal text-gray-500">Not set up</span>}
                  </button>
                )
              })}
            </div>
            {preview.pendingMethod && <p className="text-amber-300 text-xs mb-3">An earlier {methodLabel(preview.pendingMethod)} payment wasn’t confirmed by QuickBooks yet. Saving checks and retries that same payment — it can’t record a second one or switch methods.</p>}
            {(preview.methods ?? []).every((m) => !m.available) && <p className="text-amber-400 text-xs mb-3">No payment method is set up for QuickBooks yet. An admin must confirm the payment mappings.</p>}
            {method && selected?.available && (
              <>
                <p className="text-gray-400 text-sm">{removal ? `Amount due by ${methodLabel(method)}` : 'Amount due now'}</p>
                <p className="text-white text-3xl font-bold tabular-nums mb-1">{money(amountFor(preview, method))}</p>
                {removal ? (
                  <p className="text-emerald-300 text-xs mb-3 rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-2">
                    {preview.cardChargeLabel ?? 'Card'} charge removed: −{money(preview.cardFeeRemovalCents ?? 0)} (invoice is {money(preview.amountCents ?? 0)} by card).
                    Saving updates this same QuickBooks invoice to {money(amountFor(preview, method))}, checks it, then records the payment.
                  </p>
                ) : preview.cardFeeRemoved ? (
                  <p className="text-gray-400 text-xs mb-3">The card charge was already removed for this {methodLabel(method)} payment. Saving re-checks the invoice before recording it.</p>
                ) : (
                  <p className="text-gray-500 text-xs mb-3">
                    The full balance in QuickBooks{method === 'card_terminal' && (preview.cardChargeCents ?? 0) > 0 ? `, including the ${preview.cardChargeLabel ?? 'card'} charge of ${money(preview.cardChargeCents ?? 0)}` : ''}. Partial payments and tips aren’t recorded here.
                  </p>
                )}
              </>
            )}
            <div className="flex gap-3">
              <button type="button" onClick={() => setPreview(null)} disabled={saving} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
              <button type="button" onClick={save} disabled={saving || !method || !selected?.available} className="flex-1 py-3.5 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">
                {saving ? (removal ? 'Updating invoice…' : 'Saving…') : 'Save Payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Email Paid Invoice confirmation. */}
      {emailPreview && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !emailing && setEmailPreview(null)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" role="dialog" aria-modal="true" aria-label="Email Paid Invoice" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-bold text-lg mb-1">{emailPreview.resend ? 'Resend' : 'Email'} Paid Invoice{emailPreview.invoiceNumber ? ` #${emailPreview.invoiceNumber}` : ''}</h3>
            <p className="text-gray-400 text-sm mb-3">QuickBooks emails the same invoice, now showing the payment and a $0.00 balance.</p>
            {emailPreview.resend && emailUnconfirmed && <p className="text-amber-300 text-xs mb-3">QuickBooks may already have sent the earlier email — this sends another copy.</p>}
            <p className="text-gray-400 text-sm">To</p>
            <p className="text-white text-base font-semibold mb-5">{emailPreview.recipient}</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setEmailPreview(null)} disabled={emailing} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
              <button type="button" onClick={confirmEmail} disabled={emailing} className="flex-1 py-3.5 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">{emailing ? 'Sending…' : 'Send Email'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
