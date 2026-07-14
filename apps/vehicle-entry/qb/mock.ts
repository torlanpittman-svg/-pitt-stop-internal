// Phase 1 mock QuickBooks provider.
// Stores invoices in the mock_qb_invoices table.
// Drop-in replaceable with the real QB provider in Phase 3.

import {
  getMockQBInvoice,
  addLineToMockQBInvoice,
  createMockQBInvoice,
} from '@/apps/vehicle-entry/invoice-db'
import type { QBProvider, QBInvoice } from './types'

export const mockQBProvider: QBProvider = {

  async fetchInvoice(invoiceId: string): Promise<QBInvoice> {
    const inv = await getMockQBInvoice(invoiceId)
    if (!inv) throw new Error(`Mock QB: invoice ${invoiceId} not found`)
    return {
      id:            inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerId:    inv.customerId,
      syncToken:     String(inv.syncToken),
      lines:         inv.lines,
    }
  },

  async addLineToInvoice({ invoiceId, syncToken, description }) {
    const lineId = crypto.randomUUID().slice(0, 8)
    const { newSyncToken } = await addLineToMockQBInvoice(
      invoiceId,
      Number(syncToken),
      { id: lineId, description, amount: 0 }
    )
    return { lineId, newSyncToken: String(newSyncToken) }
  },

  async createInvoice({ customerId, customerName, invoiceNumber }) {
    const invoiceId = `mock-${Date.now()}`
    await createMockQBInvoice({ id: invoiceId, customerId, customerName: customerName ?? '', invoiceNumber })
    return { invoiceId, invoiceNumber, syncToken: '1' }
  },
}
