/**
 * Marketing leads. A lightweight funnel row that eventually links through to a real customer/order
 * and the completed revenue it produced. Reuses existing estimates/orders when linked — it never
 * replaces the workflow's own entities, it just tracks the MARKETING view of a prospect.
 */
import { desc, eq, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingLeads } from './schema'
import { logEvent } from './events'
import type { AttributionSource, LeadStatus } from './types'

export type Lead = typeof marketingLeads.$inferSelect

export interface CreateLeadInput {
  name?: string | null
  phone?: string | null
  email?: string | null
  vehicle?: string | null
  requestedService?: string | null
  source?: AttributionSource
  campaignId?: string | null
  estimatedValueCents?: number | null
  customerId?: string | null
  notes?: string | null
  /** Optional explicit creation time (used for backfill/tests so report windows are testable). */
  createdAt?: Date
}

export async function createLead(input: CreateLeadInput, actor: string | null): Promise<Lead> {
  const [row] = await getDb().insert(marketingLeads).values({
    name: input.name ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    vehicle: input.vehicle ?? null,
    requestedService: input.requestedService ?? null,
    source: input.source ?? 'unknown',
    campaignId: input.campaignId ?? null,
    estimatedValueCents: input.estimatedValueCents ?? null,
    customerId: input.customerId ?? null,
    notes: input.notes ?? null,
    status: 'new',
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  }).returning()
  await logEvent('lead_created', { entityType: 'lead', entityId: row.id, actor, meta: { source: row.source } })
  return row
}

export async function getLead(id: string): Promise<Lead | null> {
  const [row] = await getDb().select().from(marketingLeads).where(eq(marketingLeads.id, id)).limit(1)
  return row ?? null
}

export async function listLeads(opts: { status?: LeadStatus; limit?: number; offset?: number } = {}): Promise<Lead[]> {
  const db = getDb()
  const q = db.select().from(marketingLeads)
    .orderBy(desc(marketingLeads.createdAt))
    .limit(opts.limit ?? 200)
    .offset(opts.offset ?? 0)
  return opts.status ? q.where(eq(marketingLeads.status, opts.status)) : q
}

/** Total lead count (for pagination controls). */
export async function countLeads(status?: LeadStatus): Promise<number> {
  const db = getDb()
  const q = db.select({ n: sql<number>`count(*)::int` }).from(marketingLeads)
  const [row] = status ? await q.where(eq(marketingLeads.status, status)) : await q
  return row?.n ?? 0
}

export async function updateLead(id: string, patch: {
  status?: LeadStatus
  customerId?: string | null
  serviceOrderId?: string | null
  attributedRevenueCents?: number | null
  estimatedValueCents?: number | null
  notes?: string | null
}, actor: string | null): Promise<Lead | null> {
  const [row] = await getDb().update(marketingLeads)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(marketingLeads.id, id)).returning()
  if (row) await logEvent('lead_updated', { entityType: 'lead', entityId: id, actor, meta: { status: row.status } })
  return row ?? null
}

export async function leadCountsByStatus(): Promise<Record<string, number>> {
  const rows = await getDb().select({
    status: marketingLeads.status,
    count: sql<number>`count(*)::int`,
  }).from(marketingLeads).groupBy(marketingLeads.status)
  return Object.fromEntries(rows.map((r) => [r.status, r.count]))
}
