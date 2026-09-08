/**
 * QuickBooks I/O for coordinated Work Board removal (accidental check-in correction).
 *
 * Two mutations, both narrow, both idempotent, both fail-closed:
 *   · removeInvoiceLine — drop ONE SalesItemLineDetail line from a multi-line invoice via a full
 *     read-modify-write with the current SyncToken (QBO recalculates TotalAmt). Never voids or
 *     deletes the invoice; every other line is preserved byte-for-byte.
 *   · voidInvoice — POST /invoice?operation=void for a standalone accidental invoice. Void (not
 *     delete) is deliberate: it preserves the DocNumber sequence (the company uses custom
 *     transaction numbers, so a delete would leave a confusing permanent gap) and keeps the QB
 *     audit trail, while zeroing the financial effect so nothing shows as owed/earned.
 *
 * Plus read helpers that build the QbInvoiceSnapshot the pure planner (removal-plan.ts) consumes.
 * NEVER call these except from the scoped removal orchestrator — there is no general invoice-edit
 * surface here.
 */
import { qbApiRequest, queryQBO, qboEscape } from './client'
import { extractPsid } from './retail-format'
import type { QbInvoiceSnapshot, QbSalesLine } from '@/apps/workflow/removal-plan'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:invoice-removal'

interface RawInvoice {
  Id:          string
  DocNumber?:  string
  SyncToken:   string
  TotalAmt?:   number
  Balance?:    number
  EmailStatus?: string
  PrivateNote?: string
  Line?:       Array<Record<string, unknown>>
  [k: string]: unknown
}

const cents = (n: number | undefined): number => Math.round((n ?? 0) * 100)

/** A QBO invoice is "voided" once QuickBooks has zeroed it (TotalAmt & Balance both 0, or its
 *  PrivateNote carries the "Voided" marker). Treating this as done keeps voids idempotent. */
function isVoided(inv: RawInvoice): boolean {
  const note = String(inv.PrivateNote ?? '')
  if (/voided/i.test(note)) return true
  return cents(inv.TotalAmt) === 0 && cents(inv.Balance) === 0
}

function salesLinesOf(inv: RawInvoice): QbSalesLine[] {
  return (inv.Line ?? [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail')
    .map((l) => ({ id: String(l.Id ?? ''), description: String(l.Description ?? ''), amountCents: cents(l.Amount as number | undefined) }))
}

function snapshotOf(inv: RawInvoice): QbInvoiceSnapshot {
  return {
    status:       'resolved',
    invoiceId:    String(inv.Id),
    invoiceNumber: inv.DocNumber ?? null,
    totalCents:   cents(inv.TotalAmt),
    balanceCents: cents(inv.Balance),
    emailStatus:  String(inv.EmailStatus ?? 'NotSet'),
    voided:       isVoided(inv),
    salesLines:   salesLinesOf(inv),
  }
}

/**
 * DEALER read: resolve the invoice by its stored DocNumber. Exactly one match → resolved snapshot;
 * zero → not_found (idempotent: the invoice is already gone); more than one → ambiguous (fail
 * closed — we will never guess which invoice is the real one).
 */
export async function readDealerInvoiceSnapshot(docNumber: string): Promise<QbInvoiceSnapshot> {
  const res = await queryQBO<{ Invoice?: RawInvoice[] }>(
    `SELECT * FROM Invoice WHERE DocNumber = '${qboEscape(docNumber)}'`
  )
  const matches = res.Invoice ?? []
  if (matches.length === 0) return { status: 'not_found', invoiceId: '', invoiceNumber: docNumber, totalCents: 0, balanceCents: 0, emailStatus: '', voided: true, salesLines: [] }
  if (matches.length > 1) return { status: 'ambiguous', ambiguousReason: `${matches.length}_invoices_for_docnumber`, invoiceId: '', invoiceNumber: docNumber, totalCents: 0, balanceCents: 0, emailStatus: '', voided: false, salesLines: [] }
  return snapshotOf(matches[0])
}

/**
 * RETAIL read: fetch by QBO Invoice.Id and PROVE identity with the PSID marker in PrivateNote
 * (the estimate id). A missing PSID or a mismatch → ambiguous (never void an invoice we cannot
 * prove is this Job's). Invoice truly gone → not_found (idempotent).
 */
export async function readRetailInvoiceSnapshot(invoiceId: string, expectedPsid: string): Promise<QbInvoiceSnapshot> {
  const res = await queryQBO<{ Invoice?: RawInvoice[] }>(`SELECT * FROM Invoice WHERE Id = '${qboEscape(invoiceId)}'`)
  const inv = res.Invoice?.[0]
  if (!inv) return { status: 'not_found', invoiceId, invoiceNumber: null, totalCents: 0, balanceCents: 0, emailStatus: '', voided: true, salesLines: [] }
  if (extractPsid(inv.PrivateNote) !== expectedPsid) {
    return { status: 'ambiguous', ambiguousReason: 'psid_mismatch', invoiceId: String(inv.Id), invoiceNumber: inv.DocNumber ?? null, totalCents: cents(inv.TotalAmt), balanceCents: cents(inv.Balance), emailStatus: String(inv.EmailStatus ?? 'NotSet'), voided: isVoided(inv), salesLines: [] }
  }
  return snapshotOf(inv)
}

export interface RemovalWriteResult {
  ok:            boolean
  idempotent?:   boolean          // true when QB was already in the desired state (no write needed)
  invoiceId?:    string
  invoiceNumber?: string | null
  totalCentsBefore?: number
  totalCentsAfter?:  number
  error?:        string
}

/**
 * Remove ONE line (by exact QBO line Id) from a multi-line invoice. Read-modify-write with the
 * fresh SyncToken (one retry on conflict). Idempotent: if the line is already absent, reports
 * success without writing. Refuses to write if removing the line would empty the invoice — that
 * is the standalone/void case and must go through voidInvoice, never a lineless update.
 */
export async function removeInvoiceLine(params: { invoiceId: string; lineId: string }): Promise<RemovalWriteResult> {
  const attempt = async (): Promise<RemovalWriteResult> => {
    const fetched = await qbApiRequest<{ Invoice: RawInvoice }>({ path: `/invoice/${params.invoiceId}` })
    const inv = fetched.Invoice
    const before = cents(inv.TotalAmt)
    const has = (inv.Line ?? []).some((l) => String(l.Id) === String(params.lineId) && l.DetailType === 'SalesItemLineDetail')
    if (!has) return { ok: true, idempotent: true, invoiceId: String(inv.Id), invoiceNumber: inv.DocNumber ?? null, totalCentsBefore: before, totalCentsAfter: before }
    const nextLines = (inv.Line ?? []).filter((l) => !(String(l.Id) === String(params.lineId) && l.DetailType === 'SalesItemLineDetail'))
    const remainingSales = nextLines.filter((l) => l.DetailType === 'SalesItemLineDetail').length
    if (remainingSales === 0) return { ok: false, error: 'refusing to remove the last line — use void', invoiceId: String(inv.Id), invoiceNumber: inv.DocNumber ?? null }
    const res = await qbApiRequest<{ Invoice: RawInvoice }>({ method: 'POST', path: '/invoice', body: { ...inv, Line: nextLines, sparse: false } })
    logger.info(APP, 'invoice.line_removed', { id: res.Invoice.Id, docNumber: res.Invoice.DocNumber, lineId: params.lineId, totalBefore: before, totalAfter: cents(res.Invoice.TotalAmt) })
    return { ok: true, invoiceId: String(res.Invoice.Id), invoiceNumber: res.Invoice.DocNumber ?? null, totalCentsBefore: before, totalCentsAfter: cents(res.Invoice.TotalAmt) }
  }
  try { return await attempt() }
  catch {
    try { return await attempt() }                 // one retry for a stale SyncToken (409)
    catch (e2) {
      logger.error(APP, 'invoice.line_remove_failed', { invoiceId: params.invoiceId, lineId: params.lineId, error: String(e2) })
      return { ok: false, error: String((e2 as Error)?.message ?? e2) }
    }
  }
}

/**
 * Void an entire standalone invoice (operation=void). Idempotent: if already voided, reports
 * success without writing. One retry on a stale SyncToken. Never deletes — see the module note.
 */
export async function voidInvoice(params: { invoiceId: string }): Promise<RemovalWriteResult> {
  const attempt = async (): Promise<RemovalWriteResult> => {
    const fetched = await qbApiRequest<{ Invoice: RawInvoice }>({ path: `/invoice/${params.invoiceId}` })
    const inv = fetched.Invoice
    const before = cents(inv.TotalAmt)
    if (isVoided(inv)) return { ok: true, idempotent: true, invoiceId: String(inv.Id), invoiceNumber: inv.DocNumber ?? null, totalCentsBefore: before, totalCentsAfter: 0 }
    const res = await qbApiRequest<{ Invoice: RawInvoice }>({
      method: 'POST', path: '/invoice', query: { operation: 'void' },
      body: { Id: inv.Id, SyncToken: inv.SyncToken },
    })
    logger.info(APP, 'invoice.voided', { id: res.Invoice.Id, docNumber: res.Invoice.DocNumber, totalBefore: before })
    return { ok: true, invoiceId: String(res.Invoice.Id), invoiceNumber: res.Invoice.DocNumber ?? null, totalCentsBefore: before, totalCentsAfter: cents(res.Invoice.TotalAmt) }
  }
  try { return await attempt() }
  catch {
    try { return await attempt() }
    catch (e2) {
      logger.error(APP, 'invoice.void_failed', { invoiceId: params.invoiceId, error: String(e2) })
      return { ok: false, error: String((e2 as Error)?.message ?? e2) }
    }
  }
}
