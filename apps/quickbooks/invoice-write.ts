/**
 * QuickBooks invoice writes for dealer check-in.
 *
 * Reproduces the confirmed Sterling invoice structure:
 *   Product/Service "Complete Detail" → income account "Detail Sales",
 *   Qty 1, per-vehicle rate, description "YEAR MAKE MODEL COLOR #STOCK",
 *   ServiceDate = work date, Terms "Due on receipt".
 *
 * ensureAccount/ensureItem are find-or-create so this works in a fresh sandbox
 * and maps cleanly onto an existing production company. All writes are gated by
 * the caller; on production they run only after owner approval.
 */
import { qbApiRequest, queryQBO, qboEscape } from './client'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:invoice-write'

export interface DealerLineInput {
  description: string
  amount:      number
  serviceDate?: string // YYYY-MM-DD
}

// ── Account / Item setup ─────────────────────────────────────────────────────

/** Find an income account by name, or create it. Returns its Id. */
export async function ensureIncomeAccount(name: string): Promise<string> {
  const res = await queryQBO<{ Account?: Array<{ Id: string; Name: string }> }>(
    `select * from Account where Name = '${qboEscape(name)}'`
  )
  const found = res.Account?.[0]
  if (found) return found.Id

  const created = await qbApiRequest<{ Account: { Id: string } }>({
    method: 'POST',
    path:   '/account',
    body:   { Name: name, AccountType: 'Income', AccountSubType: 'SalesOfProductIncome' },
  })
  logger.info(APP, 'account.created', { name, id: created.Account.Id })
  return created.Account.Id
}

/** Find a service item by name, or create it mapped to the income account. */
export async function ensureServiceItem(name: string, incomeAccountId: string): Promise<string> {
  const res = await queryQBO<{ Item?: Array<{ Id: string; Name: string }> }>(
    `select * from Item where Name = '${qboEscape(name)}'`
  )
  const found = res.Item?.[0]
  if (found) return found.Id

  const created = await qbApiRequest<{ Item: { Id: string } }>({
    method: 'POST',
    path:   '/item',
    body:   {
      Name:            name,
      Type:            'Service',
      IncomeAccountRef: { value: incomeAccountId },
    },
  })
  logger.info(APP, 'item.created', { name, id: created.Item.Id })
  return created.Item.Id
}

/** Resolve the "Complete Detail" item id (creating item + account if needed). */
export async function resolveDealerDetailItem(): Promise<string> {
  const accountId = await ensureIncomeAccount('Detail Sales')
  return ensureServiceItem('Complete Detail', accountId)
}

/** Resolve the "Due on receipt" sales term id, or null if the company lacks it. */
export async function resolveDueOnReceiptTermId(): Promise<string | null> {
  const res = await queryQBO<{ Term?: Array<{ Id: string; Name: string }> }>(
    `select * from Term where Name = 'Due on receipt'`
  )
  return res.Term?.[0]?.Id ?? null
}

// ── Line construction ────────────────────────────────────────────────────────

function buildSalesLine(itemId: string, line: DealerLineInput) {
  return {
    DetailType: 'SalesItemLineDetail',
    Amount:     line.amount,
    Description: line.description,
    SalesItemLineDetail: {
      ItemRef:   { value: itemId },
      Qty:       1,
      UnitPrice: line.amount,
      ...(line.serviceDate ? { ServiceDate: line.serviceDate } : {}),
    },
  }
}

export interface WrittenInvoice {
  invoiceId:     string
  invoiceNumber: string | null
  syncToken:     string
  lineCount:     number
}

interface RawInvoice {
  Id:         string
  DocNumber?: string
  SyncToken:  string
  Line?:      Array<Record<string, unknown>>
  [k: string]: unknown
}

function summarize(inv: RawInvoice): WrittenInvoice {
  return {
    invoiceId:     inv.Id,
    invoiceNumber: inv.DocNumber ?? null,
    syncToken:     inv.SyncToken,
    lineCount:     (inv.Line ?? []).filter((l) => l.DetailType === 'SalesItemLineDetail').length,
  }
}

// ── Create / append ──────────────────────────────────────────────────────────

/** Create a new dealer invoice with a single line and "Due on receipt" terms. */
export async function createDealerInvoice(params: {
  customerId:  string
  itemId:      string
  line:        DealerLineInput
  salesTermId?: string | null
}): Promise<WrittenInvoice> {
  const body: Record<string, unknown> = {
    CustomerRef: { value: params.customerId },
    Line:        [buildSalesLine(params.itemId, params.line)],
  }
  if (params.salesTermId) body.SalesTermRef = { value: params.salesTermId }

  const res = await qbApiRequest<{ Invoice: RawInvoice }>({ method: 'POST', path: '/invoice', body })
  logger.info(APP, 'invoice.created', { id: res.Invoice.Id, docNumber: res.Invoice.DocNumber })
  return summarize(res.Invoice)
}

/**
 * Append a line to an existing invoice. Fetches the full invoice, appends the
 * new line, and posts the whole object back with its SyncToken (QBO requires the
 * complete Line array to add a line). Optimistic-lock safe: on a 409 the caller
 * should re-fetch and retry.
 */
export async function appendDealerLine(params: {
  invoiceId: string
  itemId:    string
  line:      DealerLineInput
}): Promise<WrittenInvoice> {
  const fetched = await qbApiRequest<{ Invoice: RawInvoice }>({ path: `/invoice/${params.invoiceId}` })
  const inv = fetched.Invoice
  const nextLines = [...(inv.Line ?? []), buildSalesLine(params.itemId, params.line)]

  const res = await qbApiRequest<{ Invoice: RawInvoice }>({
    method: 'POST',
    path:   '/invoice',
    body:   { ...inv, Line: nextLines, sparse: false },
  })
  logger.info(APP, 'invoice.line_appended', {
    id: res.Invoice.Id, docNumber: res.Invoice.DocNumber, lines: res.Invoice.Line?.length,
  })
  return summarize(res.Invoice)
}

/** Read a fresh summary of an invoice (id, number, syncToken, line count). */
export async function getInvoiceSummary(invoiceId: string): Promise<WrittenInvoice> {
  const res = await qbApiRequest<{ Invoice: RawInvoice }>({ path: `/invoice/${invoiceId}` })
  return summarize(res.Invoice)
}
