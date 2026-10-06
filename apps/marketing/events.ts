/**
 * Append-only marketing audit log. Every externally-visible or AI action records one row here
 * (campaign approved/sent, recipient excluded, AI copy generated, attribution linked, settings
 * changed, …). Never updated or deleted — the trail is the record.
 */
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingEvents } from './schema'

export type MarketingEventType =
  | 'campaign_created' | 'campaign_copy_updated' | 'campaign_approved' | 'campaign_scheduled'
  | 'campaign_sending' | 'campaign_sent' | 'campaign_paused' | 'campaign_cancelled' | 'campaign_completed'
  | 'recipients_built' | 'recipient_excluded' | 'recipient_sent' | 'recipient_failed'
  | 'ai_copy_generated' | 'ai_post_generated' | 'ai_recommendation_generated'
  | 'post_created' | 'post_scheduled' | 'post_approved' | 'post_posted'
  | 'lead_created' | 'lead_updated'
  | 'attribution_linked'
  | 'reply_suggested' | 'conversation_escalated'
  | 'unsubscribe' | 'eligibility_changed'
  | 'ad_metrics_imported' | 'settings_changed'

export interface LogEventInput {
  entityType?: string
  entityId?: string | null
  actor?: string | null
  meta?: Record<string, unknown>
}

export async function logEvent(eventType: MarketingEventType, input: LogEventInput = {}): Promise<void> {
  await getDb().insert(marketingEvents).values({
    eventType,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    actor: input.actor ?? null,
    meta: input.meta ?? null,
  })
}

export async function listEvents(limit = 100) {
  return getDb().select().from(marketingEvents).orderBy(desc(marketingEvents.createdAt)).limit(limit)
}

export async function listEventsForEntity(entityType: string, entityId: string, limit = 50) {
  return getDb().select().from(marketingEvents)
    .where(eq(marketingEvents.entityId, entityId))
    .orderBy(desc(marketingEvents.createdAt)).limit(limit)
}
