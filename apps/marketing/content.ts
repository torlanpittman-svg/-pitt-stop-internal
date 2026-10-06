/**
 * Social content queue (3 Facebook posts/week: educate / proof / sell) + auto-detection of completed
 * jobs that make strong before/after proof posts. Candidate detection reads the existing order_photos
 * system — a completed order with 2+ photos and a known premium service becomes a DRAFT post opportunity
 * (never auto-published; a manager approves). We only ever describe the service actually performed.
 */
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingSocialPosts } from './schema'
import { serviceOrders } from '@/apps/workflow/schema'
import { orderPhotos } from '@/apps/order-photos/schema'
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

/**
 * Completed jobs with strong before/after assets and a known premium service that do NOT yet have a
 * post. Earliest photo = "before", latest = "after". Returns draft-post opportunities only.
 */
export async function findContentCandidates(limit = 25): Promise<ContentCandidate[]> {
  const db = getDb()
  // Orders that are delivered/ready with >= 2 live photos and no existing post.
  const rows = await db.select({
    serviceOrderId: serviceOrders.id,
    vehicleLabel: serviceOrders.customerName,
    services: serviceOrders.services,
    photoCount: sql<number>`count(${orderPhotos.id})::int`,
    beforePhotoId: sql<string>`(array_agg(${orderPhotos.id} order by ${orderPhotos.createdAt} asc))[1]`,
    afterPhotoId: sql<string>`(array_agg(${orderPhotos.id} order by ${orderPhotos.createdAt} desc))[1]`,
  })
    .from(serviceOrders)
    .innerJoin(orderPhotos, and(eq(orderPhotos.serviceOrderId, serviceOrders.id), isNull(orderPhotos.removedAt)))
    .where(sql`${serviceOrders.status} in ('ready','delivered')
      and not exists (select 1 from marketing_social_posts p where p.service_order_id = ${serviceOrders.id})`)
    .groupBy(serviceOrders.id, serviceOrders.customerName, serviceOrders.services)
    .having(sql`count(${orderPhotos.id}) >= 2`)
    .orderBy(desc(sql`max(${orderPhotos.createdAt})`))
    .limit(limit)

  const out: ContentCandidate[] = []
  for (const r of rows) {
    const category = primaryServiceCategory(Array.isArray(r.services) ? (r.services as string[]) : [])
    if (category === 'other') continue // only promote known services; never invent one
    out.push({
      serviceOrderId: r.serviceOrderId,
      vehicleLabel: r.vehicleLabel ?? null,
      category,
      photoCount: r.photoCount,
      beforePhotoId: r.beforePhotoId,
      afterPhotoId: r.afterPhotoId,
    })
  }
  return out
}
