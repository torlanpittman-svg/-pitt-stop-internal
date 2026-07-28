/**
 * QuickBooks invoice read helpers (read-only).
 *
 * "Open" = has a positive balance and has not been fully paid. EmailStatus tells
 * us whether the invoice has already been sent to the dealership — the signal the
 * dealer check-in flow uses to decide append-to-open vs. create-new.
 */
import { queryQBO, qboEscape } from './client'
import { selectAppendableInvoice } from '@/apps/dealer-checkin/rules'

export type QBEmailStatus = 'NotSet' | 'NeedToSend' | 'EmailSent'

export interface QBInvoiceSummary {
  id:          string
  docNumber:   string | null
  txnDate:     string | null
  balance:     number
  totalAmount: number
  emailStatus: QBEmailStatus
  /** true when EmailStatus === 'EmailSent' — treat as closed for editing. */
  sent:        boolean
  syncToken:   string
  lineCount:   number
}

interface RawInvoice {
  Id:          string
  DocNumber?:  string
  TxnDate?:    string
  Balance?:    number
  TotalAmt?:   number
  EmailStatus?: string
  SyncToken:   string
  Line?:       Array<{ DetailType?: string }>
}

function mapInvoice(inv: RawInvoice): QBInvoiceSummary {
  const emailStatus = (inv.EmailStatus as QBEmailStatus) ?? 'NotSet'
  return {
    id:          inv.Id,
    docNumber:   inv.DocNumber ?? null,
    txnDate:     inv.TxnDate ?? null,
    balance:     inv.Balance ?? 0,
    totalAmount: inv.TotalAmt ?? 0,
    emailStatus,
    sent:        emailStatus === 'EmailSent',
    syncToken:   inv.SyncToken,
    lineCount:   (inv.Line ?? []).filter((l) => l.DetailType === 'SalesItemLineDetail').length,
  }
}

/** All invoices for a customer (most recent first). */
export async function listInvoicesForCustomer(customerId: string): Promise<QBInvoiceSummary[]> {
  const res = await queryQBO<{ Invoice?: RawInvoice[] }>(
    `select * from Invoice where CustomerRef = '${qboEscape(customerId)}' orderby TxnDate desc`
  )
  return (res.Invoice ?? []).map(mapInvoice)
}

/** Open invoices (positive balance) for a customer. */
export async function listOpenInvoicesForCustomer(customerId: string): Promise<QBInvoiceSummary[]> {
  const all = await listInvoicesForCustomer(customerId)
  return all.filter((inv) => inv.balance > 0)
}

/**
 * The invoice a new dealer line should be appended to: the most recent open,
 * NOT-yet-sent invoice. Returns null when a fresh invoice should be created.
 */
export async function findAppendableInvoice(customerId: string): Promise<QBInvoiceSummary | null> {
  const all = await listInvoicesForCustomer(customerId)
  return selectAppendableInvoice(all)
}
