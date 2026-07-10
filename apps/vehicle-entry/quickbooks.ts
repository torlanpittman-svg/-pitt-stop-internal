import { logger } from '@/platform/logger'
import type { VehicleData } from './types'

const APP = 'vehicle-entry:quickbooks'
const ENABLED = process.env.QUICKBOOKS_ENABLED === 'true'

/**
 * Find a QuickBooks invoice by stock number.
 * Returns the QB invoice ID if found, null otherwise.
 *
 * TODO (when QUICKBOOKS_ENABLED=true):
 *   GET /v3/company/{realmId}/query
 *   ?query=SELECT * FROM Invoice WHERE CustomField = '{stockNumber}'
 */
export async function findInvoiceByStockNumber(stockNumber: string): Promise<string | null> {
  if (!ENABLED) {
    logger.info(APP, 'findInvoiceByStockNumber.stub', { stockNumber })
    return null
  }
  throw new Error('QuickBooks integration not yet implemented. Set QUICKBOOKS_ENABLED=false.')
}

/**
 * Update vehicle information fields on an existing QuickBooks invoice.
 *
 * TODO (when QUICKBOOKS_ENABLED=true):
 *   PATCH /v3/company/{realmId}/invoice with vehicle custom fields
 */
export async function updateInvoiceVehicleInfo(
  invoiceId: string,
  vehicleData: VehicleData
): Promise<{ success: boolean; error?: string }> {
  if (!ENABLED) {
    logger.info(APP, 'updateInvoiceVehicleInfo.stub', { invoiceId, vehicleData })
    return { success: false, error: 'QuickBooks disabled (QUICKBOOKS_ENABLED != true)' }
  }
  throw new Error('QuickBooks integration not yet implemented.')
}

/**
 * Re-fetch the invoice and verify vehicle fields match what we sent.
 *
 * TODO (when QUICKBOOKS_ENABLED=true):
 *   GET /v3/company/{realmId}/invoice/{invoiceId}
 *   Compare custom fields to vehicleData
 */
export async function verifyInvoiceUpdate(
  invoiceId: string,
  vehicleData: VehicleData
): Promise<boolean> {
  if (!ENABLED) {
    logger.info(APP, 'verifyInvoiceUpdate.stub', { invoiceId, vehicleData })
    return false
  }
  throw new Error('QuickBooks integration not yet implemented.')
}
