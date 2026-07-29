/**
 * Live dealer-invoice overview — read-only. Gives the owner QuickBooks billing
 * visibility inside Pitt Stop (open invoice, vehicle count, total, sent status)
 * without logging into QuickBooks. Safe on production (no writes).
 */
import { listDealerships } from '@/apps/vehicle-entry/db'
import { listOpenInvoicesForCustomer } from '@/apps/quickbooks/invoices'
import { getConnectionStatus } from '@/apps/quickbooks/connection'

export interface DealerInvoiceSummary {
  dealer:       string
  qbCustomerId: string
  openInvoices: Array<{
    number:  string | null
    id:      string
    vehicles: number
    total:   number
    sent:    boolean
  }>
  openTotal:    number
  openVehicles: number
}

export interface DealerOverview {
  connected:   boolean
  environment: string
  dealers:     DealerInvoiceSummary[]
  error?:      string
}

export async function getDealerInvoiceOverview(): Promise<DealerOverview> {
  const status = await getConnectionStatus()
  if (!status.connected) {
    return { connected: false, environment: status.environment, dealers: [] }
  }

  // Dedupe by QB customer (S & T both map to Sterling Auto Group).
  const dealerships = await listDealerships(false)
  const byCustomer = new Map<string, string>()
  for (const d of dealerships) {
    if (d.qbCustomerId && !byCustomer.has(d.qbCustomerId)) {
      byCustomer.set(d.qbCustomerId, d.qbCustomerName ?? d.name)
    }
  }

  const dealers: DealerInvoiceSummary[] = []
  for (const [qbCustomerId, dealer] of byCustomer) {
    const open = await listOpenInvoicesForCustomer(qbCustomerId)
    const openInvoices = open.map((inv) => ({
      number: inv.docNumber, id: inv.id, vehicles: inv.lineCount, total: inv.totalAmount, sent: inv.sent,
    }))
    dealers.push({
      dealer,
      qbCustomerId,
      openInvoices,
      openTotal:    openInvoices.reduce((s, i) => s + i.total, 0),
      openVehicles: openInvoices.reduce((s, i) => s + i.vehicles, 0),
    })
  }
  dealers.sort((a, b) => a.dealer.localeCompare(b.dealer))

  return { connected: true, environment: status.environment, dealers }
}
