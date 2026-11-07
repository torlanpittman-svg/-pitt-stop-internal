/**
 * Insurance-restoration acquisition report (2026-11-07): Lead → estimate → booked → completed → invoiced
 * revenue → costs → CAC / contribution, for the restoration damage types only (quote_requests.damage_type).
 *
 * Rules (the same canon as apps/marketing/report.ts — nothing here is a parallel truth):
 *   - Revenue is INVOICED only when the job's estimate is QB-anchored (job_estimates.qb_invoice_id or an
 *     applied retail_invoice_members row). A completed-but-uninvoiced job shows under "quoted", never revenue.
 *   - Leads are counted by quote_requests.created_at in the window; completions and revenue by
 *     service_orders.completed_at in the window (period basis, like the weekly report). Cancelled orders
 *     (cancelled_at set) are never completions.
 *   - Costs: parts/sublet = job_line_items.cost_cents (type part|sublet). Labor cost is NOT recorded on labor
 *     lines in production (cost_cents is 0 on every labor line — see docs/insurance-restoration/BASELINE),
 *     so labor cost is MODELED as restoration_labor_cost_pct × invoiced labor price, and clearly labelled.
 *     When the percent is 0 (unset) labor cost is null and contribution is null — never "labor is free".
 *   - Ad spend comes from loadAdReporting (Google Ads API, category 'restoration' via
 *     GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON). Unavailable → spend null → CAC/contribution null. Missing ≠ zero.
 *   - Refunds / credit memos live in QuickBooks and are not modeled here: the report says so.
 *   - Duplicates = restoration requests in the window from the same normalized phone or email after the first.
 *   - A lead is "qualified" once a manager moved it past 'new' and it is not lost/no_response.
 *   - No PII leaves this module except what the manager page itself renders (names on the lead table);
 *     the aggregate numbers carry none.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { loadAdReporting, type AdDataMeta } from './ads-reporting'
import { attributedCompletedJobs } from './attribution'
import { primaryServiceCategory } from './services'
import { restorationLaborCostPct } from '@/apps/settings/db'
import { ymdInZone, accountLocalPeriodToUtc } from './ad-dates'
import { QUOTE_SERVICES, RESTORATION_SERVICES, CLAIM_STATUSES, type QuoteService } from './quote-shared'

export const RESTORATION_CATEGORY = 'restoration'

/** Lead statuses that mean a human qualified the lead (moved it past 'new' and did not close it out). */
export const QUALIFIED_LEAD_STATUSES = ['contacted', 'estimate_needed', 'estimate_sent', 'booked', 'won'] as const
const ESTIMATE_LEAD_STATUSES = new Set(['estimate_sent', 'booked', 'won'])
const BOOKED_LEAD_STATUSES = new Set(['booked', 'won'])

export interface RestorationLeadRow {
  leadId: string
  quoteRequestId: string
  createdAt: Date
  damageType: QuoteService
  claimStatus: string | null
  landingPage: string | null
  source: string
  status: string
  name: string | null
  phone: string | null
  email: string | null
  serviceOrderId: string | null
  /** The linked order has a job_estimate with a non-zero total (an estimate was actually written). */
  hasEstimate: boolean
  /** The linked order is completed (ready/delivered, completed_at set, not cancelled) — regardless of window. */
  orderCompleted: boolean
  orderCancelled: boolean
  emailStatus: string
  photoCount: number
  duplicateOf: string | null
}

export interface RestorationOrderRow {
  serviceOrderId: string
  completedAt: Date
  damageType: QuoteService | null      // from the linked lead; null when the order was only classified by text
  source: string
  invoicedCents: number | null         // QB-anchored only
  quotedValueCents: number | null
  partsCostCents: number
  subletCostCents: number
  laborPriceCents: number
  customerId: string | null
  leadId: string | null
}

export interface RestorationReport {
  range: { from: string; to: string }            // account-local YYYY-MM-DD, inclusive
  leads: {
    total: number
    qualified: number
    duplicates: number
    byDamageType: Record<string, number>
    bySource: Record<string, number>
    byLandingPage: Record<string, number>
    byClaimStatus: Record<string, number>
    matched: number        // linked to a service order
    unmatched: number
    emailNotSent: number   // claim rows whose shop email is not 'sent' (still saved — follow up by phone)
    rows: RestorationLeadRow[]
  }
  funnel: {
    leads: number
    qualified: number
    estimates: number      // leads with a written estimate (linked estimate total > 0) or status estimate_sent+
    booked: number         // leads linked to an order or status booked/won
    completed: number      // completed restoration orders in the window (period basis)
    invoiced: number       // of those, QB-anchored
    cancelled: number      // linked orders that were cancelled
  }
  revenue: {
    invoicedCents: number
    quotedUninvoicedCents: number
    avgInvoicedTicketCents: number | null
    byDamageType: Record<string, { invoicedCents: number; orders: number }>
    bySource: Record<string, { invoicedCents: number; orders: number }>
    repeatCustomers: number   // customers with more than one completed restoration order in the window
    refundsNote: string
  }
  costs: {
    partsCostCents: number
    subletCostCents: number
    laborPriceCents: number
    laborCostPct: number
    laborCostCents: number | null       // null when not modeled
    labelled: 'modeled' | 'not_modeled'
  }
  ads: { meta: AdDataMeta; spendCents: number | null; clicks: number | null; conversions: number | null }
  unit: {
    costPerLeadCents: number | null
    cacCents: number | null             // spend ÷ completed restoration orders
    contributionCents: number | null    // invoiced − parts − sublet − modeled labor − spend
    contributionBeforeAdsCents: number | null
  }
  orders: RestorationOrderRow[]
  caveats: string[]
}

function rows<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] })?.rows ?? [])
}
const bump = (m: Record<string, number>, k: string | null | undefined, by = 1) => { const key = k || 'unknown'; m[key] = (m[key] ?? 0) + by }
export const normalizePhoneKey = (p: string | null | undefined): string | null => { const d = (p ?? '').replace(/\D/g, ''); return d.length >= 10 ? `p:${d.slice(-10)}` : null }
export const normalizeEmailKey = (e: string | null | undefined): string | null => { const v = (e ?? '').trim().toLowerCase(); return v.includes('@') ? `e:${v}` : null }

/**
 * Mark duplicate submissions: within the window, any restoration request from the same normalized phone
 * OR email as an earlier one is a duplicate OF that earlier lead. Pure — unit tested.
 */
export function markDuplicates<T extends { leadId: string; phone: string | null; email: string | null; createdAt: Date }>(leads: T[]): Array<T & { duplicateOf: string | null }> {
  const seen = new Map<string, string>()
  return [...leads].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((l) => {
    const keys = [normalizePhoneKey(l.phone), normalizeEmailKey(l.email)].filter((k): k is string => !!k)
    const prior = keys.map((k) => seen.get(k)).find((id) => id && id !== l.leadId) ?? null
    for (const k of keys) if (!seen.has(k)) seen.set(k, l.leadId)
    return { ...l, duplicateOf: prior }
  })
}

interface LeadSqlRow {
  leadId: string; quoteRequestId: string; createdAt: string | Date; damageType: string; claimStatus: string | null; landingPage: string | null
  source: string; status: string; name: string | null; phone: string | null; email: string | null; serviceOrderId: string | null
  estimateTotal: string | number | null; orderStatus: string | null; orderCompletedAt: string | Date | null; orderCancelledAt: string | Date | null
  emailStatus: string; photoCount: string | number
}

async function restorationLeads(range: { from: Date; to: Date }): Promise<RestorationLeadRow[]> {
  const res = await getDb().execute(sql`
    SELECT l.id AS "leadId", qr.id AS "quoteRequestId", qr.created_at AS "createdAt", qr.damage_type AS "damageType",
           qr.claim_status AS "claimStatus", qr.landing_page AS "landingPage", l.source, l.status, l.name, l.phone, l.email,
           l.service_order_id AS "serviceOrderId",
           (SELECT MAX(je.total_cents) FROM job_estimates je WHERE je.service_order_id = l.service_order_id) AS "estimateTotal",
           so.status AS "orderStatus", so.completed_at AS "orderCompletedAt", so.cancelled_at AS "orderCancelledAt",
           qr.email_status AS "emailStatus", jsonb_array_length(qr.photos) AS "photoCount"
    FROM quote_requests qr
    JOIN marketing_leads l ON l.id = qr.lead_id
    LEFT JOIN service_orders so ON so.id = l.service_order_id
    WHERE qr.damage_type IS NOT NULL
      AND qr.created_at >= ${range.from} AND qr.created_at <= ${range.to}
    ORDER BY qr.created_at ASC
  `)
  const base = rows<LeadSqlRow>(res).map((r) => ({
    leadId: r.leadId, quoteRequestId: r.quoteRequestId, createdAt: new Date(r.createdAt),
    damageType: (Object.hasOwn(QUOTE_SERVICES, r.damageType) ? r.damageType : 'other') as QuoteService,
    claimStatus: r.claimStatus, landingPage: r.landingPage, source: r.source, status: r.status,
    name: r.name, phone: r.phone, email: r.email, serviceOrderId: r.serviceOrderId,
    hasEstimate: Number(r.estimateTotal ?? 0) > 0,
    orderCompleted: !!r.serviceOrderId && (r.orderStatus === 'ready' || r.orderStatus === 'delivered') && !!r.orderCompletedAt && !r.orderCancelledAt,
    orderCancelled: !!r.serviceOrderId && (!!r.orderCancelledAt || r.orderStatus === 'cancelled'),
    emailStatus: r.emailStatus, photoCount: Number(r.photoCount ?? 0),
  }))
  return markDuplicates(base)
}

interface OrderSqlRow {
  serviceOrderId: string; completedAt: string | Date; customerId: string | null; services: unknown
  leadId: string | null; damageType: string | null; leadSource: string | null
  invoicedCents: string | number | null; quotedValueCents: string | number | null
  partsCostCents: string | number | null; subletCostCents: string | number | null; laborPriceCents: string | number | null
}

/**
 * Completed restoration orders in the window: linked from a restoration lead (any time) OR whose services
 * text classifies as 'restoration'. Per-order costs from job_line_items through job_services → job_estimates.
 */
async function restorationOrders(range: { from: Date; to: Date }): Promise<RestorationOrderRow[]> {
  const res = await getDb().execute(sql`
    SELECT so.id AS "serviceOrderId", so.completed_at AS "completedAt", so.customer_id AS "customerId", so.services,
           lk.lead_id AS "leadId", lk.damage_type AS "damageType", lk.source AS "leadSource",
           CASE WHEN je.qb_invoice_id IS NOT NULL OR EXISTS (SELECT 1 FROM retail_invoice_members rim WHERE rim.member_estimate_id = je.id AND rim.state = 'applied') THEN je.total_cents ELSE NULL END AS "invoicedCents",
           COALESCE(NULLIF(je.total_cents, 0), so.approved_price_cents) AS "quotedValueCents",
           COALESCE((SELECT SUM(li.cost_cents) FROM job_line_items li JOIN job_services js ON js.id = li.job_service_id WHERE js.job_estimate_id = je.id AND li.type = 'part'), 0) AS "partsCostCents",
           COALESCE((SELECT SUM(li.cost_cents) FROM job_line_items li JOIN job_services js ON js.id = li.job_service_id WHERE js.job_estimate_id = je.id AND li.type = 'sublet'), 0) AS "subletCostCents",
           COALESCE((SELECT SUM(li.price_cents) FROM job_line_items li JOIN job_services js ON js.id = li.job_service_id WHERE js.job_estimate_id = je.id AND li.type = 'labor'), 0) AS "laborPriceCents"
    FROM service_orders so
    LEFT JOIN job_estimates je ON je.service_order_id = so.id
    LEFT JOIN LATERAL (
      SELECT l.id AS lead_id, qr.damage_type, l.source
      FROM marketing_leads l JOIN quote_requests qr ON qr.lead_id = l.id
      WHERE l.service_order_id = so.id AND qr.damage_type IS NOT NULL
      ORDER BY qr.created_at ASC LIMIT 1
    ) lk ON true
    WHERE so.status IN ('ready', 'delivered') AND so.completed_at IS NOT NULL AND so.cancelled_at IS NULL
      AND so.completed_at >= ${range.from} AND so.completed_at <= ${range.to}
    ORDER BY so.completed_at DESC, so.id DESC
  `)
  // Attribution source fallback for orders that were never linked from a restoration lead.
  const attributed = new Map((await attributedCompletedJobs(range)).map((a) => [a.serviceOrderId, a.source]))
  const seen = new Set<string>()
  const out: RestorationOrderRow[] = []
  for (const r of rows<OrderSqlRow>(res)) {
    if (seen.has(r.serviceOrderId)) continue // several estimates on one order: first (invoiced-or-not) row wins
    const services = Array.isArray(r.services) ? (r.services as string[]) : []
    const byText = primaryServiceCategory(services) === RESTORATION_CATEGORY
    if (!r.leadId && !byText) continue
    seen.add(r.serviceOrderId)
    out.push({
      serviceOrderId: r.serviceOrderId, completedAt: new Date(r.completedAt),
      damageType: r.damageType && Object.hasOwn(QUOTE_SERVICES, r.damageType) ? (r.damageType as QuoteService) : null,
      source: r.leadSource ?? attributed.get(r.serviceOrderId) ?? 'unknown',
      invoicedCents: r.invoicedCents == null ? null : Number(r.invoicedCents),
      quotedValueCents: r.quotedValueCents == null ? null : Number(r.quotedValueCents),
      partsCostCents: Number(r.partsCostCents ?? 0), subletCostCents: Number(r.subletCostCents ?? 0), laborPriceCents: Number(r.laborPriceCents ?? 0),
      customerId: r.customerId, leadId: r.leadId,
    })
  }
  return out
}

export interface RestorationReportDeps {
  /** Injected for tests (the real one calls Google Ads / manual metrics). */
  loadAds?: typeof loadAdReporting
  laborCostPct?: () => Promise<number>
  now?: Date
}

/** `from`/`to` are account-local YYYY-MM-DD (inclusive). */
export async function restorationReport(ymd: { from: string; to: string }, deps: RestorationReportDeps = {}): Promise<RestorationReport> {
  const range = accountLocalPeriodToUtc(ymd.from, ymd.to)
  const [leads, orders, ads, laborCostPct] = await Promise.all([
    restorationLeads(range),
    restorationOrders(range),
    (deps.loadAds ?? loadAdReporting)(ymd),
    (deps.laborCostPct ?? restorationLaborCostPct)(),
  ])

  const byDamageType: Record<string, number> = {}; const bySource: Record<string, number> = {}; const byLandingPage: Record<string, number> = {}; const byClaimStatus: Record<string, number> = {}
  for (const l of leads) { bump(byDamageType, l.damageType); bump(bySource, l.source); bump(byLandingPage, l.landingPage ?? '(none)'); bump(byClaimStatus, l.claimStatus ?? 'not_answered') }
  const unique = leads.filter((l) => !l.duplicateOf)
  const qualified = unique.filter((l) => (QUALIFIED_LEAD_STATUSES as readonly string[]).includes(l.status)).length
  const estimates = unique.filter((l) => l.hasEstimate || ESTIMATE_LEAD_STATUSES.has(l.status)).length
  const booked = unique.filter((l) => l.serviceOrderId || BOOKED_LEAD_STATUSES.has(l.status)).length
  const cancelled = unique.filter((l) => l.orderCancelled).length
  const matched = unique.filter((l) => !!l.serviceOrderId).length

  const invoicedOrders = orders.filter((o) => o.invoicedCents != null)
  const invoicedCents = invoicedOrders.reduce((s, o) => s + (o.invoicedCents ?? 0), 0)
  const quotedUninvoicedCents = orders.filter((o) => o.invoicedCents == null).reduce((s, o) => s + (o.quotedValueCents ?? 0), 0)
  const revByType: RestorationReport['revenue']['byDamageType'] = {}; const revBySource: RestorationReport['revenue']['bySource'] = {}
  const perCustomer: Record<string, number> = {}
  for (const o of orders) {
    const t = o.damageType ?? 'unclassified'; revByType[t] ??= { invoicedCents: 0, orders: 0 }; revByType[t].orders++; revByType[t].invoicedCents += o.invoicedCents ?? 0
    revBySource[o.source] ??= { invoicedCents: 0, orders: 0 }; revBySource[o.source].orders++; revBySource[o.source].invoicedCents += o.invoicedCents ?? 0
    if (o.customerId) bump(perCustomer, o.customerId)
  }
  const repeatCustomers = Object.values(perCustomer).filter((n) => n > 1).length

  // Costs are taken on INVOICED orders only, so contribution compares like with like.
  const partsCostCents = invoicedOrders.reduce((s, o) => s + o.partsCostCents, 0)
  const subletCostCents = invoicedOrders.reduce((s, o) => s + o.subletCostCents, 0)
  const laborPriceCents = invoicedOrders.reduce((s, o) => s + o.laborPriceCents, 0)
  const laborCostCents = laborCostPct > 0 ? Math.round(laborPriceCents * laborCostPct / 100) : null

  const adRow = ads.meta.status === 'unavailable' ? null : (ads.byCategory.find((c) => c.serviceCategory === RESTORATION_CATEGORY) ?? null)
  // Manual/live with no restoration rollup at all = no campaign data recorded; that is "no data", not $0 spend.
  const spendCents = ads.meta.status === 'unavailable' ? null : adRow ? adRow.spendCents : (ads.byCategory.length ? 0 : null)
  const clicks = adRow ? adRow.clicks : null
  const conversions = adRow ? adRow.conversions : null

  const completed = orders.length
  const costPerLeadCents = spendCents == null || unique.length === 0 ? null : Math.round(spendCents / unique.length)
  const cacCents = spendCents == null || completed === 0 ? null : Math.round(spendCents / completed)
  const contributionBeforeAdsCents = laborCostCents == null ? null : invoicedCents - partsCostCents - subletCostCents - laborCostCents
  const contributionCents = contributionBeforeAdsCents == null || spendCents == null ? null : contributionBeforeAdsCents - spendCents

  const caveats = [
    'Revenue counts only completed jobs whose estimate is anchored to a QuickBooks invoice. Completed-but-uninvoiced work is shown as quoted, not revenue.',
    'Refunds and credit memos are recorded in QuickBooks and are not reflected here.',
    laborCostCents == null ? 'Labor cost is not modeled (restoration labor cost % is 0), so contribution is shown as unknown — never as if labor were free.' : `Labor cost is MODELED at ${laborCostPct}% of invoiced labor; parts and sublet use recorded line-item cost.`,
    spendCents == null ? 'Ad spend is unavailable for this window, so cost per lead, CAC and contribution after ads are unknown (not zero).' : 'Ad spend is the Google Ads figure for campaigns mapped to the restoration category.',
    'Leads are counted by request date; completions and revenue by completion date. A lead from one week that completes the next shows in both weeks’ respective columns.',
  ]

  return {
    range: ymd,
    leads: { total: leads.length, qualified, duplicates: leads.length - unique.length, byDamageType, bySource, byLandingPage, byClaimStatus, matched, unmatched: unique.length - matched, emailNotSent: leads.filter((l) => l.emailStatus !== 'sent').length, rows: leads },
    funnel: { leads: unique.length, qualified, estimates, booked, completed, invoiced: invoicedOrders.length, cancelled },
    revenue: { invoicedCents, quotedUninvoicedCents, avgInvoicedTicketCents: invoicedOrders.length ? Math.round(invoicedCents / invoicedOrders.length) : null, byDamageType: revByType, bySource: revBySource, repeatCustomers, refundsNote: caveats[1] },
    costs: { partsCostCents, subletCostCents, laborPriceCents, laborCostPct, laborCostCents, labelled: laborCostCents == null ? 'not_modeled' : 'modeled' },
    ads: { meta: ads.meta, spendCents, clicks, conversions },
    unit: { costPerLeadCents, cacCents, contributionCents, contributionBeforeAdsCents },
    orders,
    caveats,
  }
}

/** Default window = the current Monday→Sunday week in the account time zone. */
export function currentWeekYmd(now: Date = new Date()): { from: string; to: string } {
  const today = ymdInZone(now)
  const d = new Date(`${today}T12:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7
  const mon = new Date(d.getTime() - dow * 86_400_000)
  const sun = new Date(mon.getTime() + 6 * 86_400_000)
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) }
}

export const DAMAGE_TYPE_LABEL = (k: string): string => (Object.hasOwn(QUOTE_SERVICES, k) ? QUOTE_SERVICES[k as QuoteService].label : k === 'unclassified' ? 'Restoration (classified from job text)' : k)
export const CLAIM_STATUS_LABEL = (k: string): string => CLAIM_STATUSES.find((c) => c.key === k)?.label ?? (k === 'not_answered' ? 'Not answered' : k)
export { RESTORATION_SERVICES }
