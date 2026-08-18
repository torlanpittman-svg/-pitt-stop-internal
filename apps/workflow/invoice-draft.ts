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
  // Retail QuickBooks link state (P-D3.1/3.2/3.3). status: none|creating|created|sent|error|syncing.
  // `linked` = a QB invoice exists (invoice-id-first UI). `syncNeeded`/`needsReview` derive from
  // the qb_sync_error convention so the UI never parses raw error text.
  qb: { status: string; linked: boolean; invoiceNumber: string | null; error: string | null; syncNeeded: boolean; needsReview: boolean; sent: boolean; resendRecommended: boolean; sentAt: string | null }
}

// Derive the retail QB link state for the read model. `linked` is invoice-id-first (a QB
// invoice exists → the UI never offers Create). syncNeeded/needsReview come from the
// qb_sync_error text convention set by flagQbSyncNeededIfInvoiced / the Sync service.
function buildQbState(est: FullEstimate['estimate'] | null | undefined): InvoiceDraft['qb'] {
  if (!est) return { status: 'none', linked: false, invoiceNumber: null, error: null, syncNeeded: false, needsReview: false, sent: false, resendRecommended: false, sentAt: null }
  const error = est.qbSyncError ?? null
  const needsReview = !!error && /^needs review/i.test(error)
  const resendRecommended = est.qbStatus === 'sent' && !!error && /resend recommended/i.test(error)
  const syncNeeded = !!error && /sync needed/i.test(error) && !needsReview
  return {
    status: est.qbStatus ?? 'none',
    linked: !!est.qbInvoiceId,
    invoiceNumber: est.qbInvoiceNumber ?? null,
    error, syncNeeded, needsReview,
    sent: est.qbStatus === 'sent',
    resendRecommended,
    sentAt: est.qbSentAt ? new Date(est.qbSentAt).toISOString() : null,
  }
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
    qb: buildQbState(est),
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
