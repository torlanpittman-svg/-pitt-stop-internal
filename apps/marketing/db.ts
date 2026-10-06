/**
 * Campaign + recipient persistence. Status changes go through the status machine (status.ts) and
 * every meaningful change is audited (events.ts). Counters on the campaign row are denormalized for
 * fast listing but always recomputed from the recipients table — recipients are the source of truth.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingCampaigns, marketingCampaignRecipients } from './schema'
import { canTransition } from './status'
import { logEvent, type MarketingEventType } from './events'
import type { CampaignStatus, CampaignType, Channel } from './types'
import type { SegmentCriteria } from './segments'

export type Campaign = typeof marketingCampaigns.$inferSelect
export type Recipient = typeof marketingCampaignRecipients.$inferSelect

export interface CreateCampaignInput {
  name: string
  campaignType?: CampaignType
  targetService?: string | null
  segmentKey?: string | null
  segmentCriteria?: SegmentCriteria | null
  channel?: Channel
  offer?: string | null
  smsCopy?: string | null
  emailSubject?: string | null
  emailBody?: string | null
  scheduledAt?: Date | null
}

export async function createCampaign(input: CreateCampaignInput, actor: string | null): Promise<Campaign> {
  const [row] = await getDb().insert(marketingCampaigns).values({
    name: input.name,
    campaignType: input.campaignType ?? 'reactivation',
    targetService: input.targetService ?? null,
    segmentKey: input.segmentKey ?? null,
    segmentCriteria: input.segmentCriteria ?? null,
    channel: input.channel ?? 'both',
    offer: input.offer ?? null,
    smsCopy: input.smsCopy ?? null,
    emailSubject: input.emailSubject ?? null,
    emailBody: input.emailBody ?? null,
    scheduledAt: input.scheduledAt ?? null,
    createdBy: actor,
    status: 'draft',
    dryRun: true,
  }).returning()
  await logEvent('campaign_created', { entityType: 'campaign', entityId: row.id, actor, meta: { name: row.name } })
  return row
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const [row] = await getDb().select().from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1)
  return row ?? null
}

export async function listCampaigns(opts: { status?: CampaignStatus | CampaignStatus[]; limit?: number } = {}): Promise<Campaign[]> {
  const db = getDb()
  const where = opts.status
    ? (Array.isArray(opts.status) ? inArray(marketingCampaigns.status, opts.status) : eq(marketingCampaigns.status, opts.status))
    : undefined
  const q = db.select().from(marketingCampaigns).orderBy(desc(marketingCampaigns.createdAt)).limit(opts.limit ?? 100)
  return where ? q.where(where) : q
}

export async function updateCampaignCopy(id: string, copy: {
  name?: string; smsCopy?: string | null; emailSubject?: string | null; emailBody?: string | null
  offer?: string | null; targetService?: string | null; channel?: Channel; segmentKey?: string | null
  segmentCriteria?: SegmentCriteria | null; scheduledAt?: Date | null
}, actor: string | null): Promise<Campaign | null> {
  const [row] = await getDb().update(marketingCampaigns)
    .set({ ...copy, updatedAt: new Date() })
    .where(eq(marketingCampaigns.id, id)).returning()
  if (row) await logEvent('campaign_copy_updated', { entityType: 'campaign', entityId: id, actor })
  return row ?? null
}

const TRANSITION_EVENT: Partial<Record<CampaignStatus, MarketingEventType>> = {
  ready: 'campaign_approved',
  scheduled: 'campaign_scheduled',
  sending: 'campaign_sending',
  sent: 'campaign_sent',
  paused: 'campaign_paused',
  cancelled: 'campaign_cancelled',
  completed: 'campaign_completed',
}

export class InvalidTransitionError extends Error {
  constructor(public from: CampaignStatus, public to: CampaignStatus) {
    super(`Invalid campaign transition: ${from} → ${to}`)
  }
}

/** Move a campaign to a new status, enforcing the state machine. Returns the updated row. */
export async function transitionCampaign(
  id: string, to: CampaignStatus, actor: string | null,
  extra: Partial<Pick<Campaign, 'scheduledAt' | 'dryRun' | 'sentCount'>> = {},
): Promise<Campaign> {
  const current = await getCampaign(id)
  if (!current) throw new Error('Campaign not found')
  const from = current.status as CampaignStatus
  if (from === to) return current
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)

  const patch: Partial<Campaign> = { status: to, updatedAt: new Date(), ...extra }
  if (to === 'ready') { patch.approvedBy = actor; patch.approvedAt = new Date() }
  if (to === 'sent') patch.sentAt = new Date()

  const [row] = await getDb().update(marketingCampaigns).set(patch).where(eq(marketingCampaigns.id, id)).returning()
  const ev = TRANSITION_EVENT[to]
  if (ev) await logEvent(ev, { entityType: 'campaign', entityId: id, actor, meta: { from, to } })
  return row
}

// ── Recipients ──────────────────────────────────────────────────────────────

export interface RecipientSeed {
  customerId: string
  channel: 'sms' | 'email'
  addressSnapshot: string | null
  vehicleLabel?: string | null
  status: 'pending' | 'excluded'
  exclusionReason?: string | null
  renderedBody?: string | null
}

/**
 * Insert built recipients idempotently. The (campaign_id, customer_id, channel) unique index makes
 * re-running a no-op for anyone already present — crucially, it never resets a recipient that was
 * already sent. Returns the count actually inserted.
 */
export async function insertRecipients(campaignId: string, seeds: RecipientSeed[]): Promise<number> {
  if (seeds.length === 0) return 0
  const rows = await getDb().insert(marketingCampaignRecipients).values(
    seeds.map((s) => ({
      campaignId,
      customerId: s.customerId,
      channel: s.channel,
      addressSnapshot: s.addressSnapshot,
      vehicleLabel: s.vehicleLabel ?? null,
      status: s.status,
      exclusionReason: s.exclusionReason ?? null,
      renderedBody: s.renderedBody ?? null,
    })),
  ).onConflictDoNothing({
    target: [marketingCampaignRecipients.campaignId, marketingCampaignRecipients.customerId, marketingCampaignRecipients.channel],
  }).returning({ id: marketingCampaignRecipients.id })
  return rows.length
}

export async function listRecipients(campaignId: string, status?: Recipient['status']): Promise<Recipient[]> {
  const db = getDb()
  const where = status
    ? and(eq(marketingCampaignRecipients.campaignId, campaignId), eq(marketingCampaignRecipients.status, status))
    : eq(marketingCampaignRecipients.campaignId, campaignId)
  return db.select().from(marketingCampaignRecipients).where(where).orderBy(marketingCampaignRecipients.createdAt)
}

export async function markRecipient(id: string, patch: Partial<Pick<Recipient, 'status' | 'exclusionReason' | 'renderedBody' | 'sentAt' | 'respondedAt' | 'bookedOrderId' | 'completedRevenueCents' | 'providerMessageId' | 'deliveryStatus' | 'errorCode'>>): Promise<void> {
  await getDb().update(marketingCampaignRecipients).set(patch).where(eq(marketingCampaignRecipients.id, id))
}

/** Update a recipient's delivery status from a provider status callback (looked up by message id). */
export async function updateDeliveryByProviderId(providerMessageId: string, deliveryStatus: string, errorCode?: string | null): Promise<string | null> {
  const [row] = await getDb().update(marketingCampaignRecipients)
    .set({ deliveryStatus, errorCode: errorCode ?? null })
    .where(eq(marketingCampaignRecipients.providerMessageId, providerMessageId))
    .returning({ id: marketingCampaignRecipients.id })
  return row?.id ?? null
}

/** Recompute the denormalized campaign counters from the recipients table. */
export async function refreshCampaignCounts(campaignId: string): Promise<void> {
  const db = getDb()
  const [counts] = await db.select({
    recipients: sql<number>`count(*) filter (where ${marketingCampaignRecipients.status} <> 'excluded')::int`,
    excluded: sql<number>`count(*) filter (where ${marketingCampaignRecipients.status} = 'excluded')::int`,
    sent: sql<number>`count(*) filter (where ${marketingCampaignRecipients.status} = 'sent')::int`,
    responded: sql<number>`count(*) filter (where ${marketingCampaignRecipients.respondedAt} is not null)::int`,
  }).from(marketingCampaignRecipients).where(eq(marketingCampaignRecipients.campaignId, campaignId))

  await db.update(marketingCampaigns).set({
    recipientCount: counts?.recipients ?? 0,
    excludedCount: counts?.excluded ?? 0,
    sentCount: counts?.sent ?? 0,
    responseCount: counts?.responded ?? 0,
    updatedAt: new Date(),
  }).where(eq(marketingCampaigns.id, campaignId))
}
