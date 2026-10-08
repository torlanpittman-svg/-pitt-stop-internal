/**
 * Social content queue (3 Facebook posts/week: educate / proof / sell) + auto-detection of completed
 * jobs that make strong before/after proof posts. Candidate detection reads the existing order_photos
 * system — a completed order with 2+ photos and a known premium service becomes a DRAFT post opportunity
 * (never auto-published; a manager approves). We only ever describe the service actually performed.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingSocialPosts } from './schema'
import { logEvent } from './events'
import { primaryServiceCategory } from './services'
import { WEEKLY_FACEBOOK_PLAN } from './calendar'
import { MarketingInputError } from './validation'
import type { ContentPillar, PostStatus, ServiceCategory } from './types'

export type SocialPost = typeof marketingSocialPosts.$inferSelect

export interface CreatePostInput {
  platform?: string
  pillar: ContentPillar
  targetService?: ServiceCategory | null
  copy?: string
  serviceOrderId?: string | null
  beforePhotoId?: string | null
  afterPhotoId?: string | null
  scheduledAt?: Date | null
  aiGenerated?: boolean
  createdSource?: 'manual' | 'job_candidate' | 'ai' | 'plan'
}

export async function createPost(input: CreatePostInput, actor: string | null): Promise<SocialPost> {
  const [row] = await getDb().insert(marketingSocialPosts).values({
    platform: input.platform ?? 'facebook',
    pillar: input.pillar,
    targetService: input.targetService ?? null,
    copy: input.copy ?? '',
    serviceOrderId: input.serviceOrderId ?? null,
    beforePhotoId: input.beforePhotoId ?? null,
    afterPhotoId: input.afterPhotoId ?? null,
    scheduledAt: input.scheduledAt ?? null,
    aiGenerated: input.aiGenerated ?? false,
    createdSource: input.createdSource ?? 'manual',
    createdBy: actor,
    status: 'draft',
  }).returning()
  await logEvent('post_created', { entityType: 'post', entityId: row.id, actor, meta: { pillar: row.pillar, source: row.createdSource } })
  return row
}

export async function getPost(id: string): Promise<SocialPost | null> {
  const [row] = await getDb().select().from(marketingSocialPosts).where(eq(marketingSocialPosts.id, id)).limit(1)
  return row ?? null
}

export async function listPosts(opts: { status?: PostStatus; from?: Date; to?: Date; limit?: number; offset?: number } = {}): Promise<SocialPost[]> {
  const db = getDb()
  const conds = []
  if (opts.status) conds.push(eq(marketingSocialPosts.status, opts.status))
  if (opts.from) conds.push(gte(marketingSocialPosts.scheduledAt, opts.from))
  if (opts.to) conds.push(lte(marketingSocialPosts.scheduledAt, opts.to))
  const q = db.select().from(marketingSocialPosts)
    .orderBy(desc(marketingSocialPosts.createdAt))
    .limit(opts.limit ?? 100)
    .offset(opts.offset ?? 0)
  return conds.length ? q.where(and(...conds)) : q
}

/** Total post count (for pagination controls). */
export async function countPosts(): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(marketingSocialPosts)
  return row?.n ?? 0
}

/**
 * Seed this week's 3 planned Facebook posts (Mon educate / Wed proof / Fri sell) as drafts, scheduled
 * on their cadence day. De-duped per (pillar, scheduled day) with a check-then-insert, so re-running
 * SEQUENTIALLY (or a normal double-tap) never spams duplicates. NOTE: this is not a hard concurrency
 * guarantee — there is no unique index, so two truly simultaneous calls could race. Acceptable at this
 * scale (a single manager triggers it); documented rather than adding a schema constraint. Monday `weekStart`.
 */
export async function seedWeeklyPlan(weekStart: Date, actor: string | null): Promise<{ created: number; skipped: number }> {
  const dayOffset: Record<'Mon' | 'Wed' | 'Fri', number> = { Mon: 0, Wed: 2, Fri: 4 }
  let created = 0, skipped = 0
  for (const entry of WEEKLY_FACEBOOK_PLAN) {
    const day = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + dayOffset[entry.day], 12))
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
    const dayEnd = new Date(dayStart.getTime() + 86_400_000)
    const [existing] = await getDb().select({ id: marketingSocialPosts.id }).from(marketingSocialPosts)
      .where(and(
        eq(marketingSocialPosts.createdSource, 'plan'),
        eq(marketingSocialPosts.pillar, entry.pillar),
        gte(marketingSocialPosts.scheduledAt, dayStart),
        lte(marketingSocialPosts.scheduledAt, dayEnd),
      )).limit(1)
    if (existing) { skipped++; continue }
    await createPost({ pillar: entry.pillar, copy: entry.note, scheduledAt: day, createdSource: 'plan' }, actor)
    created++
  }
  return { created, skipped }
}

const POST_EVENT: Partial<Record<PostStatus, 'post_scheduled' | 'post_approved' | 'post_posted'>> = {
  scheduled: 'post_scheduled', approved: 'post_approved', posted: 'post_posted',
}

const ADVANCED_STATUSES: PostStatus[] = ['approved', 'scheduled', 'posted']

/**
 * Update a post, ENFORCING the review/approval workflow at the service boundary (the UI promises "a
 * manager approves every post"):
 *   • approve / schedule / post all require non-empty copy;
 *   • scheduling requires a scheduled date;
 *   • marking posted requires the manually-published Facebook post link (we never auto-publish);
 *   • advancing past draft records an approver (approvedBy) if one isn't already set.
 * Violations throw MarketingInputError so the action surfaces a readable flash.
 */
export async function updatePost(id: string, patch: {
  copy?: string; pillar?: ContentPillar; targetService?: ServiceCategory | null
  scheduledAt?: Date | null; status?: PostStatus; approvedBy?: string | null; externalPostRef?: string | null
}, actor: string | null): Promise<SocialPost | null> {
  const existing = await getPost(id)
  if (!existing) return null

  const nextStatus = (patch.status ?? existing.status) as PostStatus
  const nextCopy = (patch.copy ?? existing.copy ?? '').trim()
  const nextScheduledAt = patch.scheduledAt ?? existing.scheduledAt
  const nextExternalRef = (patch.externalPostRef ?? existing.externalPostRef ?? '').trim()
  const advancing = ADVANCED_STATUSES.includes(nextStatus)

  if (advancing && !nextCopy) throw new MarketingInputError('Add post copy before approving, scheduling, or marking it posted.')
  if (nextStatus === 'scheduled' && !nextScheduledAt) throw new MarketingInputError('Pick a date to schedule this post.')
  if (nextStatus === 'posted' && !nextExternalRef) throw new MarketingInputError('Record the published Facebook post link before marking it posted — we never auto-publish.')

  const set = { ...patch, updatedAt: new Date() }
  // Record an approver whenever the post advances past draft, if not already approved.
  if (advancing && !existing.approvedBy && !patch.approvedBy) set.approvedBy = actor

  const [row] = await getDb().update(marketingSocialPosts).set(set).where(eq(marketingSocialPosts.id, id)).returning()
  if (row && patch.status && POST_EVENT[patch.status]) {
    await logEvent(POST_EVENT[patch.status]!, { entityType: 'post', entityId: id, actor })
  }
  return row ?? null
}

export interface ContentCandidate {
  serviceOrderId: string
  vehicleLabel: string | null
  category: ServiceCategory
  photoCount: number
}

interface CandidateRow {
  service_order_id: string
  vehicle_label: string | null
  services: unknown
  photo_count: number
}

/**
 * COMPLETED (ready/delivered, completed_at set, not cancelled) jobs with a known premium service and
 * 2+ photos that do NOT yet have a post — i.e. proof-post OPPORTUNITIES. We deliberately do NOT guess
 * which photo is "before"/"after" (`order_photos` carries no role; chronology would be fabricated) — a
 * manager picks + verifies the shots. The vehicle label is the real vehicle (year/make/model from the
 * canonical `vehicles` join), NEVER the customer name — we never pass a person's name to the AI as a vehicle.
 *
 * `order_photos` belongs to a separate module (apps/order-photos) that is not deployed in every
 * environment, so this queries it BY NAME (no compile-time import) and degrades to [] when the table
 * is absent — marketing never hard-depends on order-photos being present.
 */
export async function findContentCandidates(limit = 25): Promise<ContentCandidate[]> {
  const db = getDb()
  let result: { rows?: CandidateRow[] } | CandidateRow[]
  try {
    result = await db.execute(sql`
      SELECT so.id              AS service_order_id,
             nullif(trim(concat_ws(' ', v.year, v.make, v.model)), '') AS vehicle_label,
             so.services        AS services,
             count(op.id)::int  AS photo_count
      FROM service_orders so
      JOIN order_photos op ON op.service_order_id = so.id AND op.removed_at IS NULL
      LEFT JOIN vehicles v ON v.id = so.vehicle_id
      WHERE so.status IN ('ready','delivered')
        AND so.completed_at IS NOT NULL
        AND so.cancelled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM marketing_social_posts p WHERE p.service_order_id = so.id)
      GROUP BY so.id, v.year, v.make, v.model, so.services
      HAVING count(op.id) >= 2
      ORDER BY max(op.created_at) DESC
      LIMIT ${limit}
    `) as unknown as { rows?: CandidateRow[] } | CandidateRow[]
  } catch {
    // order_photos (apps/order-photos) not present in this environment — no candidates.
    return []
  }

  const rows: CandidateRow[] = Array.isArray(result) ? result : (result.rows ?? [])
  const out: ContentCandidate[] = []
  for (const r of rows) {
    const category = primaryServiceCategory(Array.isArray(r.services) ? (r.services as string[]) : [])
    if (category === 'other') continue // only promote known services; never invent one
    out.push({
      serviceOrderId: r.service_order_id,
      vehicleLabel: r.vehicle_label ?? null,
      category,
      photoCount: Number(r.photo_count) || 0,
    })
  }
  return out
}
