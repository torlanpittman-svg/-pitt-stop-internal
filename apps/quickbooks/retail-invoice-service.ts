/**
 * Retail QuickBooks invoice CREATE orchestration (P-D3.1). No send, no email.
 *
 * Idempotency (approved P-D3.0 design), duplicate-proof under double-taps / retries /
 * crashes:
 *   1. local qb_invoice_id present → return existing state, never create again
 *   2. compare-and-set qb_status='creating' WHERE qb_invoice_id IS NULL (one winner)
 *   3. PSID adoption — scan the customer's recent invoices for PSID:<estimateId> and adopt
 *      (covers "QB create succeeded but the local DB write was lost")
 *   4. partial UNIQUE index on qb_invoice_id is the DB backstop
 *
 * The QB invoice is built ONLY from the authoritative Invoice Draft; the invariant
 * TotalAmt === draft total_cents is enforced pre-write (payload builder throws on mismatch)
 * and re-checked post-write. Dealer invoicing is untouched.
 */
import crypto from 'node:crypto'
import { and, eq, isNull, inArray, desc } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { jobEstimates } from '@/apps/workflow/schema'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { getOrderWithContext, logEvent } from '@/apps/workflow/db'
import { getEstimateRow, getFullEstimate } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { isDealerOrder } from '@/apps/workflow/fees'
import { lineAmountCents } from '@/apps/workflow/estimate'
import { getBusinessConfig, shopSuppliesLabel } from '@/apps/settings/db'
import { buildRetailPayload, RetailTotalMismatchError } from './retail-invoice'
import { resolveRetailCustomer } from './retail-customer'
import { resolveRetailItems, createRetailInvoiceInQB, findRetailInvoiceByPsid } from './retail-invoice-write'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:retail-invoice-service'

export interface CreateRetailResult {
  ok: boolean
  status: 'created' | 'creating' | 'error' | 'refused'
  invoiceId?: string | null
  invoiceNumber?: string | null
  totalCents?: number
  matchedBy?: string
  adopted?: boolean
  alreadyExisted?: boolean
  error?: string
}

const safeErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

async function jobContact(orderId: string, fallbackName: string) {
  const [row] = await getDb().select({ name: quickEntryJobs.customerName, email: quickEntryJobs.customerEmail, phone: quickEntryJobs.customerPhone })
    .from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, orderId)).orderBy(desc(quickEntryJobs.createdAt)).limit(1)
  return { name: (row?.name || fallbackName || 'Customer').trim(), email: row?.email ?? null, phone: row?.phone ?? null }
}

export async function createRetailQBInvoice(params: { orderId: string; actor: string | null; requestId?: string | null }): Promise<CreateRetailResult> {
  const { orderId, actor } = params
  const requestId = params.requestId ?? null
  const db = getDb()

  const est0 = await getEstimateRow(orderId)
  if (!est0) return { ok: false, status: 'refused', error: 'No estimate for this Job.' }
  // (1) Local guard — already created.
  if (est0.qbInvoiceId) {
    return { ok: true, status: 'created', invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, alreadyExisted: true }
  }

  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, status: 'refused', error: 'Job not found.' }
  if (isDealerOrder(order)) return { ok: false, status: 'refused', error: 'Dealer Jobs are invoiced through Dealer Check-In.' }

  const [full, cfg] = await Promise.all([getFullEstimate(orderId), getBusinessConfig()])
  const draft = buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: 'admin' })
  if (!draft.priced) return { ok: false, status: 'refused', error: 'Add a Work Price before invoicing.' }

  // (2) Compare-and-set lock — only one creator proceeds.
  const locked = await db.update(jobEstimates)
    .set({ qbStatus: 'creating', qbLastRequestId: requestId, updatedAt: new Date() })
    .where(and(eq(jobEstimates.id, est0.id), isNull(jobEstimates.qbInvoiceId), inArray(jobEstimates.qbStatus, ['none', 'error'])))
    .returning({ id: jobEstimates.id })
  if (locked.length === 0) {
    const fresh = await getEstimateRow(orderId)
    if (fresh?.qbInvoiceId) return { ok: true, status: 'created', invoiceId: fresh.qbInvoiceId, invoiceNumber: fresh.qbInvoiceNumber, alreadyExisted: true }
    return { ok: false, status: 'creating', error: 'A QuickBooks invoice is already being created for this Job.' }
  }

  const markError = async (msg: string, patch: Record<string, unknown> = {}) => {
    await db.update(jobEstimates).set({ qbStatus: 'error', qbSyncError: msg, updatedAt: new Date(), ...patch }).where(eq(jobEstimates.id, est0.id))
    await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_error', employeeName: actor, note: msg }).catch(() => {})
  }

  try {
    // Build work lines from the authoritative record: flat → one line; itemized → per service.
    const userServices = (full?.services ?? []).filter((s) => s.source !== 'system')
    let workLines: { description: string; amountCents: number }[]
    if (est0.priceMode === 'explicit_pretax') {
      workLines = [{ description: (draft.services ?? []).join('\n') || 'Detailing services', amountCents: draft.workPriceCents }]
    } else {
      workLines = userServices
        .map((s) => { const l = s.lines.find((x) => !x.generated); return l ? { description: s.title, amountCents: lineAmountCents(l.priceCents, l.qty) } : null })
        .filter((x): x is { description: string; amountCents: number } => !!x && x.amountCents >= 0)
      if (workLines.length === 0) workLines = [{ description: (draft.services ?? []).join('\n') || 'Detailing services', amountCents: draft.workPriceCents }]
    }

    const v = order.vehicle
    const vehicle = { year: v.year, make: v.make, model: v.model, vin: v.vin }
    // Pure builder — throws RetailTotalMismatchError if Σlines != draft total (invariant).
    const payload = buildRetailPayload({
      estimateId: est0.id, vehicle, workLines,
      shopSuppliesCents: draft.shopSupplies.cents, paymentChargeCents: draft.paymentCharge.cents,
      paymentLabel: draft.paymentCharge.label, shopSuppliesLabel: await shopSuppliesLabel(),
      expectedTotalCents: draft.totalCents,
    })

    // Resolve + cache the QB customer.
    const contact = await jobContact(orderId, draft.customer ?? '')
    const customer = await resolveRetailCustomer(contact)

    // (3) PSID adoption — never duplicate a create that already succeeded in QB.
    const adopted = await findRetailInvoiceByPsid(customer.qbCustomerId, est0.id)
    if (adopted) {
      const hash = contentHash(customer.qbCustomerId, payload)
      await db.update(jobEstimates).set({
        qbInvoiceId: adopted.invoiceId, qbInvoiceNumber: adopted.invoiceNumber, qbSyncToken: adopted.syncToken,
        qbStatus: 'created', qbContentHash: hash, qbSyncedAt: new Date(), qbSyncError: null, updatedAt: new Date(),
      }).where(eq(jobEstimates.id, est0.id))
      await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_created', employeeName: actor, note: `adopted #${adopted.invoiceNumber} (${adopted.invoiceId})` })
      return { ok: true, status: 'created', invoiceId: adopted.invoiceId, invoiceNumber: adopted.invoiceNumber, totalCents: draft.totalCents, matchedBy: customer.matchedBy, adopted: true }
    }

    // Resolve items + create.
    const items = await resolveRetailItems()
    const writeLines = payload.lines.map((l) => ({ itemId: l.itemKind === 'labor' ? items.labor : items.fees, description: l.description, amountCents: l.amountCents }))
    const inv = await createRetailInvoiceInQB({ customerId: customer.qbCustomerId, lines: writeLines, privateNote: payload.privateNote })

    // Post-write invariant — QB TotalAmt must equal the Pitt Stop draft total exactly.
    if (inv.totalAmtCents !== draft.totalCents) {
      const msg = `QuickBooks TotalAmt ${inv.totalAmtCents}¢ != Pitt Stop total ${draft.totalCents}¢`
      // Store the invoice id so we never create a second; flag for manual review/void.
      await markError(msg, { qbInvoiceId: inv.invoiceId, qbInvoiceNumber: inv.invoiceNumber, qbSyncToken: inv.syncToken })
      logger.error(APP, 'total_mismatch', { orderId, invoiceId: inv.invoiceId, qb: inv.totalAmtCents, draft: draft.totalCents })
      return { ok: false, status: 'error', invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, error: msg }
    }

    const hash = contentHash(customer.qbCustomerId, payload)
    await db.update(jobEstimates).set({
      qbInvoiceId: inv.invoiceId, qbInvoiceNumber: inv.invoiceNumber, qbSyncToken: inv.syncToken,
      qbStatus: 'created', qbContentHash: hash, qbSyncedAt: new Date(), qbLastRequestId: requestId,
      qbSyncError: null, updatedAt: new Date(),
    }).where(eq(jobEstimates.id, est0.id))
    await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_created', employeeName: actor, note: `#${inv.invoiceNumber} (${inv.invoiceId}) total $${(draft.totalCents / 100).toFixed(2)} · ${customer.matchedBy}${customer.created ? '+created' : ''}` })
    logger.info(APP, 'created', { orderId, invoiceId: inv.invoiceId, number: inv.invoiceNumber, total: draft.totalCents })
    return { ok: true, status: 'created', invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, totalCents: draft.totalCents, matchedBy: customer.matchedBy }
  } catch (err) {
    const msg = err instanceof RetailTotalMismatchError ? err.message : safeErr(err)
    await markError(msg)
    logger.error(APP, 'create_failed', { orderId, error: msg })
    return { ok: false, status: 'error', error: msg }
  }
}

function contentHash(customerId: string, payload: { lines: unknown; totalCents: number }): string {
  return crypto.createHash('sha256').update(JSON.stringify({ customerId, lines: payload.lines, total: payload.totalCents })).digest('hex')
}
