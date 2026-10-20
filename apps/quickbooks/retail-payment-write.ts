/**
 * Retail Record Payment — QuickBooks IO primitives. Accounting API only (com.intuit.quickbooks.accounting):
 * a Payment entity RECORDS money already collected. Nothing here can charge a card (that would be the
 * separate QuickBooks Payments API / scope, which this app never requests).
 */
import { qbApiRequest, qbApiRequestBinary, queryQBO, qboEscape } from './client'
import { getValidAccessToken } from './connection'
import { PAYMENT_WRITE_TIMEOUT_MS, type QbPayment } from './retail-payment'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:retail-payment-write'

/** The connected QuickBooks company (realm) — mappings are pinned to it. */
export async function connectedRealmId(): Promise<string | null> {
  try { return (await getValidAccessToken()).realmId } catch { return null }
}

export async function getQbPayment(paymentId: string): Promise<QbPayment | null> {
  const res = await queryQBO<{ Payment?: QbPayment[] }>(`SELECT * FROM Payment WHERE Id = '${qboEscape(paymentId)}'`)
  return res.Payment?.[0] ?? null
}

/**
 * Every payment that could bear on this invoice: those QuickBooks lists as applied to it, plus any of
 * this customer's recent payments carrying our PSPAY tag (covers a write whose response was lost).
 */
export async function loadInvoicePayments(params: { linkedIds: string[]; customerId: string | null; estimateId: string }): Promise<QbPayment[]> {
  const out = new Map<string, QbPayment>()
  for (const pid of params.linkedIds) {
    const p = await getQbPayment(pid)
    if (p) out.set(String(p.Id), p)
  }
  if (params.customerId) {
    const res = await queryQBO<{ Payment?: QbPayment[] }>(
      `SELECT * FROM Payment WHERE CustomerRef = '${qboEscape(params.customerId)}' ORDERBY MetaData.CreateTime DESC MAXRESULTS 50`,
    )
    for (const p of res.Payment ?? []) if ((p.PrivateNote ?? '').includes(`PSPAY:${params.estimateId}:`)) out.set(String(p.Id), p)
  }
  return [...out.values()]
}

/** Confirm the mapped PaymentMethod and deposit account exist and are active in the connected company. */
export async function verifyPaymentMapping(m: { paymentMethodId: string; depositAccountId: string }): Promise<string | null> {
  const [pm, acct] = await Promise.all([
    queryQBO<{ PaymentMethod?: Array<{ Id: string; Active?: boolean }> }>(`SELECT * FROM PaymentMethod WHERE Id = '${qboEscape(m.paymentMethodId)}'`),
    queryQBO<{ Account?: Array<{ Id: string; Active?: boolean; AccountType?: string; AccountSubType?: string }> }>(`SELECT * FROM Account WHERE Id = '${qboEscape(m.depositAccountId)}'`),
  ])
  const method = pm.PaymentMethod?.[0], account = acct.Account?.[0]
  if (!method || method.Active === false) return 'The QuickBooks payment method for this choice is missing or inactive.'
  if (!account || account.Active === false) return 'The QuickBooks deposit account for this choice is missing or inactive.'
  // A payment may only land in a bank account or the Undeposited Funds clearing account.
  if (account.AccountType !== 'Bank' && account.AccountSubType !== 'UndepositedFunds') return 'The mapped deposit account is not a bank or Undeposited Funds account.'
  return null
}

/**
 * Create the QuickBooks Payment applied to ONE invoice for its full balance. `requestId` is sent as
 * QBO's `requestid` so a retry of the same attempt is de-duplicated by QuickBooks itself; PrivateNote
 * carries the PSPAY attempt tag for reconciliation. Times out (ambiguous) rather than hanging.
 */
export async function createRetailPaymentInQB(params: {
  customerId: string; invoiceId: string; amountCents: number
  paymentMethodId: string; depositAccountId: string
  privateNote: string; requestId: string
}): Promise<{ paymentId: string; totalCents: number }> {
  const amount = params.amountCents / 100
  const body = {
    CustomerRef: { value: params.customerId },
    TotalAmt: amount,
    PaymentMethodRef: { value: params.paymentMethodId },
    DepositToAccountRef: { value: params.depositAccountId },
    PrivateNote: params.privateNote,
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: params.invoiceId, TxnType: 'Invoice' }] }],
  }
  const res = await qbApiRequest<{ Payment: QbPayment }>({
    method: 'POST', path: '/payment', body, query: { requestid: params.requestId }, timeoutMs: PAYMENT_WRITE_TIMEOUT_MS,
  })
  logger.info(APP, 'retail_payment.created', { paymentId: res.Payment.Id, invoiceId: params.invoiceId })
  return { paymentId: String(res.Payment.Id), totalCents: Math.round((res.Payment.TotalAmt ?? 0) * 100) }
}

/** The invoice PDF exactly as QuickBooks renders it for the customer (read-only). */
export async function getRetailInvoicePdf(invoiceId: string): Promise<ArrayBuffer> {
  return qbApiRequestBinary({ path: `/invoice/${encodeURIComponent(invoiceId)}/pdf`, accept: 'application/pdf' })
}
