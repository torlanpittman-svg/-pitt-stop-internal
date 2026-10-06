/**
 * Marketing attribution — the honest link from a marketing touch to real completed revenue.
 *   marketing interaction → customer → vehicle → estimate/order → completed job → actual revenue
 *
 * Rules:
 *   • Append-only: every link is a row in marketing_attribution; corrections add a new row.
 *   • Never fake a source. If we can't establish one, it stays 'unknown' with confidence 'unknown'.
 *   • Confidence is explicit: 'direct' (we have the chain), 'assisted' (a plausible touch), 'unknown'.
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingAttribution, marketingCampaignRecipients, marketingLeads } from './schema'
import { markRecipient } from './db'
import { logEvent } from './events'
import type { AttributionConfidence, AttributionSource } from './types'

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
  await logEvent('attribution_linked', { entityType: 'attribution', entityId: row.id, actor, meta: { source: input.source, confidence: input.confidence ?? 'unknown', revenueCents: input.revenueCents ?? 0 } })
  return row.id
}

/**
 * Link a campaign recipient's outcome (they responded / booked / completed a job) and, when a booking
 * with revenue is confirmed, record a DIRECT attribution row crediting the campaign's channel.
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

  if (outcome.bookedOrderId && (outcome.completedRevenueCents ?? 0) > 0) {
    const source: AttributionSource = rec.channel === 'sms' ? 'sms' : 'email'
    await recordAttribution({
      source, confidence: 'direct', touchType: 'last',
      customerId: rec.customerId, serviceOrderId: outcome.bookedOrderId,
      campaignId: rec.campaignId, revenueCents: outcome.completedRevenueCents,
    }, actor)
  }
}

export interface CampaignFunnel {
  recipients: number
  excluded: number
  sent: number
  responses: number
  appointments: number
  completedJobs: number
  completedRevenueCents: number
}

/** The funnel for one campaign, straight from the recipients table. */
export async function campaignFunnel(campaignId: string): Promise<CampaignFunnel> {
  const [row] = await getDb().select({
    recipients: sql<number>`count(*) filter (where status <> 'excluded')::int`,
    excluded: sql<number>`count(*) filter (where status = 'excluded')::int`,
    sent: sql<number>`count(*) filter (where status = 'sent')::int`,
    responses: sql<number>`count(*) filter (where responded_at is not null)::int`,
    appointments: sql<number>`count(*) filter (where booked_order_id is not null)::int`,
    completedJobs: sql<number>`count(*) filter (where coalesce(completed_revenue_cents,0) > 0)::int`,
    completedRevenueCents: sql<number>`coalesce(sum(completed_revenue_cents),0)::int`,
  }).from(marketingCampaignRecipients).where(eq(marketingCampaignRecipients.campaignId, campaignId))
  return row ?? { recipients: 0, excluded: 0, sent: 0, responses: 0, appointments: 0, completedJobs: 0, completedRevenueCents: 0 }
}

export interface SourceAttribution {
  source: string
  revenueCents: number
  direct: number
  assisted: number
  unknown: number
  count: number
}

/** Attribution rolled up by source for a date range (by occurred_at). */
export async function attributionBySource(range: { from: Date; to: Date }): Promise<SourceAttribution[]> {
  const rows = await getDb().select({
    source: marketingAttribution.source,
    revenueCents: sql<number>`coalesce(sum(${marketingAttribution.revenueCents}),0)::int`,
    direct: sql<number>`count(*) filter (where ${marketingAttribution.confidence} = 'direct')::int`,
    assisted: sql<number>`count(*) filter (where ${marketingAttribution.confidence} = 'assisted')::int`,
    unknown: sql<number>`count(*) filter (where ${marketingAttribution.confidence} = 'unknown')::int`,
    count: sql<number>`count(*)::int`,
  }).from(marketingAttribution)
    .where(and(gte(marketingAttribution.occurredAt, range.from), lte(marketingAttribution.occurredAt, range.to)))
    .groupBy(marketingAttribution.source)
  return rows
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
