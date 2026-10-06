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
  createdSource?: 'manual' | 'job_candidate' | 'ai'
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

export async function listPosts(opts: { status?: PostStatus; from?: Date; to?: Date; limit?: number } = {}): Promise<SocialPost[]> {
  const db = getDb()
  const conds = []
  if (opts.status) conds.push(eq(marketingSocialPosts.status, opts.status))
  if (opts.from) conds.push(gte(marketingSocialPosts.scheduledAt, opts.from))
  if (opts.to) conds.push(lte(marketingSocialPosts.scheduledAt, opts.to))
  const q = db.select().from(marketingSocialPosts).orderBy(desc(marketingSocialPosts.createdAt)).limit(opts.limit ?? 100)
  return conds.length ? q.where(and(...conds)) : q
}

const POST_EVENT: Partial<Record<PostStatus, 'post_scheduled' | 'post_approved' | 'post_posted'>> = {
  scheduled: 'post_scheduled', approved: 'post_approved', posted: 'post_posted',
}

export async function updatePost(id: string, patch: {
  copy?: string; pillar?: ContentPillar; targetService?: ServiceCategory | null
  scheduledAt?: Date | null; status?: PostStatus; approvedBy?: string | null; externalPostRef?: string | null
}, actor: string | null): Promise<SocialPost | null> {
  const [row] = await getDb().update(marketingSocialPosts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(marketingSocialPosts.id, id)).returning()
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
  beforePhotoId: string
  afterPhotoId: string
}

interface CandidateRow {
  service_order_id: string
  vehicle_label: string | null
  services: unknown
  photo_count: number
  before_photo_id: string
  after_photo_id: string
}

/**
 * Completed jobs with strong before/after assets and a known premium service that do NOT yet have a
 * post. Earliest photo = "before", latest = "after". Returns draft-post opportunities only.
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
             so.customer_name   AS vehicle_label,
             so.services        AS services,
             count(op.id)::int  AS photo_count,
             (array_agg(op.id ORDER BY op.created_at ASC))[1]  AS before_photo_id,
             (array_agg(op.id ORDER BY op.created_at DESC))[1] AS after_photo_id
      FROM service_orders so
      JOIN order_photos op ON op.service_order_id = so.id AND op.removed_at IS NULL
      WHERE so.status IN ('ready','delivered')
        AND NOT EXISTS (SELECT 1 FROM marketing_social_posts p WHERE p.service_order_id = so.id)
      GROUP BY so.id, so.customer_name, so.services
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
      beforePhotoId: r.before_photo_id,
      afterPhotoId: r.after_photo_id,
    })
  }
  return out
}
