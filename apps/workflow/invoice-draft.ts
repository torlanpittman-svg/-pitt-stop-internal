/**
 * Invoice Draft read model (P-D2) — a clean "what would this customer be invoiced right
 * now?" summary built from the AUTHORITATIVE Job estimate (no second calculation system).
 * Totals come straight from job_estimates (which the fee engine computed); fee amounts
 * come from the generated line items. Dealer Jobs are flagged so the UI shows no retail
 * charges.
 */
import type { OrderWithContext } from './db'
import type { FullEstimate } from './estimate-db'
import { isDealerOrder } from './fees'
import { lineAmountCents } from './estimate'

export interface InvoiceDraft {
  priced: boolean
  isDealer: boolean
  customer: string | null
  vehicle: string
  services: string[]
  workPriceCents: number
  shopSupplies: { cents: number; waived: boolean }
  paymentCharge: { cents: number; waived: boolean; label: string }
  tax: { cents: number; applicable: boolean; needsReview: boolean; exempt: boolean }
  totalCents: number
  role: string
  // Per-service price breakdown (itemized Jobs). Flat Jobs → empty until "Set prices".
  itemized: boolean
  serviceBreakdown: { title: string; cents: number }[]
  // Retail QuickBooks link state (P-D3.1). status: none|creating|created|sent|error.
  qb: { status: string; invoiceNumber: string | null; error: string | null }
}

export function buildInvoiceDraft(params: {
  order: OrderWithContext
  full: FullEstimate | null
  paymentLabel: string
  role: string
}): InvoiceDraft {
  const { order, full, paymentLabel, role } = params
  const v = order.vehicle
  const vehicle = [v.year, v.make, v.model].filter(Boolean).join(' ') || v.vin || 'Vehicle'
  const isDealer = isDealerOrder(order)

  // Work basis = the authoritative work price in EITHER mode: explicit_pretax → the flat
  // total; itemized → the sum of the (non-generated) service lines. Fee lines are
  // generated=true and excluded, so Work + fees never double-count.
  const est = full?.estimate
  const eligibleBasis = full
    ? full.services.flatMap((s) => s.lines).filter((l) => !l.generated).reduce((sum, l) => sum + lineAmountCents(l.priceCents, l.qty), 0)
    : 0
  const workBasis = est && est.priceMode === 'explicit_pretax' && est.explicitTotalCents != null ? est.explicitTotalCents : eligibleBasis
  // Dealer Jobs carry no retail draft. (Dealer billing stays in Dealer Check-In / QuickBooks.)
  const priced = !isDealer && !!full && workBasis > 0

  const base: InvoiceDraft = {
    priced, isDealer,
    customer: order.customerName?.trim() || null,
    vehicle, services: order.services ?? [],
    workPriceCents: 0,
    shopSupplies: { cents: 0, waived: false },
    paymentCharge: { cents: 0, waived: false, label: paymentLabel },
    tax: { cents: 0, applicable: false, needsReview: false, exempt: false },
    totalCents: 0,
    role,
    itemized: !!est && est.priceMode === 'itemized',
    serviceBreakdown: [],
    qb: est ? { status: est.qbStatus ?? 'none', invoiceNumber: est.qbInvoiceNumber ?? null, error: est.qbSyncError ?? null }
            : { status: 'none', invoiceNumber: null, error: null },
  }
  if (!priced || !full || !est) return base

  // Per-service breakdown from the non-generated price lines (itemized Jobs).
  const serviceBreakdown = full.services.filter((s) => s.source !== 'system').flatMap((s) => {
    const l = s.lines.find((x) => !x.generated)
    return l ? [{ title: s.title, cents: lineAmountCents(l.priceCents, l.qty) }] : []
  })

  const feeLines = full.services.flatMap((s) => s.lines).filter((l) => l.generated && l.feeCode)
  const shop = feeLines.find((l) => l.feeCode === 'shop_supplies')?.priceCents ?? 0
  const pay = feeLines.find((l) => l.feeCode === 'payment_charge')?.priceCents ?? 0

  return {
    ...base,
    serviceBreakdown,
    workPriceCents: workBasis,
    shopSupplies: { cents: shop, waived: est.waiveShopSupplies },
    paymentCharge: { cents: pay, waived: est.waiveCardFee, label: paymentLabel },
    // Tax row shows only when it actually applies (>$0) or a category is under review.
    tax: { cents: est.taxCents, applicable: est.taxCents > 0 || est.needsTaxReview, needsReview: est.needsTaxReview, exempt: est.taxExempt },
    totalCents: est.totalCents,
  }
}
