/**
 * SYNTHETIC RestorationReport fixtures — the safe local review harness for /marketing/restoration.
 * The live page cannot be rendered against the local environment (local env points READ-ONLY at the
 * production DB, which does not have migration 0076; a Vercel preview shares the production DB and is
 * NOT a test target), so review happens by rendering the pure RestorationReportView with these props:
 * ReportView.test.tsx (automated) and scripts/preview-restoration-report.ts (visual HTML, local-only).
 * Every value here is invented; no production data, secrets or connections are involved.
 */
import type { RestorationReport, RestorationLeadRow } from '@/apps/marketing/restoration-report'

const lead = (over: Partial<RestorationLeadRow> & Pick<RestorationLeadRow, 'leadId' | 'createdAt' | 'damageType' | 'source' | 'status'>): RestorationLeadRow => ({
  quoteRequestId: `qr-${over.leadId}`, claimStatus: null, landingPage: null,
  name: 'Synthetic Person', phone: '(979) 555-0000', email: 'synthetic@example.invalid',
  serviceOrderId: null, hasEstimate: false, orderCompleted: false, orderCancelled: false,
  emailStatus: 'sent', photoCount: 2, duplicateOf: null,
  ...over,
})

/** A busy week: paid + organic leads, one duplicate, one completed invoiced paid job, known spend. */
export const FIXTURE_POPULATED: RestorationReport = {
  range: { from: '2026-11-02', to: '2026-11-08' },
  leads: {
    total: 3, qualified: 2, duplicates: 1,
    byDamageType: { vandalism: 1, overspray: 1 },
    bySource: { google_ads: 1, website: 1 },
    byLandingPage: { 'car-vandalism-repair': 1, 'car-overspray-removal': 1 },
    byClaimStatus: { filed: 1, not_filed: 1 },
    matched: 1, unmatched: 1, emailNotSent: 1,
    rows: [
      lead({ leadId: 'L1', createdAt: new Date('2026-11-02T15:00:00Z'), damageType: 'vandalism', source: 'website', status: 'contacted', duplicateOf: 'L2' }),
      lead({ leadId: 'L2', createdAt: new Date('2026-11-03T16:00:00Z'), damageType: 'vandalism', source: 'google_ads', status: 'won', serviceOrderId: 'SO-1', hasEstimate: true, orderCompleted: true, claimStatus: 'filed', landingPage: 'car-vandalism-repair' }),
      lead({ leadId: 'L3', createdAt: new Date('2026-11-04T17:00:00Z'), damageType: 'overspray', source: 'website', status: 'new', name: 'Other Person', phone: '(979) 555-0177', email: 'other@example.invalid', landingPage: 'car-overspray-removal', claimStatus: 'not_filed', emailStatus: 'failed' }),
    ],
  },
  funnel: { leads: 2, qualified: 2, estimates: 1, booked: 1, completed: 1, invoiced: 1, cancelled: 0 },
  revenue: {
    invoicedCents: 120000, quotedUninvoicedCents: 0, avgInvoicedTicketCents: 120000,
    byDamageType: { vandalism: { invoicedCents: 120000, orders: 1 } },
    bySource: { google_ads: { invoicedCents: 120000, orders: 1 } },
    repeatCustomers: 0,
    refundsNote: 'Refunds and credit memos are recorded in QuickBooks and are not reflected here.',
  },
  costs: { partsCostCents: 3000, subletCostCents: 22000, profitability: 'unmeasured' },
  ads: { meta: { status: 'live', source: 'google_ads_api', fetchedAt: '2026-11-08T12:00:00.000Z', error: null, errorKind: null, account: null }, spendCents: 15000, clicks: 40, conversions: 2 },
  unit: { paidLeads: 1, costPerPaidLeadCents: 15000, blendedCostPerCompletedJobCents: 15000, paidNewCustomersInvoiced: 1, paidCacCents: 15000 },
  orders: [{ serviceOrderId: 'SO-1', completedAt: new Date('2026-11-06T20:00:00Z'), damageType: 'vandalism', source: 'google_ads', invoicedCents: 120000, quotedValueCents: 120000, partsCostCents: 3000, subletCostCents: 22000, newCustomer: true, customerId: 'C1', leadId: 'L2' }],
  caveats: [
    'Revenue counts only completed jobs whose estimate is anchored to a QuickBooks invoice. Completed-but-uninvoiced work is shown as quoted, not revenue.',
    'Refunds and credit memos are recorded in QuickBooks and are not reflected here.',
    'Profitability is UNMEASURED: labor cost is not captured on jobs, so no contribution or margin is computed — parts and sublet figures are recorded line-item costs only, not a profit statement.',
    'Ad spend is the Google Ads figure for campaigns mapped to the restoration category.',
    '“Cost per paid lead” and “paid CAC” divide Google Ads spend by Google Ads–attributed leads and newly acquired invoiced customers only.',
  ],
}

/** An empty/unknown week: no restoration ad mapping, no leads — every spend metric must be unknown, not $0. */
export const FIXTURE_UNKNOWNS: RestorationReport = {
  range: { from: '2026-11-09', to: '2026-11-15' },
  leads: { total: 0, qualified: 0, duplicates: 0, byDamageType: {}, bySource: {}, byLandingPage: {}, byClaimStatus: {}, matched: 0, unmatched: 0, emailNotSent: 0, rows: [] },
  funnel: { leads: 0, qualified: 0, estimates: 0, booked: 0, completed: 0, invoiced: 0, cancelled: 0 },
  revenue: { invoicedCents: 0, quotedUninvoicedCents: 0, avgInvoicedTicketCents: null, byDamageType: {}, bySource: {}, repeatCustomers: 0, refundsNote: 'Refunds and credit memos are recorded in QuickBooks and are not reflected here.' },
  costs: { partsCostCents: 0, subletCostCents: 0, profitability: 'unmeasured' },
  ads: { meta: { status: 'live', source: 'google_ads_api', fetchedAt: '2026-11-15T12:00:00.000Z', error: null, errorKind: null, account: null }, spendCents: null, clicks: null, conversions: null },
  unit: { paidLeads: 0, costPerPaidLeadCents: null, blendedCostPerCompletedJobCents: null, paidNewCustomersInvoiced: 0, paidCacCents: null },
  orders: [],
  caveats: [
    'No Google Ads rollup is mapped to the restoration category for this window, so restoration spend is unknown — not $0. A genuine $0 appears only when a restoration-mapped campaign reports zero spend.',
    'Profitability is UNMEASURED: labor cost is not captured on jobs, so no contribution or margin is computed — parts and sublet figures are recorded line-item costs only, not a profit statement.',
  ],
}
