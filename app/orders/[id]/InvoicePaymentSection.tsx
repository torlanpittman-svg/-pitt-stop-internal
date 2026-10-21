'use client'

/**
 * Record Payment (full or partial, any number of installments) / payment state / Email Paid Invoice / Print for
 * a linked retail QuickBooks invoice. Shared by the Invoice panel and the Completion Summary. Every decision is
 * server-side (apps/quickbooks/retail-payment-service.ts); this only drives the endpoints and shows their result.
 * "Paid" and "Partially paid" are shown ONLY from the server's QuickBooks-confirmed state — never optimistically.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { PAID_METHOD_LABEL, parseAmountInput, type PaidMethod, type PaymentMethodKey } from '@/apps/quickbooks/retail-payment'
import type { InvoiceDraftData } from './InvoiceDraftPanel'

/** The amount/method entry to show after a server preview is applied to an open sheet.
 *  - a pinned unconfirmed attempt always wins (it can only be retried as that method + amount);
 *  - otherwise a deliberate recheck ("Check QuickBooks", or recovering a lost response) KEEPS what the person
 *    typed, while opening the sheet fresh ("Record Payment" / "Record another payment") clears it.
 *  Exported + unit-tested because there is no DOM test environment here (node-only vitest). */
export function nextEntry(
  prev: { method: PaymentMethodKey | null; amountText: string; amountEdited: boolean },
  pv: { pendingMethod?: PaymentMethodKey | null; pendingAmountCents?: number | null },
  keep: boolean,
): { method: PaymentMethodKey | null; amountText: string; amountEdited: boolean } {
  if (pv.pendingMethod) {
    return pv.pendingAmountCents != null
      ? { method: pv.pendingMethod, amountText: (pv.pendingAmountCents / 100).toFixed(2), amountEdited: true }
      : { method: pv.pendingMethod, amountText: prev.amountText, amountEdited: prev.amountEdited }
  }
  return keep ? prev : { method: null, amountText: '', amountEdited: false }
}

const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const methodLabel = (m: string | null | undefined) => (m && PAID_METHOD_LABEL[m as PaidMethod]) || 'Recorded in QuickBooks'
const centsText = (c: number) => (c / 100).toFixed(2)
const shortDate = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const asOf = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null)

interface BalanceView {
  state: 'unpaid' | 'partial' | 'paid'
  totalCents: number; balanceCents: number; receivedCents: number; creditCents: number
  history: { paymentId: string; date: string | null; appliedCents: number; receivedCents: number; creditCents: number; methodLabel: string; source: 'pitt_stop' | 'external' }[]
}
interface Preview {
  ok: boolean; status: string; block?: string; error?: string; amountCents?: number; invoiceNumber?: string | null
  methods?: { key: PaymentMethodKey; label: string; available: boolean; reason?: string }[]
  cardChargeCents?: number; cardChargeLabel?: string
  /** An unconfirmed earlier attempt: only it may be checked / retried, as this method and amount. */
  pendingMethod?: PaymentMethodKey | null
  pendingAmountCents?: number | null
  /** The FULL-payment amount per method (server: Cash / Check on an unpaid invoice without the card charge). */
  methodAmounts?: Partial<Record<PaymentMethodKey, number>>
  /** How much Cash / Check in full removes from the invoice (0 = nothing to remove). */
  cardFeeRemovalCents?: number
  /** The unconfirmed attempt already removed the card charge. */
  cardFeeRemoved?: boolean
  balance?: BalanceView
  reconciled?: boolean; alreadyPaid?: boolean; method?: string | null; methodLabel?: string | null; paymentId?: string | null
}

/** The full-payment amount for a method — always the server's figure. */
const fullFor = (pv: Preview, m: PaymentMethodKey) => pv.methodAmounts?.[m] ?? pv.amountCents ?? 0
const removesCardFee = (pv: Preview, m: PaymentMethodKey | null) => !!m && m !== 'card_terminal' && (pv.cardFeeRemovalCents ?? 0) > 0

type Step = 'enter' | 'confirm' | 'done' | 'history'

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
  const partial = !paid && p.balanceState === 'partial'
  const unconfirmed = p.status === 'uncertain' || p.status === 'recording' || p.status === 'review'
  const [preview, setPreview] = useState<Preview | null>(null)
  const [step, setStep] = useState<Step>('enter')
  const [method, setMethod] = useState<PaymentMethodKey | null>(null)
  const [amountText, setAmountText] = useState('')
  const [amountEdited, setAmountEdited] = useState(false)
  const [result, setResult] = useState<Preview | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)        // outside the sheet
  const [sheetMsg, setSheetMsg] = useState<string | null>(null)
  const [emailPreview, setEmailPreview] = useState<{ recipient: string | null; invoiceNumber: string | null; resend: boolean } | null>(null)
  const [emailing, setEmailing] = useState(false)
  const [emailMsg, setEmailMsg] = useState<string | null>(null)
  const inFlight = useRef(false)   // double-tap guard (state updates are async)
  // One id per confirmed payment (method + amount), reused by every retry of it until it is confirmed, so a
  // Save repeated after a lost response finds the payment already recorded instead of recording it twice.
  const confirmation = useRef<{ key: string; method: PaymentMethodKey; cents: number } | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)

  const callPayment = useCallback(async (body: object) => {
    const res = await fetch(`/api/workflow/orders/${orderId}/invoice/payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return (await res.json().catch(() => ({ ok: false, status: 'error', error: 'Unexpected response.' }))) as Preview
  }, [orderId])

  /** Apply a fresh server preview to the open sheet. `keep` = a deliberate recheck (preserve typed entry);
   *  a pinned unconfirmed attempt always overrides. This mirrors the tested nextEntry() rule, but expressed as
   *  set-or-leave so it never has to read the current entry during render (no ref write during render). */
  const applyPreview = useCallback((d: Preview, keep: boolean) => {
    setPreview(d)
    if (d.pendingMethod) {
      // Pinned unconfirmed attempt: force its method; set its amount when known, else leave what was typed.
      setMethod(d.pendingMethod)
      if (d.pendingAmountCents != null) { setAmountText(centsText(d.pendingAmountCents)); setAmountEdited(true) }
    } else if (!keep) {
      // A fresh open clears; a recheck (keep) leaves the typed method/amount untouched.
      setMethod(null); setAmountText(''); setAmountEdited(false)
    }
  }, [])

  // Opens the sheet: the server verifies the invoice and reads QuickBooks' payments first. `keep` keeps the
  // typed amount/method (an explicit "Check QuickBooks" or lost-response recovery), vs. a fresh open which clears.
  const openRecord = useCallback(async (mode: 'record' | 'history' = 'record', keep = false) => {
    if (inFlight.current) return
    inFlight.current = true; setChecking(true); setMsg(null); setSheetMsg(null); setResult(null)
    try {
      const d = await callPayment({ action: 'preview' })
      if (d.status === 'paid') {
        if (mode === 'history' && d.balance) { setPreview(d); setStep('history') }
        else { setPreview(null); onToast?.('QuickBooks shows this invoice paid') }
        await onChanged(); return
      }
      if (!d.ok) { setMsg(d.error ?? 'Can’t record a payment right now.'); await onChanged(); return }
      applyPreview(d, keep)
      setStep(mode === 'history' ? 'history' : 'enter')
      if (d.reconciled) setSheetMsg(`QuickBooks confirmed an earlier ${d.methodLabel ?? ''} payment — the balance below includes it.`)
      if (d.reconciled || d.status !== p.status) await onChanged()
    } catch { setMsg('Network error — nothing was recorded. Try again.') }
    finally { inFlight.current = false; setChecking(false) }
  }, [callPayment, onChanged, onToast, applyPreview, p.status])

  const balance = preview?.balance
  const open = preview?.amountCents ?? 0
  const pinned = preview?.pendingAmountCents ?? null
  const full = preview && method ? fullFor(preview, method) : open
  const shownAmount = amountEdited || pinned != null ? amountText : (method ? centsText(full) : '')
  const parsed = shownAmount ? parseAmountInput(shownAmount) : null
  const cents = parsed?.ok ? parsed.cents : null
  const removal = !!preview && removesCardFee(preview, method)
  const paysInFullByCash = removal && cents === full
  const limit = removal ? full : open
  const overBy = cents != null && cents > limit ? cents - limit : 0
  const after = cents == null ? null : paysInFullByCash ? 0 : open - cents
  const isPartial = cents != null && !paysInFullByCash && cents < open
  const charge = preview?.cardChargeCents ?? 0
  const selected = preview?.methods?.find((m) => m.key === method)
  const amountError = parsed && !parsed.ok ? parsed.error
    : overBy > 0 ? (removal ? `Paid in full by ${methodLabel(method)} is ${money(full)} (card charge removed).` : `That is ${money(overBy)} more than the ${money(open)} open. Overpayments and tips aren’t recorded here.`)
    : null
  const canReview = !!method && !!selected?.available && cents != null && !amountError

  const save = useCallback(async () => {
    if (inFlight.current || !preview || !method || cents == null) return
    inFlight.current = true; setSaving(true); setSheetMsg(null)
    try {
      const c = confirmation.current
      const key = c && c.method === method && c.cents === cents ? c.key : crypto.randomUUID()
      confirmation.current = { key, method, cents }
      const d = await callPayment({ action: 'record', method, amountCents: cents, balanceCents: preview.amountCents, confirmationId: key, intent: cents === full ? 'full' : 'partial' })
      if (d.status === 'paid' || d.status === 'recorded') {
        confirmation.current = null
        setResult(d); setStep('done')
        onToast?.(d.status === 'paid' ? 'Paid — QuickBooks shows a $0.00 balance' : `Recorded ${money(d.amountCents ?? cents)} · ${money(d.balance?.balanceCents ?? 0)} remaining`)
      } else if (d.balance && (d.block === 'balance_changed' || d.block === 'over_balance')) {
        // Nothing was saved: show QuickBooks' current numbers (fresh preview — full amounts per method included)
        // and require a new confirmation. The typed amount stays.
        const again = d.block === 'balance_changed' ? await callPayment({ action: 'preview' }).catch(() => null) : null
        if (again?.status === 'paid') { setResult(again); setStep('done'); await onChanged(); return }
        if (again?.ok) applyPreview(again, true)
        else setPreview({ ...preview, amountCents: d.balance.balanceCents, balance: d.balance })
        setStep('enter'); setSheetMsg(d.error ?? 'The balance changed — check the amount and confirm again.')
      } else if (d.status === 'uncertain' || d.status === 'recording' || d.status === 'review') {
        // Not confirmed. Re-read so the sheet pins the unconfirmed attempt (same method + amount only).
        setStep('enter'); setSheetMsg(d.error ?? 'QuickBooks has not confirmed this payment yet. Check again — it won’t record a second payment.')
        const again = await callPayment({ action: 'preview' }).catch(() => null)
        if (again?.status === 'paid') { setResult(again); setStep('done') }
        else if (again?.ok) applyPreview(again, true)
      } else {
        // Refused or a definite failure: nothing recorded — keep everything the person entered.
        setStep('enter'); setSheetMsg(d.error ?? 'The payment was not recorded.')
      }
      await onChanged()
    } catch {
      // The request may or may not have reached the server: keep the sheet + details; the next save/check reconciles first.
      setStep('enter'); setSheetMsg('Network error — the payment was not confirmed. Saving the same amount again is safe: it checks QuickBooks first and won’t record this payment twice.')
    } finally { inFlight.current = false; setSaving(false) }
  }, [preview, method, cents, full, callPayment, onChanged, onToast, applyPreview])

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
  const closeSheet = useCallback(() => { if (!inFlight.current) { setPreview(null); setResult(null); setSheetMsg(null) } }, [])
  // Move focus into the sheet when it opens and let Escape close it (keyboard + screen-reader users).
  useEffect(() => {
    if (!preview) return
    sheetRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSheet() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, closeSheet])
  // Focus the amount field once a method is chosen (unless the amount is pinned to an unconfirmed attempt).
  useEffect(() => {
    if (preview && step === 'enter' && method && preview.pendingAmountCents == null) amountRef.current?.focus()
  }, [preview, step, method])
  const installments = (p.receivedCents ?? 0) > 0 && p.amountCents != null && p.totalCents != null && p.amountCents < p.totalCents

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      {paid ? (
        <div className="rounded-xl border border-green-800/70 bg-green-950/40 px-4 py-3" role="status">
          <div className="flex items-center justify-between gap-3">
            <p className="text-green-300 text-base font-bold">Paid</p>
            {(p.totalCents ?? p.amountCents) != null && <span className="text-green-200 font-semibold tabular-nums">{money((p.totalCents ?? p.amountCents)!)}</span>}
          </div>
          <p className="text-gray-300 text-sm mt-0.5">{installments ? `Final payment ${methodLabel(p.method)} ${money(p.amountCents!)}` : methodLabel(p.method)}{p.paidAt ? ` · ${new Date(p.paidAt).toLocaleString()}` : ''}</p>
          <p className="text-gray-500 text-xs mt-0.5">QuickBooks showed a $0.00 balance{p.checkedAt ? ` as of ${asOf(p.checkedAt)}` : ''}.</p>
          {p.email.status === 'sent' && <p className="text-gray-400 text-xs mt-2">Paid invoice sent by QuickBooks{p.email.to ? ` to ${p.email.to}` : ''}{p.email.sentAt ? ` · ${new Date(p.email.sentAt).toLocaleString()}` : ''}</p>}
          {(p.email.status === 'error' || p.email.status === 'uncertain') && <p className="text-amber-400 text-xs mt-2">{p.email.status === 'uncertain' ? 'Paid invoice email not confirmed by QuickBooks — it may still have been sent' : 'Paid invoice email failed'} — the payment is still recorded.</p>}
          <button type="button" onClick={() => openRecord('history')} disabled={off} className="mt-2 text-xs font-semibold text-green-300/90 underline underline-offset-2 disabled:opacity-50">
            {checking ? 'Checking QuickBooks…' : 'Payment history'}
          </button>
        </div>
      ) : paymentEnabled ? (
        <>
          {partial && (
            <div className="mb-3 rounded-xl border border-sky-800/70 bg-sky-950/40 px-4 py-3" role="status">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sky-300 text-base font-bold">Partially paid</p>
                {p.balanceCents != null && <span className="text-sky-100 font-semibold tabular-nums">{money(p.balanceCents)} left</span>}
              </div>
              <p className="text-gray-300 text-sm mt-0.5 tabular-nums">
                {money(p.receivedCents ?? 0)} received{(p.creditCents ?? 0) > 0 ? ` · ${money(p.creditCents!)} credits` : ''}{p.totalCents != null ? ` of ${money(p.totalCents)}` : ''}
              </p>
              <p className="text-gray-500 text-xs mt-0.5">From QuickBooks{p.checkedAt ? ` · as of ${asOf(p.checkedAt)}` : ''}{p.status === 'recorded' && p.method ? ` · last: ${methodLabel(p.method)}${p.amountCents != null ? ` ${money(p.amountCents)}` : ''}` : ''}</p>
              {msg && <p className="text-amber-400 text-xs mt-1">Last confirmed figures shown — the latest QuickBooks check didn’t complete. Open Record Payment to refresh.</p>}
            </div>
          )}
          {(unconfirmed || p.status === 'error') && (
            <div className="mb-3 rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3" role="alert">
              <p className="text-amber-300 text-sm font-semibold">
                {p.status === 'review' ? 'Payment needs review in QuickBooks' : p.status === 'error' ? 'Last payment not recorded' : p.status === 'recording' ? 'Payment being recorded…' : 'Payment not confirmed'}
              </p>
              <p className="text-amber-200/70 text-xs mt-0.5">{p.status === 'uncertain' || p.status === 'recording' ? `${p.amountCents != null ? `${methodLabel(p.method)} ${money(p.amountCents)} — n` : 'N'}ot counted until QuickBooks confirms it. Checking again will not record a second payment.` : (p.error ?? '')}</p>
            </div>
          )}
          <button type="button" onClick={() => openRecord('record')} disabled={off}
            className="w-full text-white font-semibold text-base py-3 rounded-2xl bg-indigo-600 active:opacity-80 disabled:opacity-50">
            {checking ? 'Checking QuickBooks…' : unconfirmed ? 'Check payment' : partial ? 'Record another payment' : 'Record Payment'}
          </button>
          {partial && (
            <a href={`/api/workflow/orders/${orderId}/invoice/pdf`} target="_blank" rel="noopener"
              className="mt-2 block w-full text-center font-semibold text-sm py-2.5 rounded-2xl border border-gray-700 text-gray-300 active:opacity-70">
              Print invoice (shows payments)
            </a>
          )}
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

      {/* Record Payment sheet: numbers → method → amount received → confirm → QuickBooks-confirmed result. */}
      {preview && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={closeSheet}>
          <div ref={sheetRef} tabIndex={-1} className="bg-gray-900 rounded-t-3xl px-4 sm:px-6 pt-5 pb-8 max-h-[92dvh] overflow-y-auto overscroll-contain outline-none" role="dialog" aria-modal="true" aria-label={step === 'history' ? 'Payment history' : 'Record Payment'} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-white font-bold text-lg">{step === 'history' ? 'Payment history' : step === 'done' ? (result?.status === 'paid' ? 'Paid' : 'Payment recorded') : 'Record Payment'}</h3>
                <p className="text-gray-400 text-xs">Invoice{preview.invoiceNumber ? ` #${preview.invoiceNumber}` : ''} · records money already collected — no card is charged.</p>
              </div>
              <button type="button" onClick={closeSheet} disabled={saving} aria-label="Close" className="shrink-0 h-11 w-11 rounded-full border border-gray-700 text-gray-400 text-xl leading-none active:opacity-70 disabled:opacity-40">×</button>
            </div>

            {step === 'done' && result ? (
              <DoneView result={result} onDone={closeSheet} onAnother={() => openRecord('record')} busy={off} />
            ) : (
              <>
                {balance && <BalanceTable b={balance} />}
                {balance && balance.history.length > 0 && <HistoryList b={balance} />}
                {sheetMsg && <p className="text-amber-300 text-sm mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2" role="alert">{sheetMsg}</p>}

                {step === 'history' ? (
                  <button type="button" onClick={closeSheet} className="mt-5 w-full py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70">Close</button>
                ) : step === 'confirm' && method && cents != null ? (
                  <div className="mt-4">
                    <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Confirm</p>
                    <div className="rounded-xl border border-indigo-700/70 bg-indigo-950/30 px-4 py-3">
                      <p className="text-white text-2xl font-bold tabular-nums">{money(cents)}</p>
                      <p className="text-gray-300 text-sm">{methodLabel(method)} · received now</p>
                      <p className="text-gray-400 text-sm mt-2 tabular-nums">
                        {paysInFullByCash ? `Pays the invoice in full — the ${preview.cardChargeLabel ?? 'card'} charge (${money(preview.cardFeeRemovalCents ?? 0)}) comes off first.` : `Balance after this payment: ${money(after ?? 0)}`}
                      </p>
                      {isPartial && <p className="text-sky-300/90 text-xs mt-1">Partial payment — the invoice stays open for the rest.</p>}
                    </div>
                    <div className="flex gap-3 mt-4">
                      <button type="button" onClick={() => setStep('enter')} disabled={saving} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Back</button>
                      <button type="button" onClick={save} disabled={saving} className="flex-[1.4] py-3.5 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">
                        {saving ? (paysInFullByCash ? 'Updating invoice…' : 'Saving…') : `Save ${money(cents)}`}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-gray-500 text-xs uppercase tracking-widest mt-4 mb-2">How did they pay?</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(preview.methods ?? []).map((m) => {
                        const locked = !!preview.pendingMethod && m.key !== preview.pendingMethod
                        return (
                          <button key={m.key} type="button" disabled={!m.available || locked || saving} onClick={() => setMethod(m.key)} aria-pressed={method === m.key}
                            className={`min-h-14 rounded-xl border px-1 text-sm font-semibold disabled:opacity-40 ${method === m.key ? 'border-indigo-400 bg-indigo-500/20 text-white' : 'border-gray-700 bg-gray-800/50 text-gray-200'}`}>
                            {m.label}
                            {!m.available && <span className="block text-[10px] font-normal text-gray-500">Not set up</span>}
                          </button>
                        )
                      })}
                    </div>
                    {preview.pendingMethod && <p className="text-amber-300 text-xs mt-3">An earlier {methodLabel(preview.pendingMethod)} payment{pinned != null ? ` of ${money(pinned)}` : ''} wasn’t confirmed by QuickBooks yet. Saving checks and retries that same payment — it can’t record a second one, change the amount or switch methods.</p>}
                    {(preview.methods ?? []).every((m) => !m.available) && <p className="text-amber-400 text-xs mt-3">No payment method is set up for QuickBooks yet. An admin must confirm the payment mappings.</p>}

                    {method && selected?.available && (
                      <div className="mt-4">
                        <label htmlFor={`amt-${orderId}`} className="text-gray-300 text-sm font-semibold">Amount received</label>
                        <div className={`mt-1.5 flex items-center rounded-xl border bg-gray-800/70 px-3 ${amountError ? 'border-amber-600' : 'border-gray-600 focus-within:border-indigo-400'}`}>
                          <span className="text-gray-400 text-2xl font-bold">$</span>
                          <input ref={amountRef} id={`amt-${orderId}`} type="text" inputMode="decimal" autoComplete="off" enterKeyHint="done"
                            value={shownAmount} readOnly={pinned != null} disabled={saving}
                            onChange={(e) => { setAmountEdited(true); setAmountText(e.target.value) }}
                            aria-invalid={!!amountError} aria-describedby={`amt-help-${orderId}`}
                            className="min-w-0 flex-1 bg-transparent py-3 pl-1 text-white text-2xl font-bold tabular-nums outline-none read-only:text-gray-300" />
                          {pinned == null && cents !== full && (
                            <button type="button" onClick={() => { setAmountEdited(false); setAmountText('') }} className="shrink-0 min-h-11 rounded-lg border border-gray-600 px-3 py-2 text-xs font-semibold text-gray-200 active:opacity-70">
                              Full {money(full)}
                            </button>
                          )}
                        </div>
                        <div id={`amt-help-${orderId}`} className="mt-2 space-y-1.5 text-xs">
                          {amountError ? <p className="text-amber-400">{amountError}</p>
                            : after != null && <p className="text-gray-300 tabular-nums">Balance after this payment: <span className="font-semibold text-white">{money(after)}</span>{isPartial ? ' · partial payment' : ''}</p>}
                          {removal && (paysInFullByCash
                            ? <p className="text-emerald-300 rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-2">Paying in full by {methodLabel(method)}: the {preview.cardChargeLabel ?? 'card'} charge comes off (−{money(preview.cardFeeRemovalCents ?? 0)}). Saving updates this same QuickBooks invoice to {money(full)}, checks it, then records the payment.</p>
                            : <p className="text-gray-400">Only paying the full {money(full)} by {methodLabel(method)} removes the {preview.cardChargeLabel ?? 'card'} charge. A partial payment leaves the invoice — and its {money(charge)} charge — as it is.</p>)}
                          {!removal && charge > 0 && <p className="text-gray-500">The invoice total, including the {preview.cardChargeLabel ?? 'card'} charge of {money(charge)}, stays as it is{balance?.state === 'partial' ? ' for every later payment' : ''}.</p>}
                          {preview.cardFeeRemoved && <p className="text-gray-400">The card charge was already removed for this {methodLabel(method)} payment. Saving re-checks the invoice before recording it.</p>}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-3 mt-5">
                      <button type="button" onClick={closeSheet} disabled={saving} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
                      {preview.status === 'uncertain' || sheetMsg?.startsWith('Network') ? (
                        <button type="button" onClick={() => openRecord('record', true)} disabled={off} className="flex-1 py-3.5 rounded-2xl border border-indigo-500 text-indigo-200 font-semibold active:opacity-70 disabled:opacity-40">{checking ? 'Checking…' : 'Check QuickBooks'}</button>
                      ) : null}
                      <button type="button" onClick={() => setStep('confirm')} disabled={saving || !canReview} className="flex-1 py-3.5 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">
                        Review
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
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

/** Invoice total, payments, credits and what is still open — QuickBooks' numbers. */
function BalanceTable({ b }: { b: BalanceView }) {
  return (
    <dl className="mt-4 rounded-xl border border-gray-700/80 bg-gray-800/40 px-4 py-3 text-sm tabular-nums">
      <div className="flex justify-between gap-3"><dt className="text-gray-400">Invoice total</dt><dd className="text-gray-200">{money(b.totalCents)}</dd></div>
      {b.receivedCents > 0 && <div className="flex justify-between gap-3 mt-1"><dt className="text-gray-400">Payments received</dt><dd className="text-gray-200">−{money(b.receivedCents)}</dd></div>}
      {b.creditCents > 0 && <div className="flex justify-between gap-3 mt-1"><dt className="text-gray-400">Credits & adjustments</dt><dd className="text-gray-200">−{money(b.creditCents)}</dd></div>}
      <div className="flex justify-between gap-3 mt-2 pt-2 border-t border-gray-700/70">
        <dt className="text-white font-semibold">{b.state === 'paid' ? 'Balance' : 'Remaining balance'}</dt>
        <dd className={`font-bold ${b.state === 'paid' ? 'text-green-300' : 'text-white'}`}>{money(b.balanceCents)}</dd>
      </div>
      <p className={`mt-1 text-xs font-semibold ${b.state === 'paid' ? 'text-green-300' : b.state === 'partial' ? 'text-sky-300' : 'text-gray-400'}`}>
        {b.state === 'paid' ? 'Paid' : b.state === 'partial' ? 'Partially paid' : 'Unpaid'}
      </p>
    </dl>
  )
}

function HistoryList({ b }: { b: BalanceView }) {
  return (
    <div className="mt-3">
      <p className="text-gray-500 text-xs uppercase tracking-widest mb-1.5">Payments in QuickBooks</p>
      <ul className="divide-y divide-gray-800 rounded-xl border border-gray-800">
        {b.history.map((h) => (
          <li key={h.paymentId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="text-gray-200 truncate">{h.receivedCents === 0 && h.creditCents > 0 ? 'Credit applied' : h.methodLabel}</p>
              <p className="text-gray-500 text-xs">{shortDate(h.date)}{h.source === 'external' ? ' · entered outside Pitt Stop' : ''}</p>
            </div>
            <span className="shrink-0 text-gray-100 font-semibold tabular-nums">{money(h.appliedCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The QuickBooks-confirmed outcome of a save (refreshed from QuickBooks by the server). */
function DoneView({ result, onDone, onAnother, busy }: { result: Preview; onDone: () => void; onAnother: () => void; busy: boolean }) {
  const b = result.balance
  const paidNow = result.status === 'paid'
  return (
    <div className="mt-4" role="status">
      <div className={`rounded-xl border px-4 py-3 ${paidNow ? 'border-green-800/70 bg-green-950/40' : 'border-sky-800/70 bg-sky-950/40'}`}>
        <p className={`text-base font-bold ${paidNow ? 'text-green-300' : 'text-sky-300'}`}>{paidNow ? 'Paid' : 'Partially paid'}</p>
        {result.amountCents != null && <p className="text-white text-2xl font-bold tabular-nums">{money(result.amountCents)} <span className="text-gray-300 text-sm font-semibold">{result.methodLabel ?? ''}</span></p>}
        <p className="text-gray-300 text-sm mt-1 tabular-nums">{b ? (paidNow ? 'QuickBooks shows a $0.00 balance.' : `QuickBooks shows ${money(b.balanceCents)} remaining.`) : ''}</p>
        {result.reconciled && <p className="text-gray-400 text-xs mt-1">{result.alreadyPaid ? 'QuickBooks already showed this invoice paid — nothing new was recorded.' : 'QuickBooks already had this payment — nothing new was recorded.'}</p>}
      </div>
      {b && <BalanceTable b={b} />}
      {b && b.history.length > 0 && <HistoryList b={b} />}
      <div className="flex gap-3 mt-5">
        {!paidNow && <button type="button" onClick={onAnother} disabled={busy} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Record another</button>}
        <button type="button" onClick={onDone} className="flex-1 py-3.5 rounded-2xl bg-indigo-600 text-white font-bold active:opacity-80">Done</button>
      </div>
    </div>
  )
}
