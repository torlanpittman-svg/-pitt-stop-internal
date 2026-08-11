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
/**
 * Next invoice number in the company's own sequence.
 *
 * The Pitt Stop company has "Custom transaction numbers" enabled, so QuickBooks
 * does NOT auto-assign a DocNumber on create — an invoice created without one is
 * numberless and effectively invisible in the invoice list. We continue their
 * sequence by taking the highest recent numeric DocNumber and adding 1. Returns
 * null if no numbered invoice can be found (then QB's own numbering applies).
 */
async function nextInvoiceDocNumber(): Promise<string | null> {
  try {
    const res = await queryQBO<{ Invoice?: Array<{ DocNumber?: string }> }>(
      `SELECT DocNumber, MetaData FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 50`,
    )
    let max = 0
    for (const inv of res.Invoice ?? []) {
      const digits = (inv.DocNumber ?? '').replace(/\D/g, '')
      const n = digits ? parseInt(digits, 10) : NaN
      if (Number.isFinite(n) && n > max) max = n
    }
    return max > 0 ? String(max + 1) : null
  } catch (err) {
    logger.warn(APP, 'docnumber.lookup_failed', { error: String(err) })
    return null
  }
}

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

  // Company uses custom transaction numbers → assign the next number ourselves,
  // otherwise the invoice is created with a blank DocNumber (looks "missing").
  const docNumber = await nextInvoiceDocNumber()
  if (docNumber) body.DocNumber = docNumber

  const res = await qbApiRequest<{ Invoice: RawInvoice }>({ method: 'POST', path: '/invoice', body })
  logger.info(APP, 'invoice.created', { id: res.Invoice.Id, docNumber: res.Invoice.DocNumber, requestedDocNumber: docNumber })
  if (!res.Invoice.DocNumber) {
    logger.error(APP, 'invoice.created_without_number', { id: res.Invoice.Id, requestedDocNumber: docNumber })
  }
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

export interface LineUpdateResult {
  ok:             boolean
  invoiceId?:     string
  invoiceNumber?: string | null
  reason?:        'invoice_not_found' | 'line_not_found' | 'qb_error'
  error?:         string
}

/**
 * Correct ONE existing invoice line's Description, identified by exact DocNumber +
 * line Id (never a name/customer search). Changes only that line's Description — not
 * its amount, item, or any other line — via read-modify-write with the invoice's
 * SyncToken (409-safe: one retry). Returns a structured result so the caller can flag
 * "QuickBooks sync needs review" rather than ever writing to the wrong invoice. Used
 * by the Job-detail vehicle correction; does NOT create invoices.
 */
export async function updateDealerLineByDescription(params: {
  invoiceNumber: string
  lineId:        string
  description:   string
}): Promise<LineUpdateResult> {
  const attempt = async (): Promise<LineUpdateResult> => {
    const q = await queryQBO<{ Invoice?: RawInvoice[] }>(
      `SELECT * FROM Invoice WHERE DocNumber = '${qboEscape(params.invoiceNumber)}'`
    )
    const matches = q.Invoice ?? []
    if (matches.length !== 1) return { ok: false, reason: 'invoice_not_found', error: `${matches.length} invoice(s) for DocNumber ${params.invoiceNumber}` }
    const inv = matches[0]
    const target = (inv.Line ?? []).find((l) => String(l.Id) === String(params.lineId) && l.DetailType === 'SalesItemLineDetail')
    if (!target) return { ok: false, reason: 'line_not_found', error: `line ${params.lineId} not found on invoice ${params.invoiceNumber}` }
    const nextLines = (inv.Line ?? []).map((l) => (String(l.Id) === String(params.lineId) ? { ...l, Description: params.description } : l))
    const res = await qbApiRequest<{ Invoice: RawInvoice }>({ method: 'POST', path: '/invoice', body: { ...inv, Line: nextLines, sparse: false } })
    logger.info(APP, 'invoice.line_corrected', { id: res.Invoice.Id, docNumber: res.Invoice.DocNumber, lineId: params.lineId })
    return { ok: true, invoiceId: String(res.Invoice.Id), invoiceNumber: res.Invoice.DocNumber ?? null }
  }
  try {
    return await attempt()
  } catch {
    try { return await attempt() }               // one retry for SyncToken/transient conflicts
    catch (e2) {
      logger.error(APP, 'invoice.line_correct_failed', { invoiceNumber: params.invoiceNumber, error: String(e2) })
      return { ok: false, reason: 'qb_error', error: String((e2 as Error)?.message ?? e2) }
    }
  }
}

/** Read a fresh summary of an invoice (id, number, syncToken, line count). */
export async function getInvoiceSummary(invoiceId: string): Promise<WrittenInvoice> {
  const res = await qbApiRequest<{ Invoice: RawInvoice }>({ path: `/invoice/${invoiceId}` })
  return summarize(res.Invoice)
}

/** Sales-line descriptions on an invoice — used for QB-side duplicate detection. */
export async function getInvoiceLineDescriptions(invoiceId: string): Promise<string[]> {
  const res = await qbApiRequest<{ Invoice: RawInvoice }>({ path: `/invoice/${invoiceId}` })
  return (res.Invoice.Line ?? [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail')
    .map((l) => String(l.Description ?? ''))
}
