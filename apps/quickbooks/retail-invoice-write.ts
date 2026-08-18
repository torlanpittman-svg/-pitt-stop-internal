/**
 * Retail QuickBooks invoice WRITE primitives (P-D3.1). Separate from the dealer writer —
 * dealer functions in invoice-write.ts are untouched. Reuses only shared, behavior-
 * preserving helpers (ensureIncomeAccount/ensureServiceItem/nextInvoiceDocNumber, client).
 *
 * All retail lines are NON-taxable (detailing) so QuickBooks adds no tax and TotalAmt
 * equals the authoritative Pitt Stop total. Nothing here decides pricing — it receives
 * resolved line amounts (cents) and the customer/item ids.
 */
import { qbApiRequest, queryQBO, qboEscape } from './client'
import { ensureIncomeAccount, ensureServiceItem, nextInvoiceDocNumber } from './invoice-write'
import { extractPsid } from './retail-format'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:retail-invoice-write'

/** Resolve the generic retail items. Find-or-create: in prod "Labor"/"Fees" already exist
 *  (matched by name → returned unchanged); on sandbox they are created. */
export async function resolveRetailItems(): Promise<{ labor: string; fees: string }> {
  const income = await ensureIncomeAccount('Services')
  const [labor, fees] = await Promise.all([
    ensureServiceItem('Labor', income),
    ensureServiceItem('Fees', income),
  ])
  return { labor, fees }
}

export interface RetailWriteLine { itemId: string; description: string; amountCents: number }
export interface WrittenRetailInvoice {
  invoiceId: string
  invoiceNumber: string | null
  syncToken: string
  totalAmtCents: number
  lineCount: number
}

const cents = (dollars: number) => Math.round((dollars ?? 0) * 100)

function summarize(inv: { Id: string; DocNumber?: string; SyncToken: string; TotalAmt?: number; Line?: Array<{ DetailType?: string }> }): WrittenRetailInvoice {
  return {
    invoiceId: inv.Id,
    invoiceNumber: inv.DocNumber ?? null,
    syncToken: inv.SyncToken,
    totalAmtCents: cents(inv.TotalAmt ?? 0),
    lineCount: (inv.Line ?? []).filter((l) => l.DetailType === 'SalesItemLineDetail').length,
  }
}

/** Build a NON-taxable sales line (detailing → no QB-added tax). */
function buildLine(l: RetailWriteLine) {
  const amount = l.amountCents / 100
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    Description: l.description,
    SalesItemLineDetail: {
      ItemRef: { value: l.itemId },
      Qty: 1,
      UnitPrice: amount,
      TaxCodeRef: { value: 'NON' },   // non-taxable — keeps TotalAmt == Pitt Stop total
    },
  }
}

/** Create a retail invoice. Assigns the next DocNumber (company uses custom transaction
 *  numbers). CustomerMemo = customer-facing vehicle note ("Message displayed on invoice");
 *  PrivateNote = internal PSID tag; BillEmail = customer email (set explicitly, not relying
 *  on QB auto-copy). No email is sent — creation only. */
export async function createRetailInvoiceInQB(params: {
  customerId: string
  lines: RetailWriteLine[]
  privateNote: string
  customerMemo?: string | null
  billEmail?: string | null
  docNumber?: string | null
}): Promise<WrittenRetailInvoice> {
  const body: Record<string, unknown> = {
    CustomerRef: { value: params.customerId },
    Line: params.lines.map(buildLine),
    PrivateNote: params.privateNote,
  }
  if (params.customerMemo && params.customerMemo.trim()) body.CustomerMemo = { value: params.customerMemo.trim() }
  if (params.billEmail && params.billEmail.trim()) body.BillEmail = { Address: params.billEmail.trim() }
  const docNumber = params.docNumber ?? (await nextInvoiceDocNumber())
  if (docNumber) body.DocNumber = docNumber

  const res = await qbApiRequest<{ Invoice: Parameters<typeof summarize>[0] }>({ method: 'POST', path: '/invoice', body })
  logger.info(APP, 'retail_invoice.created', { id: res.Invoice.Id, docNumber: res.Invoice.DocNumber })
  return summarize(res.Invoice)
}

export interface RetailInvoiceRead {
  invoiceId: string
  invoiceNumber: string | null
  totalAmtCents: number
  billEmail: string | null
  emailStatus: string
  syncToken: string
  customerId: string | null
}
/** Read the linked invoice (for pre-send total-integrity + email checks). */
export async function getRetailInvoice(invoiceId: string): Promise<RetailInvoiceRead | null> {
  const res = await queryQBO<{ Invoice?: Array<{ Id: string; DocNumber?: string; TotalAmt?: number; SyncToken: string; EmailStatus?: string; BillEmail?: { Address?: string }; CustomerRef?: { value?: string } }> }>(
    `SELECT * FROM Invoice WHERE Id = '${qboEscape(invoiceId)}'`,
  )
  const inv = res.Invoice?.[0]
  if (!inv) return null
  return {
    invoiceId: inv.Id, invoiceNumber: inv.DocNumber ?? null, totalAmtCents: cents(inv.TotalAmt ?? 0),
    billEmail: inv.BillEmail?.Address ?? null, emailStatus: inv.EmailStatus ?? 'NotSet',
    syncToken: inv.SyncToken, customerId: inv.CustomerRef?.value ?? null,
  }
}

/** The full raw QB invoice (for Sync: PSID identity check + full-object read-modify-write). */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RawQBInvoice { Id: string; DocNumber?: string; SyncToken: string; TotalAmt?: number; EmailStatus?: string; PrivateNote?: string; CustomerRef?: { value?: string }; BillEmail?: { Address?: string }; Line?: any[]; [k: string]: any }
export async function getRetailInvoiceRaw(invoiceId: string): Promise<RawQBInvoice | null> {
  const res = await queryQBO<{ Invoice?: RawQBInvoice[] }>(`SELECT * FROM Invoice WHERE Id = '${qboEscape(invoiceId)}'`)
  return res.Invoice?.[0] ?? null
}

/**
 * UPDATE the linked retail invoice IN PLACE (Phase C Sync). Full read-modify-write: keeps the
 * fetched invoice (CustomerRef, DocNumber, …) and replaces ONLY the Pitt-Stop-owned fields —
 * Line[], CustomerMemo, BillEmail, PrivateNote — with the current SyncToken. Never changes the
 * customer, never creates, never sends. Same non-taxable lines as create, so QB TotalAmt stays
 * exactly the Pitt Stop total. Mirrors the dealer writer's full-object POST pattern.
 */
export async function updateRetailInvoiceInQB(params: {
  current: RawQBInvoice
  lines: RetailWriteLine[]
  privateNote: string
  customerMemo?: string | null
  billEmail?: string | null
}): Promise<WrittenRetailInvoice> {
  const body: Record<string, unknown> = {
    ...params.current,
    Line: params.lines.map(buildLine),
    PrivateNote: params.privateNote,
    sparse: false,
  }
  if (params.customerMemo && params.customerMemo.trim()) body.CustomerMemo = { value: params.customerMemo.trim() }
  else delete body.CustomerMemo
  if (params.billEmail && params.billEmail.trim()) body.BillEmail = { Address: params.billEmail.trim() }
  const res = await qbApiRequest<{ Invoice: Parameters<typeof summarize>[0] }>({ method: 'POST', path: '/invoice', body })
  logger.info(APP, 'retail_invoice.updated', { id: res.Invoice.Id, docNumber: res.Invoice.DocNumber })
  return summarize(res.Invoice)
}

/** Fill ONLY the BillEmail on the linked invoice (sparse update; nothing else changes). */
export async function fillRetailInvoiceEmail(invoiceId: string, syncToken: string, email: string): Promise<void> {
  await qbApiRequest({ method: 'POST', path: '/invoice', body: { Id: invoiceId, SyncToken: syncToken, sparse: true, BillEmail: { Address: email } } })
  logger.info(APP, 'retail_invoice.email_filled', { invoiceId })
}

/**
 * Email the EXISTING invoice via the QBO send endpoint — POST /invoice/{id}/send?sendTo=…
 * (empty body, application/octet-stream). Sends ONLY this invoice; never creates/clones/
 * alters it. QBO sets EmailStatus=EmailSent. Returns the refreshed status.
 */
export async function sendRetailInvoiceInQB(invoiceId: string, sendTo?: string | null): Promise<{ invoiceId: string; invoiceNumber: string | null; emailStatus: string; syncToken: string; billEmail: string | null }> {
  const res = await qbApiRequest<{ Invoice: { Id: string; DocNumber?: string; SyncToken: string; EmailStatus?: string; BillEmail?: { Address?: string } } }>({
    method: 'POST',
    path: `/invoice/${invoiceId}/send`,
    query: sendTo && sendTo.trim() ? { sendTo: sendTo.trim() } : undefined,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  logger.info(APP, 'retail_invoice.sent', { invoiceId, emailStatus: res.Invoice.EmailStatus })
  return { invoiceId: res.Invoice.Id, invoiceNumber: res.Invoice.DocNumber ?? null, emailStatus: res.Invoice.EmailStatus ?? 'EmailSent', syncToken: res.Invoice.SyncToken, billEmail: res.Invoice.BillEmail?.Address ?? null }
}

/**
 * Adoption: find an already-created retail invoice for this estimate by scanning the
 * customer's recent invoices' PrivateNote for the PSID tag. Crash-safe idempotency — if a
 * prior create succeeded in QB but the local DB write was lost, we adopt instead of dupe.
 */
export async function findRetailInvoiceByPsid(customerId: string, estimateId: string): Promise<WrittenRetailInvoice | null> {
  const res = await queryQBO<{ Invoice?: Array<Parameters<typeof summarize>[0] & { PrivateNote?: string }> }>(
    `SELECT * FROM Invoice WHERE CustomerRef = '${qboEscape(customerId)}' ORDERBY MetaData.CreateTime DESC MAXRESULTS 20`,
  )
  for (const inv of res.Invoice ?? []) {
    if (extractPsid(inv.PrivateNote) === estimateId) return summarize(inv)
  }
  return null
}
