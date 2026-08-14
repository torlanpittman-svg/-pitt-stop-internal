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
 *  numbers). PrivateNote carries the PSID recovery tag (internal only). No email is sent. */
export async function createRetailInvoiceInQB(params: {
  customerId: string
  lines: RetailWriteLine[]
  privateNote: string
  docNumber?: string | null
}): Promise<WrittenRetailInvoice> {
  const body: Record<string, unknown> = {
    CustomerRef: { value: params.customerId },
    Line: params.lines.map(buildLine),
    PrivateNote: params.privateNote,
  }
  const docNumber = params.docNumber ?? (await nextInvoiceDocNumber())
  if (docNumber) body.DocNumber = docNumber

  const res = await qbApiRequest<{ Invoice: Parameters<typeof summarize>[0] }>({ method: 'POST', path: '/invoice', body })
  logger.info(APP, 'retail_invoice.created', { id: res.Invoice.Id, docNumber: res.Invoice.DocNumber })
  return summarize(res.Invoice)
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
