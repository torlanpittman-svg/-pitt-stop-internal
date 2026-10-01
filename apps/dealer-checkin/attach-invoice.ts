/**
 * Attach (or recover) a QuickBooks dealer invoice line for an EXISTING Work Board
 * job — without creating a second job or a duplicate invoice line.
 *
 * Why this exists: normal dealer intake (checkInDealerVehicle) writes the invoice
 * and creates the Job atomically. A Job created another way (a no-photo manual
 * board entry, or a check-in where QB was down and the write queued) has no linked
 * invoice yet. This closes that gap idempotently:
 *
 *   1. ENV GUARD   — never link a sandbox invoice to a production job.
 *   2. IDEMPOTENT  — if the Job already has a synced invoice, return it, write nothing.
 *   3. RECOVER     — before writing, scan the dealer's live invoices for this stock
 *                    (#STOCK). If a prior attempt already wrote the line but failed to
 *                    persist the link, link to THAT invoice — never charge twice.
 *   4. WRITE       — else append to the eligible open+unsent invoice, or create a new one.
 *   5. LINK        — persist the QB invoice onto a dealer_scans row bound to the Job
 *                    (the established linkage rail) + annotate the Job notes.
 *
 * Never sends/emails the invoice. QuickBooks is the source of truth: the target is
 * resolved by a LIVE read every time.
 */
import { logger } from '@/platform/logger'
import { getEnvironment } from '@/apps/quickbooks/config'
import { listDealerships } from '@/apps/vehicle-entry/db'
import { getOrderWithContext, appendOrderNote } from '@/apps/workflow/db'
import { findAppendableInvoice, listInvoicesForCustomer } from '@/apps/quickbooks/invoices'
import { reconcileCustomerEmail } from '@/apps/quickbooks/customers'
import {
  resolveDealerDetailItem,
  resolveDueOnReceiptTermId,
  createDealerInvoice,
  appendDealerLine,
  getInvoiceLineDescriptions,
} from '@/apps/quickbooks/invoice-write'
import { formatLineDescription, STANDARD_RATE } from './rules'
import {
  createScan,
  updateScan,
  getScanByServiceOrderId,
  logScanEvent,
  type NewDealerScan,
  type DealerScanRow,
} from './db'
import {
  canLinkInvoice,
  parseStockFromNotes,
  resolveDealerForOrder,
  findStockLineInvoice,
  decideAttachAction,
  type InvoiceLineView,
} from './attach-rules'

const APP = 'dealer-checkin:attach'

/** How many of the dealer's most-recent invoices to scan for an existing stock line. */
const RECOVERY_SCAN_LIMIT = 30

export interface AttachInput {
  serviceOrderId: string
  /** Line rate; defaults to the dealer's configured rate, else the $200 standard. */
  rate?: number | null
  approvedBy?: string | null
  /** Test-only: allow running against a non-production QB environment. NEVER set in prod. */
  allowNonProduction?: boolean
}

export type AttachOutcome =
  | 'already_linked'
  | 'recovered'
  | 'appended'
  | 'created'
  | 'written_pending_link'
  | 'order_not_found'
  | 'order_inactive'
  | 'no_dealer'
  | 'no_qb_customer'
  | 'environment_blocked'
  | 'error'

export type AttachInvoiceStatus = 'linked' | 'pending' | 'failed'

export interface AttachResult {
  ok: boolean
  outcome: AttachOutcome
  serviceOrderId: string
  invoiceStatus: AttachInvoiceStatus
  invoiceNumber?: string | null
  invoiceId?: string
  action?: 'appended' | 'created' | 'recovered' | 'already_linked'
  lineAmount?: number
  dealership?: { id: string; name: string; qbCustomerId: string | null }
  warnings?: string[]
  error?: string
}

const TERMINAL = ['delivered', 'cancelled']

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function attachInvoiceForOrder(input: AttachInput): Promise<AttachResult> {
  const sid = input.serviceOrderId
  const base = { serviceOrderId: sid }

  // ── 1. Environment guard (before any I/O) ───────────────────────────────
  const env = getEnvironment()
  const guard = canLinkInvoice(env, input.allowNonProduction ?? false)
  if (!guard.ok) {
    logger.warn(APP, 'attach.env_blocked', { sid, env })
    return { ...base, ok: false, outcome: 'environment_blocked', invoiceStatus: 'pending', error: guard.reason }
  }

  // ── Load the Job ────────────────────────────────────────────────────────
  const order = await getOrderWithContext(sid)
  if (!order) return { ...base, ok: false, outcome: 'order_not_found', invoiceStatus: 'pending', error: 'Service order not found' }
  if (TERMINAL.includes(order.status)) {
    return { ...base, ok: false, outcome: 'order_inactive', invoiceStatus: 'pending', error: `Order status "${order.status}" is terminal` }
  }

  // ── 2. Idempotency: already linked? ─────────────────────────────────────
  const existingScan = await getScanByServiceOrderId(sid)
  if (existingScan?.qbInvoiceNumber && existingScan.qbSyncStatus === 'synced') {
    return {
      ...base, ok: true, outcome: 'already_linked', action: 'already_linked', invoiceStatus: 'linked',
      invoiceNumber: existingScan.qbInvoiceNumber, lineAmount: existingScan.rate ?? undefined,
    }
  }

  // ── Resolve dealer + vehicle line ───────────────────────────────────────
  const stock = parseStockFromNotes(order.notes)
  const dealers = await listDealerships(false)
  const dealer = resolveDealerForOrder({ stock, customerName: order.customerName }, dealers)
  if (!dealer) {
    return { ...base, ok: false, outcome: 'no_dealer', invoiceStatus: 'pending', error: 'Could not resolve a dealership for this job (no stock prefix or matching name)' }
  }
  if (!dealer.qbCustomerId) {
    return {
      ...base, ok: false, outcome: 'no_qb_customer', invoiceStatus: 'pending',
      dealership: { id: dealer.id, name: dealer.name, qbCustomerId: null },
      error: `${dealer.name} has no QuickBooks customer mapping`,
    }
  }
  const dealership = { id: dealer.id, name: dealer.name, qbCustomerId: dealer.qbCustomerId }
  const v = order.vehicle
  const rate = input.rate ?? dealer.rateDefault ?? STANDARD_RATE
  const description = formatLineDescription({ year: v.year, make: v.make, model: v.model, color: v.color, stockNumber: stock })

  try {
    const itemId = await resolveDealerDetailItem()
    const termId = await resolveDueOnReceiptTermId()

    // ── 3. Recovery / "already on a live invoice?" scan (before writing) ───
    const warnings: string[] = []
    if (stock) {
      const invoices = await listInvoicesForCustomer(dealership.qbCustomerId)
      const scanList = invoices.slice(0, RECOVERY_SCAN_LIMIT)
      if (invoices.length > RECOVERY_SCAN_LIMIT) {
        warnings.push(`Checked the ${RECOVERY_SCAN_LIMIT} most recent invoices for an existing #${stock} line`)
      }
      const views: InvoiceLineView[] = []
      for (const inv of scanList) {
        views.push({ id: inv.id, docNumber: inv.docNumber, descriptions: await getInvoiceLineDescriptions(inv.id) })
      }
      const existingInvoice = findStockLineInvoice(stock, views)
      if (existingInvoice) {
        // Line already exists in QB — link to it, never write again.
        await persistLink({ order, dealer, stock, v, rate, invoiceNumber: existingInvoice.docNumber, approvedBy: input.approvedBy ?? null, env, recovered: true, existingScan })
        await appendOrderNote(sid, `Invoice: ${existingInvoice.docNumber ?? existingInvoice.id} (recovered ${today()})`)
        logger.info(APP, 'attach.recovered', { sid, dealer: dealership.name, invoice: existingInvoice.docNumber })
        return {
          ...base, ok: true, outcome: 'recovered', action: 'recovered', invoiceStatus: 'linked',
          invoiceNumber: existingInvoice.docNumber, invoiceId: existingInvoice.id, lineAmount: rate, dealership,
          warnings: warnings.length ? warnings : undefined,
        }
      }
    }

    // Dealer billing email: fill-only-when-blank (never overwrite); never sends.
    let billEmail: string | null = null
    try {
      const rec = await reconcileCustomerEmail(dealership.qbCustomerId, dealer.billingEmail ?? null)
      billEmail = rec.billEmail
    } catch (err) {
      logger.warn(APP, 'attach.email_reconcile_failed', { sid, error: String(err) })
    }

    // ── 4. Write to QuickBooks (append to eligible open+unsent, else create) ─
    const appendable = await findAppendableInvoice(dealership.qbCustomerId)
    const action = decideAttachAction(Boolean(appendable))
    const line = { description, amount: rate, serviceDate: today() }
    const written = appendable
      ? await appendDealerLine({ invoiceId: appendable.id, itemId, line, billEmail })
      : await createDealerInvoice({ customerId: dealership.qbCustomerId, itemId, salesTermId: termId, line, billEmail })

    // ── 5. Persist the link (second step). If THIS throws after a successful
    //        write, a retry recovers via step 3 above — so we never double-charge.
    try {
      await persistLink({ order, dealer, stock, v, rate, invoiceNumber: written.invoiceNumber, qbLineId: null, approvedBy: input.approvedBy ?? null, env, recovered: false, existingScan })
      await appendOrderNote(sid, `Invoice: ${written.invoiceNumber ?? written.invoiceId} (${action} ${today()})`)
    } catch (linkErr) {
      logger.error(APP, 'attach.link_failed_after_write', { sid, invoice: written.invoiceNumber, error: String(linkErr) })
      return {
        ...base, ok: false, outcome: 'written_pending_link', invoiceStatus: 'failed',
        invoiceNumber: written.invoiceNumber, invoiceId: written.invoiceId, action, lineAmount: rate, dealership,
        error: 'Invoice line was written in QuickBooks but linking it to the job failed. Retry to recover — it will NOT charge again.',
      }
    }

    logger.info(APP, 'attach.success', { sid, dealer: dealership.name, action, invoice: written.invoiceNumber, rate })
    return {
      ...base, ok: true, outcome: action, action, invoiceStatus: 'linked',
      invoiceNumber: written.invoiceNumber, invoiceId: written.invoiceId, lineAmount: rate, dealership,
      warnings: warnings.length ? warnings : undefined,
    }
  } catch (err) {
    logger.error(APP, 'attach.error', { sid, error: String(err) })
    return { ...base, ok: false, outcome: 'error', invoiceStatus: 'failed', dealership, error: String(err) }
  }
}

/**
 * Persist the QB invoice linkage onto the established dealer_scans rail, bound to
 * the EXISTING Job. Reuses the Job's existing scan row (e.g. a queued check-in) if
 * there is one, else creates a scan dedicated to this attachment.
 */
async function persistLink(a: {
  order: { id: string }
  dealer: { id: string }
  stock: string | null
  v: { year: string | null; make: string | null; model: string | null; color: string | null }
  rate: number
  invoiceNumber: string | null
  qbLineId?: string | null
  approvedBy: string | null
  env: string
  recovered: boolean
  existingScan: DealerScanRow | null
}): Promise<string> {
  const patch: Partial<NewDealerScan> = {
    status: 'approved',
    stockNumber: a.stock,
    stockSource: a.recovered ? 'recovered_attach' : 'manual_attach',
    dealershipId: a.dealer.id,
    year: a.v.year, make: a.v.make, model: a.v.model, color: a.v.color,
    rate: a.rate,
    qbInvoiceNumber: a.invoiceNumber,
    qbLineId: a.qbLineId ?? null,
    qbSyncStatus: 'synced',
    qbSyncedAt: new Date(),
    qbSyncError: null,
    serviceOrderId: a.order.id,
    approvedBy: a.approvedBy,
    approvedAt: new Date(),
    dataType: 'production',
  }
  const eventType = a.recovered ? 'invoice_recovered' : 'invoice_attached'
  if (a.existingScan) {
    await updateScan(a.existingScan.id, patch)
    await logScanEvent({ scanId: a.existingScan.id, eventType, actor: a.approvedBy, newValue: { invoice: a.invoiceNumber, env: a.env } })
    return a.existingScan.id
  }
  const row = await createScan(patch as NewDealerScan)
  await logScanEvent({ scanId: row.id, eventType, actor: a.approvedBy, newValue: { invoice: a.invoiceNumber, env: a.env } })
  return row.id
}

/** Read-only invoice status for a Job (for the Work Board + retry UI). */
export async function dealerInvoiceStatusForOrder(serviceOrderId: string): Promise<{
  status: 'none' | 'pending' | 'queued' | 'linked' | 'failed'
  invoiceNumber: string | null
}> {
  const scan = await getScanByServiceOrderId(serviceOrderId)
  const { mapInvoiceStatus } = await import('./attach-rules')
  return { status: mapInvoiceStatus(scan), invoiceNumber: scan?.qbInvoiceNumber ?? null }
}

/**
 * Read-only LIVE verification: fetch the linked invoice back from QuickBooks and
 * confirm the job's stock line is actually on it (proves the write, not just the
 * DB linkage). Returns null when the job has no linked invoice yet.
 */
export async function verifyInvoiceLineForOrder(serviceOrderId: string): Promise<{
  invoiceNumber: string | null
  invoiceId: string | null
  hasStockLine: boolean
  matchedLine: string | null
  lines: string[]
} | null> {
  const scan = await getScanByServiceOrderId(serviceOrderId)
  if (!scan?.qbInvoiceNumber || !scan.dealershipId) return null
  const dealers = await listDealerships(false)
  const dealer = dealers.find((d) => d.id === scan.dealershipId)
  if (!dealer?.qbCustomerId) return null
  const invoices = await listInvoicesForCustomer(dealer.qbCustomerId)
  const match = invoices.find((inv) => inv.docNumber === scan.qbInvoiceNumber)
  if (!match) {
    return { invoiceNumber: scan.qbInvoiceNumber, invoiceId: null, hasStockLine: false, matchedLine: null, lines: [] }
  }
  const lines = await getInvoiceLineDescriptions(match.id)
  const token = scan.stockNumber ? `#${scan.stockNumber.trim().toUpperCase()}` : null
  const matchedLine = token ? (lines.find((l) => l.toUpperCase().includes(token)) ?? null) : null
  return { invoiceNumber: scan.qbInvoiceNumber, invoiceId: match.id, hasStockLine: Boolean(matchedLine), matchedLine, lines }
}
