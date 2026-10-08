/**
 * Marketing attribution — the honest link from a marketing touch to real completed revenue.
 *   marketing interaction → customer → vehicle → estimate/order → completed job → actual revenue
 *
 * Rules:
 *   • Append-only: every link is a row in marketing_attribution; corrections add a new row. We NEVER
 *     update or delete attribution rows. Re-linking a lead to a DIFFERENT order appends a new row; the
 *     prior row is logically SUPERSEDED (it is no longer the latest row for that lead) and an audit
 *     event is recorded. The report excludes superseded lead links.
 *   • Idempotent (best-effort, atomic single-statement insert-if-absent). The REPORT is the dedup
 *     authority — it counts each completed order ONCE regardless of how many touches it has — so a
 *     duplicate audit row (e.g. under rare concurrency with no unique index) can never inflate revenue.
 *   • Never fake a source. If we can't establish one, it stays 'unknown'/'unknown'.
 *   • Completed revenue is CANONICAL. "Invoiced" revenue is ONLY recognized when a real QB invoice
 *     anchor exists (job_estimates.qb_invoice_id); the draft/quote total is reported SEPARATELY as
 *     estimated "completed job value" and is never labeled invoiced. A completed job with no invoice
 *     yet has UNKNOWN invoiced value (null) — never asserted as zero. Unverified touches (no linked
 *     order) never fabricate a job.
 */
import { and, desc, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingAttribution, marketingCampaignRecipients, marketingLeads } from './schema'
import { markRecipient } from './db'
import { logEvent } from './events'
import { primaryServiceCategory } from './services'
import { MarketingInputError } from './validation'
import type { AttributionConfidence, AttributionSource, ServiceCategory } from './types'

export interface RecordAttributionInput {
  source: AttributionSource
  medium?: string | null
  campaign?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  clickId?: string | null
  touchType?: 'first' | 'last'
  confidence?: AttributionConfidence
  customerId?: string | null
  serviceOrderId?: string | null
  leadId?: string | null
  campaignId?: string | null
  revenueCents?: number | null
  occurredAt?: Date
}

export async function recordAttribution(input: RecordAttributionInput, actor: string | null = null): Promise<string> {
  const [row] = await getDb().insert(marketingAttribution).values({
    source: input.source,
    medium: input.medium ?? null,
    campaign: input.campaign ?? null,
    utmSource: input.utmSource ?? null,
    utmMedium: input.utmMedium ?? null,
    utmCampaign: input.utmCampaign ?? null,
    clickId: input.clickId ?? null,
    touchType: input.touchType ?? 'last',
    confidence: input.confidence ?? 'unknown',
    customerId: input.customerId ?? null,
    serviceOrderId: input.serviceOrderId ?? null,
    leadId: input.leadId ?? null,
    campaignId: input.campaignId ?? null,
    revenueCents: input.revenueCents ?? null,
    occurredAt: input.occurredAt ?? new Date(),
  }).returning({ id: marketingAttribution.id })
  await logEvent('attribution_linked', { entityType: 'attribution', entityId: row.id, actor, meta: { source: input.source, confidence: input.confidence ?? 'unknown' } })
  return row.id
}

function toRows<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] })?.rows ?? [])
}

/**
 * Append-only idempotent credit: insert ONE attribution row for a (order, source) pair scoped to a
 * campaign or lead, using a single atomic INSERT ... WHERE NOT EXISTS (so a double-tap doesn't append a
 * second row). Returns the attribution id (new or pre-existing). Best-effort audit dedup — not a hard
 * concurrency lock (no unique index); the report is dedup-safe regardless (per-order aggregation).
 */
async function recordCreditOnce(
  input: RecordAttributionInput & { serviceOrderId: string },
  dedupe: { campaignId?: string | null; leadId?: string | null },
  actor: string | null,
): Promise<string> {
  const conds = [sql`service_order_id = ${input.serviceOrderId}`, sql`source = ${input.source}`]
  conds.push(dedupe.campaignId ? sql`campaign_id = ${dedupe.campaignId}` : sql`campaign_id IS NULL`)
  conds.push(dedupe.leadId ? sql`lead_id = ${dedupe.leadId}` : sql`lead_id IS NULL`)
  const where = sql.join(conds, sql` AND `)

  const inserted = toRows<{ id: string }>(await getDb().execute(sql`
    INSERT INTO marketing_attribution
      (source, touch_type, confidence, customer_id, service_order_id, lead_id, campaign_id, revenue_cents, occurred_at)
    SELECT ${input.source}, ${input.touchType ?? 'last'}, ${input.confidence ?? 'unknown'},
           ${input.customerId ?? null}, ${input.serviceOrderId}, ${dedupe.leadId ?? null},
           ${dedupe.campaignId ?? null}, ${input.revenueCents ?? null}, ${input.occurredAt ?? new Date()}
    WHERE NOT EXISTS (SELECT 1 FROM marketing_attribution WHERE ${where})
    RETURNING id
  `))
  if (inserted.length) {
    await logEvent('attribution_linked', { entityType: 'attribution', entityId: inserted[0].id, actor, meta: { source: input.source, confidence: input.confidence ?? 'unknown' } })
    return inserted[0].id
  }
  const existing = toRows<{ id: string }>(await getDb().execute(sql`SELECT id FROM marketing_attribution WHERE ${where} ORDER BY created_at ASC LIMIT 1`))
  return existing[0]?.id ?? ''
}

/**
 * Link a campaign recipient's outcome (they responded / booked a job). When a booking is confirmed we
 * record a DIRECT attribution credit for the campaign's channel — revenue is NOT required here, it is
 * derived canonically from the order/invoice at report time. Idempotent per (order, channel, campaign).
 */
export async function linkRecipientOutcome(
  recipientId: string,
  outcome: { respondedAt?: Date; bookedOrderId?: string | null; completedRevenueCents?: number | null },
  actor: string | null = null,
): Promise<void> {
  const [rec] = await getDb().select().from(marketingCampaignRecipients).where(eq(marketingCampaignRecipients.id, recipientId)).limit(1)
  if (!rec) throw new Error('Recipient not found')

  await markRecipient(recipientId, {
    respondedAt: outcome.respondedAt ?? rec.respondedAt ?? (outcome.bookedOrderId ? new Date() : rec.respondedAt),
    bookedOrderId: outcome.bookedOrderId ?? rec.bookedOrderId,
    completedRevenueCents: outcome.completedRevenueCents ?? rec.completedRevenueCents,
  })

  const bookedOrderId = outcome.bookedOrderId ?? rec.bookedOrderId
  if (bookedOrderId) {
    const source: AttributionSource = rec.channel === 'sms' ? 'sms' : 'email'
    await recordCreditOnce({
      source, confidence: 'direct', touchType: 'last',
      customerId: rec.customerId, serviceOrderId: bookedOrderId,
      campaignId: rec.campaignId,
    }, { campaignId: rec.campaignId }, actor)
  }
}

/**
 * Link a lead to the order it produced — allowed BEFORE completion and WITHOUT any manual revenue. The
 * report credits the lead's source dynamically once the order completes + is invoiced. Validates the
 * order exists and (when both are known) the lead's and order's customer agree. Re-linking a lead to a
 * DIFFERENT order appends a new credit and records an append-only `attribution_superseded` audit event;
 * the report excludes the superseded (non-latest) lead link.
 */
export async function linkLeadOutcome(
  leadId: string,
  outcome: { serviceOrderId: string; confidence?: AttributionConfidence },
  actor: string | null = null,
): Promise<void> {
  const [lead] = await getDb().select().from(marketingLeads).where(eq(marketingLeads.id, leadId)).limit(1)
  if (!lead) throw new MarketingInputError('Lead not found.')

  const ord = toRows<{ customer_id: string | null }>(await getDb().execute(sql`SELECT customer_id FROM service_orders WHERE id = ${outcome.serviceOrderId} LIMIT 1`))
  if (!ord.length) throw new MarketingInputError('That order no longer exists — pick another from the search.')
  const orderCustomerId = ord[0].customer_id
  if (lead.customerId && orderCustomerId && lead.customerId !== orderCustomerId) {
    throw new MarketingInputError('Lead and order belong to different customers — pick the matching order.')
  }

  // A prior lead link to a DIFFERENT order becomes superseded (append-only; the report ignores it).
  const [prior] = await getDb().select({ id: marketingAttribution.id, serviceOrderId: marketingAttribution.serviceOrderId })
    .from(marketingAttribution)
    .where(and(eq(marketingAttribution.leadId, leadId), ne(marketingAttribution.serviceOrderId, outcome.serviceOrderId)))
    .orderBy(desc(marketingAttribution.createdAt)).limit(1)

  const resolvedCustomerId = lead.customerId ?? orderCustomerId ?? null
  await getDb().update(marketingLeads)
    .set({ serviceOrderId: outcome.serviceOrderId, customerId: resolvedCustomerId, updatedAt: new Date() })
    .where(eq(marketingLeads.id, leadId))

  const newId = await recordCreditOnce({
    source: (lead.source as AttributionSource) ?? 'unknown',
    confidence: outcome.confidence ?? 'assisted', touchType: 'last',
    customerId: resolvedCustomerId, serviceOrderId: outcome.serviceOrderId, leadId,
  }, { leadId }, actor)

  await logEvent('lead_linked', { entityType: 'lead', entityId: leadId, actor, meta: { orderId: outcome.serviceOrderId } })
  if (prior) {
    await logEvent('attribution_superseded', { entityType: 'attribution', entityId: prior.id, actor, meta: { leadId, oldOrderId: prior.serviceOrderId, newOrderId: outcome.serviceOrderId, supersededBy: newId } })
  }
}

export interface CampaignFunnel {
  recipients: number
  excluded: number
  sent: number
  responses: number
  appointments: number
  completedJobs: number
  invoicedRevenueCents: number
}

/**
 * The funnel for one campaign. Counts come from the recipients table, but COMPLETION and REVENUE reuse
 * canonical order truth: a booked order only counts as a completed job when the order is actually
 * completed (ready/delivered, completed_at set, not cancelled), each order counts ONCE (distinct), and
 * revenue is the canonical INVOICED value (QB-anchored) — never a manually-typed per-recipient amount.
 */
export async function campaignFunnel(campaignId: string): Promise<CampaignFunnel> {
  const [counts] = await getDb().select({
    recipients: sql<number>`count(*) filter (where status <> 'excluded')::int`,
    excluded: sql<number>`count(*) filter (where status = 'excluded')::int`,
    sent: sql<number>`count(*) filter (where status = 'sent')::int`,
    responses: sql<number>`count(*) filter (where responded_at is not null)::int`,
    appointments: sql<number>`count(distinct booked_order_id)::int`,
  }).from(marketingCampaignRecipients).where(eq(marketingCampaignRecipients.campaignId, campaignId))

  const [canon] = toRows<{ completedJobs: number; invoicedRevenueCents: number }>(await getDb().execute(sql`
    SELECT count(*)::int AS "completedJobs",
           coalesce(sum(CASE WHEN je.qb_invoice_id IS NOT NULL THEN je.total_cents ELSE 0 END), 0)::int AS "invoicedRevenueCents"
    FROM (SELECT DISTINCT booked_order_id FROM marketing_campaign_recipients WHERE campaign_id = ${campaignId} AND booked_order_id IS NOT NULL) b
    JOIN service_orders so ON so.id = b.booked_order_id
      AND so.status IN ('ready','delivered') AND so.completed_at IS NOT NULL AND so.cancelled_at IS NULL
    LEFT JOIN job_estimates je ON je.service_order_id = so.id
  `))

  return {
    recipients: counts?.recipients ?? 0,
    excluded: counts?.excluded ?? 0,
    sent: counts?.sent ?? 0,
    responses: counts?.responses ?? 0,
    appointments: counts?.appointments ?? 0,
    completedJobs: Number(canon?.completedJobs) || 0,
    invoicedRevenueCents: Number(canon?.invoicedRevenueCents) || 0,
  }
}

/**
 * CANONICAL completed attributed jobs for a date range. One row per DISTINCT completed service_order
 * that carries at least one ACTIVE marketing attribution touch, bounded by the order's own
 * `completed_at`. "Active" excludes superseded lead links (a lead_id row that is not the latest for its
 * lead). The representative touch per order is deterministic: last-touch, then confidence
 * (direct > assisted > unknown), then most recent, then highest id (stable tie-break).
 *
 *   • invoicedCents  — the QB-anchored invoice total (job_estimates.qb_invoice_id present), else NULL
 *                      (UNKNOWN — a completed job with no invoice yet is never asserted as $0).
 *   • quotedValueCents — the draft/estimated completed-job value (NOT invoiced), for pipeline context.
 */
export interface AttributedOrder {
  serviceOrderId: string
  source: string
  confidence: string
  serviceCategory: ServiceCategory
  invoicedCents: number | null
  quotedValueCents: number | null
  completedAt: Date | null
}

interface AttributedRow {
  serviceOrderId: string
  source: string
  confidence: string
  services: unknown
  invoicedCents: number | null
  quotedValueCents: number | null
  completedAt: string | Date | null
}

export async function attributedCompletedJobs(range: { from: Date; to: Date }): Promise<AttributedOrder[]> {
  const rows = toRows<AttributedRow>(await getDb().execute(sql`
    WITH active_attr AS (
      -- A lead-sourced touch is ACTIVE only if it points at the lead's CURRENT link
      -- (marketing_leads.service_order_id). Re-linking A→B→A therefore re-activates A and deactivates
      -- B deterministically — independent of attribution-row recency (which recordCreditOnce may reuse).
      SELECT a.*
      FROM marketing_attribution a
      WHERE a.service_order_id IS NOT NULL
        AND (
          a.lead_id IS NULL
          OR a.service_order_id = (SELECT l.service_order_id FROM marketing_leads l WHERE l.id = a.lead_id)
        )
    )
    SELECT so.id                                                   AS "serviceOrderId",
           rep.source                                              AS source,
           rep.confidence                                          AS confidence,
           so.services                                             AS services,
           CASE WHEN je.qb_invoice_id IS NOT NULL THEN je.total_cents ELSE NULL END AS "invoicedCents",
           COALESCE(NULLIF(je.total_cents, 0), so.approved_price_cents)             AS "quotedValueCents",
           so.completed_at                                         AS "completedAt"
    FROM service_orders so
    JOIN LATERAL (
      SELECT aa.source, aa.confidence
      FROM active_attr aa
      WHERE aa.service_order_id = so.id
      ORDER BY (aa.touch_type = 'last') DESC,
               CASE aa.confidence WHEN 'direct' THEN 0 WHEN 'assisted' THEN 1 ELSE 2 END,
               aa.occurred_at DESC, aa.id DESC
      LIMIT 1
    ) rep ON true
    LEFT JOIN job_estimates je ON je.service_order_id = so.id
    WHERE so.status IN ('ready', 'delivered')
      AND so.completed_at IS NOT NULL
      AND so.cancelled_at IS NULL
      AND so.completed_at >= ${range.from}
      AND so.completed_at <= ${range.to}
    ORDER BY so.completed_at DESC, so.id DESC
  `))

  return rows.map((r) => ({
    serviceOrderId: r.serviceOrderId,
    source: r.source,
    confidence: r.confidence,
    serviceCategory: primaryServiceCategory(Array.isArray(r.services) ? (r.services as string[]) : []),
    invoicedCents: r.invoicedCents == null ? null : Number(r.invoicedCents),
    quotedValueCents: r.quotedValueCents == null ? null : Number(r.quotedValueCents),
    completedAt: r.completedAt ? new Date(r.completedAt) : null,
  }))
}

export interface SourceAttribution {
  source: string
  revenueCents: number    // invoiced (QB-anchored) only
  direct: number
  assisted: number
  unknown: number
  count: number
}

/** Roll deduped completed orders up by source. Counts are ORDERS; revenue is invoiced only. */
export function rollupBySource(orders: AttributedOrder[]): SourceAttribution[] {
  const map = new Map<string, SourceAttribution>()
  for (const o of orders) {
    const r = map.get(o.source) ?? { source: o.source, revenueCents: 0, direct: 0, assisted: 0, unknown: 0, count: 0 }
    r.revenueCents += o.invoicedCents ?? 0
    r.count += 1
    if (o.confidence === 'direct') r.direct += 1
    else if (o.confidence === 'assisted') r.assisted += 1
    else r.unknown += 1
    map.set(o.source, r)
  }
  return Array.from(map.values()).sort((a, b) => b.revenueCents - a.revenueCents || b.count - a.count)
}

/** Completed attributed orders already rolled up by source for a range (convenience for the UI). */
export async function attributionBySource(range: { from: Date; to: Date }): Promise<SourceAttribution[]> {
  return rollupBySource(await attributedCompletedJobs(range))
}

/** Leads rolled up by source for a range. */
export async function leadsBySource(range: { from: Date; to: Date }): Promise<Array<{ source: string; count: number; attributedRevenueCents: number }>> {
  return getDb().select({
    source: marketingLeads.source,
    count: sql<number>`count(*)::int`,
    attributedRevenueCents: sql<number>`coalesce(sum(${marketingLeads.attributedRevenueCents}),0)::int`,
  }).from(marketingLeads)
    .where(and(gte(marketingLeads.createdAt, range.from), lte(marketingLeads.createdAt, range.to)))
    .groupBy(marketingLeads.source)
}
