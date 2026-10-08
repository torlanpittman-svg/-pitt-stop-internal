import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { findContentCandidates, seedWeeklyPlan, listPosts, countPosts, createPost, updatePost } from './content'
import { weekStart } from './report'
import { MarketingInputError } from './validation'

const pg = new PGlite()
// customers must exist for the 0046 cross-module FKs; vehicles is joined for the real vehicle label.
const PARENTS = `
  CREATE TABLE customers (id uuid PRIMARY KEY, display_name text, active boolean NOT NULL DEFAULT true);
  CREATE TABLE vehicles (id uuid PRIMARY KEY, year text, make text, model text);
  CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_name text, vehicle_id uuid, status text,
    completed_at timestamptz, cancelled_at timestamptz, services jsonb);
  CREATE TABLE order_photos (id uuid PRIMARY KEY, service_order_id uuid, removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
`

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec('DELETE FROM marketing_social_posts; DELETE FROM marketing_events; DELETE FROM order_photos; DELETE FROM service_orders; DELETE FROM vehicles;')
})

async function completedOrderWithPhotos(service: string, photos: number, opts: { completed?: boolean } = {}): Promise<string> {
  const id = randomUUID()
  const vehicleId = randomUUID()
  await pg.query('INSERT INTO vehicles (id, year, make, model) VALUES ($1,$2,$3,$4)', [vehicleId, '2021', 'Chevrolet', 'Tahoe'])
  // customer_name is a PERSON ('Jane Customer') — it must never surface as the vehicle label.
  await pg.query('INSERT INTO service_orders (id, customer_name, vehicle_id, status, completed_at, services) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, 'Jane Customer', vehicleId, 'ready', opts.completed === false ? null : new Date(), JSON.stringify([service])])
  for (let i = 0; i < photos; i++) {
    await pg.query('INSERT INTO order_photos (id, service_order_id, created_at) VALUES ($1,$2,$3)',
      [randomUUID(), id, new Date(Date.now() + i * 1000)])
  }
  return id
}

describe('findContentCandidates', () => {
  it('uses the real vehicle (year/make/model), NOT the customer name, and no fabricated before/after roles', async () => {
    await completedOrderWithPhotos('Ceramic Coating', 3)
    const cands = await findContentCandidates()
    expect(cands).toHaveLength(1)
    expect(cands[0].category).toBe('ceramic')
    expect(cands[0].photoCount).toBe(3)
    expect(cands[0].vehicleLabel).toBe('2021 Chevrolet Tahoe')
    expect(cands[0].vehicleLabel).not.toBe('Jane Customer') // never the person's name
    expect(cands[0]).not.toHaveProperty('beforePhotoId')
    expect(cands[0]).not.toHaveProperty('afterPhotoId')
  })

  it('needs 2+ photos, a known premium service, and a COMPLETED non-cancelled job', async () => {
    await completedOrderWithPhotos('Ceramic Coating', 1) // too few photos
    await completedOrderWithPhotos('Random service text', 3) // unknown category → not promoted
    await completedOrderWithPhotos('Ceramic Coating', 3, { completed: false }) // not completed → excluded
    expect(await findContentCandidates()).toHaveLength(0)
  })
})

describe('seedWeeklyPlan', () => {
  it('seeds 3 posts and is idempotent (no duplicate seed spam)', async () => {
    const ws = weekStart(new Date('2026-10-07T00:00:00Z'))
    const first = await seedWeeklyPlan(ws, 'mgr')
    expect(first.created).toBe(3)
    expect(first.skipped).toBe(0)
    expect(await countPosts()).toBe(3)

    const second = await seedWeeklyPlan(ws, 'mgr')
    expect(second.created).toBe(0)
    expect(second.skipped).toBe(3)
    expect(await countPosts()).toBe(3) // still 3 — nothing duplicated

    const posts = await listPosts({ limit: 50 })
    expect(posts.map((p) => p.pillar).sort()).toEqual(['educate', 'proof', 'sell'])
  })
})

describe('updatePost — review/approval enforced at the service boundary', () => {
  it('cannot approve/schedule/post with empty copy', async () => {
    const p = await createPost({ pillar: 'educate', copy: '' }, 'mgr')
    await expect(updatePost(p.id, { status: 'approved' }, 'mgr')).rejects.toBeInstanceOf(MarketingInputError)
  })

  it('scheduling requires a date; posting requires the published link', async () => {
    const p = await createPost({ pillar: 'sell', copy: 'Ceramic coating season is here.' }, 'mgr')
    await expect(updatePost(p.id, { status: 'scheduled' }, 'mgr')).rejects.toBeInstanceOf(MarketingInputError)
    await expect(updatePost(p.id, { status: 'posted' }, 'mgr')).rejects.toBeInstanceOf(MarketingInputError)
  })

  it('records an approver when advancing past draft, and allows a complete posted record', async () => {
    const p = await createPost({ pillar: 'sell', copy: 'Ceramic coating season is here.' }, 'mgr')
    const approved = await updatePost(p.id, { status: 'approved' }, 'Manager Mia')
    expect(approved!.status).toBe('approved')
    expect(approved!.approvedBy).toBe('Manager Mia')

    const scheduled = await updatePost(p.id, { status: 'scheduled', scheduledAt: new Date('2026-10-07T12:00:00Z') }, 'Manager Mia')
    expect(scheduled!.status).toBe('scheduled')

    const posted = await updatePost(p.id, { status: 'posted', externalPostRef: 'https://facebook.com/pittstop/posts/123' }, 'Manager Mia')
    expect(posted!.status).toBe('posted')
    expect(posted!.externalPostRef).toContain('facebook.com')
  })
})
