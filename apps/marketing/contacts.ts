/**
 * Customer marketing profiles — built FROM the canonical model, never a second customer store.
 * One grouped query rolls up each directory customer's visits, lifetime revenue, average ticket,
 * and the premium categories they've purchased, joined to their marketing_preferences (consent).
 * The service-category classification is done in app (services.ts) so it stays deterministic and
 * shared with attribution.
 *
 * Scale note: V1 computes aggregates on read. At Pitt Stop's current scale (hundreds–low-thousands
 * of customers) this is a single indexed GROUP BY and is fine. If the directory grows past tens of
 * thousands, promote this to a refreshed `marketing_contact` rollup table (same shape) — the
 * ContactAggregate contract here is deliberately storage-agnostic so that swap is localized.
 */
import { and, eq, ne, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { customers } from '@/apps/directory/schema'
import { serviceOrders, jobEstimates } from '@/apps/workflow/schema'
import { marketingPreferences } from './schema'
import { classifyServices } from './services'
import type { ContactAggregate, SegmentCriteria } from './segments'
import { applySegment, resolveSegmentCriteria } from './segments'

interface RawRow {
  customerId: string
  name: string
  phone: string | null
  email: string | null
  lastVisitAt: string | Date | null
  totalVisits: number
  lifetimeRevenueCents: number
  serviceLabels: unknown
  smsEligible: boolean
  emailEligible: boolean
  smsConsent: boolean
  unsubscribed: boolean
}

function flattenLabels(raw: unknown): string[] {
  // jsonb_agg of each order's `services` (string[]) → array of arrays (and possibly nulls).
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      for (const v of entry) if (typeof v === 'string') out.push(v)
    } else if (typeof entry === 'string') {
      out.push(entry)
    }
  }
  return out
}

function toAggregate(row: RawRow): ContactAggregate {
  const visits = Number(row.totalVisits) || 0
  const revenue = Number(row.lifetimeRevenueCents) || 0
  const lastVisitAt = row.lastVisitAt ? new Date(row.lastVisitAt) : null
  return {
    customerId: row.customerId,
    name: row.name || 'Unknown',
    phone: row.phone || null,
    email: row.email || null,
    lastVisitAt,
    totalVisits: visits,
    lifetimeRevenueCents: revenue,
    avgTicketCents: visits > 0 ? Math.round(revenue / visits) : 0,
    categories: classifyServices(flattenLabels(row.serviceLabels)),
    smsEligible: row.smsEligible !== false,
    emailEligible: row.emailEligible !== false,
    smsConsent: row.smsConsent === true,
    unsubscribed: row.unsubscribed === true,
  }
}

/** Build the per-customer marketing aggregate for every active directory customer. */
export async function contactAggregates(): Promise<ContactAggregate[]> {
  const rows = await getDb()
    .select({
      customerId: customers.id,
      name: sql<string>`coalesce(nullif(${customers.displayName}, ''), nullif(trim(concat_ws(' ', ${customers.firstName}, ${customers.lastName})), ''), 'Unknown')`,
      phone: customers.phone,
      email: customers.email,
      lastVisitAt: sql<string | null>`max(coalesce(${serviceOrders.completedAt}, ${serviceOrders.createdAt}))`,
      totalVisits: sql<number>`count(${serviceOrders.id})::int`,
      lifetimeRevenueCents: sql<number>`coalesce(sum(coalesce(${jobEstimates.totalCents}, ${serviceOrders.approvedPriceCents}, 0)), 0)::int`,
      serviceLabels: sql<unknown>`coalesce(jsonb_agg(${serviceOrders.services}) filter (where ${serviceOrders.services} is not null), '[]'::jsonb)`,
      smsEligible: sql<boolean>`coalesce(bool_and(coalesce(${marketingPreferences.smsEligible}, true)), true)`,
      emailEligible: sql<boolean>`coalesce(bool_and(coalesce(${marketingPreferences.emailEligible}, true)), true)`,
      // Proven SMS consent only: granted status AND not manager-blocked AND not unsubscribed. A present
      // phone number does NOT imply consent — missing/unknown ⇒ false.
      smsConsent: sql<boolean>`coalesce(bool_and(coalesce(${marketingPreferences.smsConsentStatus}, 'unknown') = 'granted' and coalesce(${marketingPreferences.smsEligible}, true) and ${marketingPreferences.unsubscribedAt} is null), false)`,
      unsubscribed: sql<boolean>`bool_or(${marketingPreferences.unsubscribedAt} is not null)`,
    })
    .from(customers)
    .leftJoin(serviceOrders, and(eq(serviceOrders.customerId, customers.id), ne(serviceOrders.status, 'cancelled')))
    .leftJoin(jobEstimates, eq(jobEstimates.serviceOrderId, serviceOrders.id))
    .leftJoin(marketingPreferences, eq(marketingPreferences.customerId, customers.id))
    .where(eq(customers.active, true))
    .groupBy(customers.id)

  return (rows as RawRow[]).map(toAggregate)
}

export interface ContactPage {
  contacts: ContactAggregate[]
  total: number
  page: number
  pageSize: number
}

/** Paginated marketing-contact listing, optionally filtered by a named/custom segment + text search. */
export async function listMarketingContacts(opts: {
  segmentKey?: string | null
  custom?: SegmentCriteria | null
  search?: string | null
  page?: number
  pageSize?: number
  now?: number
} = {}): Promise<ContactPage> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50))
  const now = opts.now ?? Date.now()

  let all = await contactAggregates()

  if (opts.segmentKey || opts.custom) {
    const criteria = resolveSegmentCriteria(opts.segmentKey, opts.custom)
    all = applySegment(all, criteria, now)
  }
  if (opts.search) {
    const q = opts.search.trim().toLowerCase()
    all = all.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.phone ?? '').toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q))
  }

  all.sort((a, b) => b.lifetimeRevenueCents - a.lifetimeRevenueCents || a.name.localeCompare(b.name))
  const total = all.length
  const start = (page - 1) * pageSize
  return { contacts: all.slice(start, start + pageSize), total, page, pageSize }
}
