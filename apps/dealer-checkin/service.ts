/**
 * Dealer check-in orchestration.
 *
 * One call turns a confirmed tag scan into: a QuickBooks invoice line (appended
 * to the dealership's open, not-yet-sent invoice, or a new invoice) and a Work
 * Board service order — with duplicate protection, the $125 pricing prompt, and
 * a full audit trail. QuickBooks is the source of truth: the target invoice is
 * resolved by a LIVE read every time, never a cached batch status.
 *
 * Nothing is written until this runs (the preview never mutates). On production,
 * the calling route must gate this behind owner approval; on sandbox it runs free.
 */
import { logger } from '@/platform/logger'
import { listDealerships } from '@/apps/vehicle-entry/db'
import { findOrCreateVehicle, createServiceOrder, findActiveOrderByVin } from '@/apps/workflow/db'
import { findAppendableInvoice } from '@/apps/quickbooks/invoices'
import {
  resolveDealerDetailItem,
  resolveDueOnReceiptTermId,
  createDealerInvoice,
  appendDealerLine,
  getInvoiceLineDescriptions,
} from '@/apps/quickbooks/invoice-write'
import {
  extractStockPrefix,
  formatLineDescription,
  decidePricing,
  normalizeStock,
  STANDARD_RATE,
} from './rules'
import { createScan, updateScan, recentScansByStock, logScanEvent, listQueuedScans } from './db'
import type { DealerScanRow } from './db'

const APP = 'dealer-checkin:service'

export interface CheckInInput {
  vin?:             string | null
  vinSource?:       string | null
  vinConfidence?:   number | null
  stockNumber?:     string | null
  stockSource?:     string | null
  stockConfidence?: number | null
  year?:            string | null
  make?:            string | null
  model?:           string | null
  color?:           string | null
  tagColor?:        string | null
  photoUrl?:        string | null
  cropUrl?:         string | null
  dealershipId?:    string | null
  /** Explicit rate — required when a pricing prompt is triggered. */
  rate?:            number | null
  approvedBy?:      string | null
  dataType?:        'production' | 'pilot' | 'test'
  /** Proceed despite a detected duplicate. */
  force?:           boolean
  /** Client-measured time from camera-ready to confirm, for instrumentation. */
  scanDurationMs?:  number | null
}

export type CheckInOutcome =
  | 'created_invoice'
  | 'appended'
  | 'queued'
  | 'pricing_prompt_required'
  | 'duplicate'
  | 'no_dealer'
  | 'error'

export interface CheckInResult {
  ok:        boolean
  outcome:   CheckInOutcome
  scanId:    string
  dealership?: { id: string; name: string; qbCustomerId: string | null }
  pricing?:  { promptRequired: boolean; signals: string[]; standardRate: number; newVehicleRate: number }
  invoice?:  { id: string; number: string | null; action: 'created' | 'appended'; lineCount: number; rate: number }
  serviceOrderId?: string
  vehicleId?: string
  duplicate?: { reason: string; existingInvoiceNumber?: string | null; existingOrderId?: string }
  warnings?: string[]
  error?:    string
}

async function resolveDealer(input: CheckInInput) {
  const all = await listDealerships(false)
  if (input.dealershipId) return all.find((d) => d.id === input.dealershipId) ?? null
  const prefix = extractStockPrefix(input.stockNumber)
  if (!prefix) return null
  return all.find((d) => d.stockPrefix.toUpperCase() === prefix) ?? null
}

export interface CheckInPreview {
  ok:          boolean
  dealership:  { id: string; name: string; qbCustomerId: string | null } | null
  vehicle:     { year?: string | null; make?: string | null; model?: string | null; color?: string | null; vin?: string | null; stockNumber?: string | null }
  linePreview: string
  pricing:     { promptRequired: boolean; signals: string[]; standardRate: number; newVehicleRate: number; defaultRate: number }
  invoiceTarget: { action: 'append' | 'create'; invoiceNumber?: string | null; invoiceId?: string }
  duplicate:   { reason: string; existingInvoiceNumber?: string | null; existingOrderId?: string } | null
  warnings:    string[]
}

/**
 * Read-only preview for the confirmation screen. Resolves dealer, pricing,
 * duplicate status, and the target invoice WITHOUT writing anything to
 * QuickBooks or the database. The UI calls this to render the preview, then
 * calls checkInDealerVehicle on "Looks Good".
 */
export async function previewDealerCheckIn(input: CheckInInput): Promise<CheckInPreview> {
  const warnings: string[] = []
  const dealer = await resolveDealer(input)
  const pricing = decidePricing({ stockNumber: input.stockNumber, tagColor: input.tagColor })
  const linePreview = formatLineDescription(input)
  const vehicle = { year: input.year, make: input.make, model: input.model, color: input.color, vin: input.vin, stockNumber: input.stockNumber }

  if (!dealer) {
    const prefix = extractStockPrefix(input.stockNumber)
    warnings.push(prefix ? `No dealership for stock prefix "${prefix}"` : 'No stock number — pick a dealership')
    return { ok: false, dealership: null, vehicle, linePreview,
      pricing: { ...pricing }, invoiceTarget: { action: 'create' }, duplicate: null, warnings }
  }
  const dealership = { id: dealer.id, name: dealer.name, qbCustomerId: dealer.qbCustomerId ?? null }
  if (!dealer.qbCustomerId) {
    warnings.push(`${dealer.name} has no QuickBooks customer mapping`)
    return { ok: false, dealership, vehicle, linePreview,
      pricing: { ...pricing }, invoiceTarget: { action: 'create' }, duplicate: null, warnings }
  }

  // Duplicate (read-only)
  let duplicate: CheckInPreview['duplicate'] = null
  if (input.vin) {
    const activeOrder = await findActiveOrderByVin(input.vin)
    if (activeOrder) duplicate = { reason: `VIN ${input.vin} already on the Work Board`, existingOrderId: activeOrder.id }
  }
  if (!duplicate && input.stockNumber) {
    const recent = await recentScansByStock(input.stockNumber)
    if (recent[0]) duplicate = { reason: `Stock ${input.stockNumber} checked in within 7 days`, existingInvoiceNumber: recent[0].qbInvoiceNumber }
  }

  // Target invoice (live read)
  const appendable = await findAppendableInvoice(dealer.qbCustomerId)
  if (!duplicate && input.stockNumber && appendable) {
    const descriptions = await getInvoiceLineDescriptions(appendable.id)
    const token = `#${normalizeStock(input.stockNumber)}`
    if (descriptions.some((d) => d.toUpperCase().includes(token))) {
      duplicate = { reason: `Stock ${input.stockNumber} already on invoice ${appendable.docNumber}`, existingInvoiceNumber: appendable.docNumber }
    }
  }
  const invoiceTarget = appendable
    ? { action: 'append' as const, invoiceNumber: appendable.docNumber, invoiceId: appendable.id }
    : { action: 'create' as const }

  return { ok: !duplicate, dealership, vehicle, linePreview, pricing: { ...pricing }, invoiceTarget, duplicate, warnings }
}

export async function checkInDealerVehicle(input: CheckInInput): Promise<CheckInResult> {
  const dataType = input.dataType ?? 'production'

  // ── 1. Record the scan (pending) ──────────────────────────────────────────
  const scan: DealerScanRow = await createScan({
    dealershipId:    input.dealershipId ?? null,
    vin:             input.vin ?? null,
    vinSource:       input.vinSource ?? null,
    vinConfidence:   input.vinConfidence ?? null,
    stockNumber:     input.stockNumber ?? null,
    stockSource:     input.stockSource ?? null,
    stockConfidence: input.stockConfidence ?? null,
    year:            input.year ?? null,
    make:            input.make ?? null,
    model:           input.model ?? null,
    color:           input.color ?? null,
    tagColor:        input.tagColor ?? null,
    photoUrl:        input.photoUrl ?? null,
    cropUrl:         input.cropUrl ?? null,
    dataType,
    status:          'pending',
  })
  await logScanEvent({ scanId: scan.id, eventType: 'scanned', actor: input.approvedBy ?? null, newValue: { stockNumber: input.stockNumber, vin: input.vin } })

  const fail = async (outcome: CheckInOutcome, patch: Partial<CheckInResult>, note: string): Promise<CheckInResult> => {
    await updateScan(scan.id, { status: outcome === 'duplicate' ? 'duplicate_skipped' : 'error', qbSyncError: note })
    await logScanEvent({ scanId: scan.id, eventType: outcome === 'duplicate' ? 'duplicate_detected' : 'error', note })
    return { ok: false, outcome, scanId: scan.id, ...patch }
  }

  try {
    // ── 2. Resolve dealership ─────────────────────────────────────────────
    const dealer = await resolveDealer(input)
    if (!dealer) {
      const prefix = extractStockPrefix(input.stockNumber)
      return await fail('no_dealer', {}, prefix ? `No dealership for stock prefix "${prefix}"` : 'No stock number or dealership')
    }
    if (!dealer.qbCustomerId) {
      return await fail('error', { dealership: { id: dealer.id, name: dealer.name, qbCustomerId: null } }, `${dealer.name} has no QuickBooks customer mapping`)
    }
    const dealership = { id: dealer.id, name: dealer.name, qbCustomerId: dealer.qbCustomerId }

    // ── 3. Pricing decision (prompt gate) ─────────────────────────────────
    const pricing = decidePricing({ stockNumber: input.stockNumber, tagColor: input.tagColor })
    const pricingOut = {
      promptRequired: pricing.promptRequired, signals: pricing.signals,
      standardRate: pricing.standardRate, newVehicleRate: pricing.newVehicleRate,
    }
    if (pricing.promptRequired && (input.rate == null)) {
      await updateScan(scan.id, { pricingPromptShown: true })
      await logScanEvent({ scanId: scan.id, eventType: 'pricing_prompted', newValue: { signals: pricing.signals } })
      return { ok: false, outcome: 'pricing_prompt_required', scanId: scan.id, dealership, pricing: pricingOut }
    }
    const rate = input.rate ?? STANDARD_RATE

    // ── 4. Duplicate protection ───────────────────────────────────────────
    if (!input.force) {
      if (input.vin) {
        const activeOrder = await findActiveOrderByVin(input.vin)
        if (activeOrder) {
          return await fail('duplicate', { dealership, duplicate: { reason: `VIN ${input.vin} already on the Work Board`, existingOrderId: activeOrder.id } }, 'duplicate VIN on work board')
        }
      }
      if (input.stockNumber) {
        const recent = await recentScansByStock(input.stockNumber)
        const priorWithInvoice = recent.find((r) => r.id !== scan.id)
        if (priorWithInvoice) {
          return await fail('duplicate', { dealership, duplicate: { reason: `Stock ${input.stockNumber} checked in within 7 days`, existingInvoiceNumber: priorWithInvoice.qbInvoiceNumber } }, 'duplicate stock recent scan')
        }
      }
    }

    // ── 5. Resolve target invoice (LIVE) + item/terms ─────────────────────
    await logScanEvent({ scanId: scan.id, eventType: 'invoice_status_checked' })
    const itemId = await resolveDealerDetailItem()
    const termId = await resolveDueOnReceiptTermId()
    const appendable = await findAppendableInvoice(dealership.qbCustomerId)

    // QB-side duplicate: same stock number already on the open invoice
    if (!input.force && input.stockNumber && appendable) {
      const descriptions = await getInvoiceLineDescriptions(appendable.id)
      const stockToken = `#${normalizeStock(input.stockNumber)}`
      const already = descriptions.some((d) => d.toUpperCase().includes(stockToken))
      if (already) {
        return await fail('duplicate', { dealership, duplicate: { reason: `Stock ${input.stockNumber} already on invoice ${appendable.docNumber}`, existingInvoiceNumber: appendable.docNumber } }, 'duplicate stock on open invoice')
      }
    }

    const line = {
      description: formatLineDescription(input),
      amount:      rate,
      serviceDate: new Date().toISOString().slice(0, 10),
    }

    // ── 6. Write to QuickBooks (queue on failure — never lose the scan) ───
    const action: 'created' | 'appended' = appendable ? 'appended' : 'created'
    let invoiceResult: { invoiceId: string; invoiceNumber: string | null; lineCount: number } | null = null
    let queued = false
    let qbError: string | null = null
    const qbStart = Date.now()
    try {
      if (appendable) {
        invoiceResult = await appendDealerLine({ invoiceId: appendable.id, itemId, line })
        await logScanEvent({ scanId: scan.id, eventType: 'qb_synced', newValue: { invoiceId: invoiceResult.invoiceId, action, lineCount: invoiceResult.lineCount } })
      } else {
        invoiceResult = await createDealerInvoice({ customerId: dealership.qbCustomerId, itemId, salesTermId: termId, line })
        await logScanEvent({ scanId: scan.id, eventType: 'invoice_created', newValue: { invoiceId: invoiceResult.invoiceId, number: invoiceResult.invoiceNumber } })
        await logScanEvent({ scanId: scan.id, eventType: 'qb_synced', newValue: { invoiceId: invoiceResult.invoiceId, action, lineCount: invoiceResult.lineCount } })
      }
    } catch (err) {
      // QuickBooks unavailable → queue the invoice; the vehicle still goes on the board.
      queued = true
      qbError = String(err)
      await logScanEvent({ scanId: scan.id, eventType: 'qb_queued', note: qbError })
      logger.warn(APP, 'checkin.qb_queued', { scanId: scan.id, error: qbError })
    }
    const qbLatencyMs = Date.now() - qbStart

    // ── 7. Work Board entry (always — so the vehicle appears immediately) ──
    const vehicle = await findOrCreateVehicle({ vin: input.vin, year: input.year, make: input.make, model: input.model, color: input.color })
    const invoiceLabel = queued ? 'PENDING SYNC' : (invoiceResult?.invoiceNumber ?? invoiceResult?.invoiceId ?? 'n/a')
    const order = await createServiceOrder({
      vehicleId:   vehicle.id,
      source:      'dealer',
      serviceType: 'dealer_detail',
      checkedInBy: input.approvedBy ?? undefined,
      notes:       `Stock: ${input.stockNumber ?? 'n/a'} | Invoice: ${invoiceLabel} | ${dealership.name}`,
    })
    await logScanEvent({ scanId: scan.id, eventType: 'work_board_created', newValue: { serviceOrderId: order.id, orderNumber: order.orderNumber } })

    // ── 8. Finalize scan ──────────────────────────────────────────────────
    await updateScan(scan.id, {
      status:          'approved',
      approvedAt:      new Date(),
      approvedBy:      input.approvedBy ?? null,
      rate,
      qbInvoiceNumber: invoiceResult?.invoiceNumber ?? null,
      qbSyncStatus:    queued ? 'queued' : 'synced',
      qbSyncError:     qbError,
      qbSyncedAt:      queued ? null : new Date(),
      serviceOrderId:  order.id,
      scanDurationMs:  input.scanDurationMs ?? null,
      qbLatencyMs,
    })
    await logScanEvent({ scanId: scan.id, eventType: 'approved', actor: input.approvedBy ?? null, newValue: { rate, invoice: invoiceLabel, queued } })

    logger.info(APP, 'checkin.success', { scanId: scan.id, dealer: dealership.name, action, invoice: invoiceLabel, rate, queued, qbLatencyMs })

    return {
      ok: true,
      outcome: queued ? 'queued' : (action === 'created' ? 'created_invoice' : 'appended'),
      scanId: scan.id,
      dealership,
      pricing: pricingOut,
      invoice: invoiceResult
        ? { id: invoiceResult.invoiceId, number: invoiceResult.invoiceNumber, action, lineCount: invoiceResult.lineCount, rate }
        : undefined,
      serviceOrderId: order.id,
      vehicleId: vehicle.id,
      warnings: queued ? ['QuickBooks was unavailable — invoice queued and will sync automatically.'] : undefined,
    }
  } catch (err) {
    logger.error(APP, 'checkin.error', { scanId: scan.id, error: String(err) })
    return await fail('error', {}, String(err))
  }
}

export interface RetryResult {
  processed: number
  synced:    number
  stillQueued: number
  details:   Array<{ scanId: string; result: 'synced' | 'failed' | 'skipped'; invoice?: string | null; error?: string }>
}

/**
 * Drain the queue of check-ins whose QuickBooks write failed. For each queued
 * scan, re-resolve the dealer + target invoice and write the line; on success
 * mark it synced. Safe to run repeatedly (e.g., on a cron). Idempotency guard:
 * if the stock is already on the open invoice, mark synced without re-writing.
 */
export async function retryQueuedCheckIns(limit = 50): Promise<RetryResult> {
  const queued = await listQueuedScans(limit)
  const details: RetryResult['details'] = []
  let synced = 0

  for (const scan of queued) {
    try {
      const dealer = await resolveDealer({ dealershipId: scan.dealershipId, stockNumber: scan.stockNumber })
      if (!dealer?.qbCustomerId) {
        details.push({ scanId: scan.id, result: 'skipped', error: 'no dealer/QB mapping' })
        continue
      }
      const itemId = await resolveDealerDetailItem()
      const termId = await resolveDueOnReceiptTermId()
      const appendable = await findAppendableInvoice(dealer.qbCustomerId)
      const line = {
        description: formatLineDescription(scan),
        amount:      scan.rate ?? STANDARD_RATE,
        serviceDate: (scan.createdAt instanceof Date ? scan.createdAt : new Date()).toISOString().slice(0, 10),
      }

      // Idempotency: skip the write if the stock is already on the open invoice.
      let written
      if (scan.stockNumber && appendable) {
        const descriptions = await getInvoiceLineDescriptions(appendable.id)
        if (descriptions.some((d) => d.toUpperCase().includes(`#${normalizeStock(scan.stockNumber)}`))) {
          written = { invoiceNumber: appendable.docNumber }
        }
      }
      if (!written) {
        written = appendable
          ? await appendDealerLine({ invoiceId: appendable.id, itemId, line })
          : await createDealerInvoice({ customerId: dealer.qbCustomerId, itemId, salesTermId: termId, line })
      }

      await updateScan(scan.id, { qbSyncStatus: 'synced', qbInvoiceNumber: written.invoiceNumber, qbSyncError: null, qbSyncedAt: new Date() })
      await logScanEvent({ scanId: scan.id, eventType: 'qb_synced', note: 'retry', newValue: { invoice: written.invoiceNumber } })
      synced++
      details.push({ scanId: scan.id, result: 'synced', invoice: written.invoiceNumber })
    } catch (err) {
      await logScanEvent({ scanId: scan.id, eventType: 'error', note: 'retry failed: ' + String(err) })
      details.push({ scanId: scan.id, result: 'failed', error: String(err) })
    }
  }

  return { processed: queued.length, synced, stillQueued: queued.length - synced, details }
}
