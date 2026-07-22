/**
 * Invoice sync engine — adds a confirmed vehicle entry to the correct QB invoice.
 *
 * Safety rules enforced here:
 * 1. Only batches with pittStopStatus = 'active' receive vehicles.
 * 2. Dealership is resolved from explicit dealershipId (VIN path) or stock prefix (key-tag path).
 * 3. Duplicate check: same stock # in Pitt Stop DB (same batch) AND in the QB invoice lines.
 * 4. SyncToken is fetched fresh from QB immediately before the update.
 * 5. Invoice is re-fetched after update to verify the line was actually added.
 * 6. All results (success, pending, duplicate, error) are recorded on the entry.
 */

import { getVehicleEntry, updateVehicleEntry, listDealerships } from '@/apps/vehicle-entry/db'
import {
  getActiveBatchForDealership,
  findDuplicateInBatch,
} from '@/apps/vehicle-entry/invoice-db'
import { getQBProvider } from '@/apps/vehicle-entry/qb'
import { logger } from '@/platform/logger'
import type { VehicleEntryRow } from '@/apps/vehicle-entry/db'
import type { SyncOutcome } from '@/apps/vehicle-entry/types'

const LOG = 'vehicle-entry:invoice-sync'

// Extract the dealer prefix from a stock number — always the first letter only.
// "S123456" → "S", "SP100744" → "S", "TJ285137" → "T", "KLO6824" → "K"
function extractStockPrefix(stockNumber: string | null): string | null {
  if (!stockNumber) return null
  return stockNumber.match(/^([A-Za-z])/)?.[1]?.toUpperCase() ?? null
}

// Build the QB invoice line description per the agreed format
export function formatLineDescription(entry: VehicleEntryRow): string {
  const vehicle = [entry.year, entry.make, entry.model].filter(Boolean).join(' ') || 'Unknown Vehicle'
  const color   = entry.color ?? 'Unknown Color'
  const stock   = entry.stockNumber ?? 'Unknown Stock #'
  return `${vehicle} | ${color} | ${stock}`
}

async function resolveDealer(entry: VehicleEntryRow) {
  const all = await listDealerships(false)

  // VIN entries have an explicit dealershipId
  if (entry.dealershipId) {
    return all.find(d => d.id === entry.dealershipId) ?? null
  }

  // Key-tag entries: extract prefix from stock number
  const prefix = extractStockPrefix(entry.stockNumber)
  if (!prefix) return null
  return all.find(d => d.stockPrefix.toUpperCase() === prefix) ?? null
}

export async function syncEntryToInvoice(entryId: string): Promise<SyncOutcome> {
  const entry = await getVehicleEntry(entryId)
  if (!entry) throw new Error('Entry not found')

  // Only production records may sync to QuickBooks
  if (entry.dataType !== 'production') {
    const reason = `"${entry.dataType}" entries cannot sync to QuickBooks`
    await updateVehicleEntry(entryId, {
      status:            'pending_invoice_assignment',
      invoiceSyncStatus: 'pending_invoice_assignment',
      invoiceSyncError:  reason,
    })
    return { outcome: 'pending_invoice_assignment', invoiceNumber: null, dealershipName: null, lineText: null, reason }
  }

  // Idempotency: do not re-sync an already-synced entry
  if (entry.invoiceSyncStatus === 'synced') {
    return {
      outcome:        'synced',
      invoiceNumber:  entry.quickbooksInvoiceId ?? null,
      dealershipName: entry.dealershipName ?? null,
      lineText:       formatLineDescription(entry),
      reason:         'Already synced',
    }
  }

  // ── 1. Resolve dealership ─────────────────────────────────────────────────
  const dealer = await resolveDealer(entry)
  if (!dealer) {
    const prefix = extractStockPrefix(entry.stockNumber)
    const reason = prefix
      ? `No dealership found for stock prefix "${prefix}"`
      : 'No dealership found (no stock number or VIN prefix)'
    logger.info(LOG, 'sync.no_dealer', { entryId, reason })
    await updateVehicleEntry(entryId, {
      status:            'pending_invoice_assignment',
      invoiceSyncStatus: 'pending_invoice_assignment',
      invoiceSyncError:  reason,
    })
    return { outcome: 'pending_invoice_assignment', invoiceNumber: null, dealershipName: null, lineText: null, reason }
  }

  // ── 2. Find active batch ──────────────────────────────────────────────────
  const batch = await getActiveBatchForDealership(dealer.id)
  if (!batch || batch.pittStopStatus !== 'active') {
    const reason = `${dealer.name} has no active invoice batch`
    logger.info(LOG, 'sync.no_active_batch', { entryId, dealerId: dealer.id, reason })
    await updateVehicleEntry(entryId, {
      status:            'pending_invoice_assignment',
      invoiceSyncStatus: 'pending_invoice_assignment',
      invoiceSyncError:  reason,
    })
    return { outcome: 'pending_invoice_assignment', invoiceNumber: null, dealershipName: dealer.name, lineText: null, reason }
  }

  if (!batch.quickbooksInvoiceId) {
    const reason = `Active batch for ${dealer.name} has no QB invoice assigned`
    await updateVehicleEntry(entryId, {
      status:            'pending_invoice_assignment',
      invoiceSyncStatus: 'pending_invoice_assignment',
      invoiceSyncError:  reason,
    })
    return { outcome: 'pending_invoice_assignment', invoiceNumber: null, dealershipName: dealer.name, lineText: null, reason }
  }

  // ── 3. Duplicate check: Pitt Stop DB ─────────────────────────────────────
  if (entry.stockNumber) {
    const dupeId = await findDuplicateInBatch(entryId, entry.stockNumber, batch.id)
    if (dupeId) {
      const reason = `Stock # ${entry.stockNumber} already synced in this batch (entry ${dupeId})`
      logger.warn(LOG, 'sync.duplicate_db', { entryId, dupeId, stockNumber: entry.stockNumber })
      await updateVehicleEntry(entryId, {
        status:            'needs_review',
        invoiceSyncStatus: 'duplicate_skipped',
        invoiceSyncError:  reason,
      })
      return { outcome: 'needs_review', invoiceNumber: batch.quickbooksInvoiceNumber, dealershipName: dealer.name, lineText: null, reason }
    }
  }

  const qb = getQBProvider()

  // ── 4. Fetch QB invoice (get fresh SyncToken) ─────────────────────────────
  let qbInvoice
  try {
    qbInvoice = await qb.fetchInvoice(batch.quickbooksInvoiceId)
  } catch (err) {
    const reason = `Failed to fetch QB invoice: ${String(err)}`
    logger.error(LOG, 'sync.fetch_failed', { entryId, invoiceId: batch.quickbooksInvoiceId, error: String(err) })
    await updateVehicleEntry(entryId, { status: 'quickbooks_error', invoiceSyncStatus: 'error', invoiceSyncError: reason })
    return { outcome: 'error', invoiceNumber: null, dealershipName: dealer.name, lineText: null, reason }
  }

  // ── 5. Duplicate check: QB invoice lines ─────────────────────────────────
  if (entry.stockNumber) {
    const stockUpper   = entry.stockNumber.toUpperCase()
    const alreadyOnInv = qbInvoice.lines.some(l => l.description.toUpperCase().includes(stockUpper))
    if (alreadyOnInv) {
      const reason = `Stock # ${entry.stockNumber} already found on QB invoice ${batch.quickbooksInvoiceNumber}`
      logger.warn(LOG, 'sync.duplicate_qb', { entryId, stockNumber: entry.stockNumber })
      await updateVehicleEntry(entryId, {
        status:            'needs_review',
        invoiceSyncStatus: 'duplicate_skipped',
        invoiceSyncError:  reason,
      })
      return { outcome: 'needs_review', invoiceNumber: batch.quickbooksInvoiceNumber, dealershipName: dealer.name, lineText: null, reason }
    }
  }

  // ── 6. Add line to QB invoice ─────────────────────────────────────────────
  const lineText = formatLineDescription(entry)
  let addResult: { lineId: string; newSyncToken: string }
  try {
    addResult = await qb.addLineToInvoice({
      invoiceId:   batch.quickbooksInvoiceId,
      syncToken:   qbInvoice.syncToken,
      description: lineText,
    })
  } catch (err) {
    const reason = `Failed to add line to QB invoice: ${String(err)}`
    logger.error(LOG, 'sync.add_line_failed', { entryId, error: String(err) })
    await updateVehicleEntry(entryId, { status: 'quickbooks_error', invoiceSyncStatus: 'error', invoiceSyncError: reason })
    return { outcome: 'error', invoiceNumber: batch.quickbooksInvoiceNumber, dealershipName: dealer.name, lineText, reason }
  }

  // ── 7. Verify: re-fetch invoice and confirm line exists ───────────────────
  let verified = false
  try {
    const verifyInvoice = await qb.fetchInvoice(batch.quickbooksInvoiceId)
    verified = verifyInvoice.lines.some(
      l => l.id === addResult.lineId || l.description.toUpperCase().includes((entry.stockNumber ?? '').toUpperCase())
    )
  } catch {
    // Verification fetch failed — treat as unverified but don't overwrite the add
  }

  if (!verified) {
    const reason = 'Verification failed: line not found in QB invoice after update'
    logger.error(LOG, 'sync.verify_failed', { entryId, lineId: addResult.lineId })
    await updateVehicleEntry(entryId, { status: 'quickbooks_error', invoiceSyncStatus: 'error', invoiceSyncError: reason })
    return { outcome: 'error', invoiceNumber: batch.quickbooksInvoiceNumber, dealershipName: dealer.name, lineText, reason }
  }

  // ── 8. Record success ─────────────────────────────────────────────────────
  const now = new Date()
  await updateVehicleEntry(entryId, {
    status:              'quickbooks_updated',
    invoiceBatchId:      batch.id,
    quickbooksInvoiceId: batch.quickbooksInvoiceId,
    quickbooksLineId:    addResult.lineId,
    invoiceSyncStatus:   'synced',
    invoiceSyncedAt:     now,
    invoiceSyncError:    null,
  })

  logger.info(LOG, 'sync.success', {
    entryId,
    invoiceId:     batch.quickbooksInvoiceId,
    invoiceNumber: batch.quickbooksInvoiceNumber,
    lineId:        addResult.lineId,
    dealer:        dealer.name,
  })

  return {
    outcome:        'synced',
    invoiceNumber:  batch.quickbooksInvoiceNumber,
    dealershipName: dealer.name,
    lineText,
    reason:         null,
  }
}
