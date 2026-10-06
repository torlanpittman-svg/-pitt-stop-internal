import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { marketingReport, weekStart } from './report'
import { upsertAdMetric } from './ads'
import { recordAttribution } from './attribution'
import { createLead } from './leads'

const pg = new PGlite()

const PARENTS = `
  CREATE TABLE customers (id uuid PRIMARY KEY, display_name text, first_name text, last_name text, phone text, email text, active boolean NOT NULL DEFAULT true);
  CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text, completed_at timestamptz, created_at timestamptz, approved_price_cents integer, services jsonb);
  CREATE TABLE order_photos (id uuid PRIMARY KEY);
`
const RANGE = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-07T23:59:59Z') }

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec('DELETE FROM marketing_ad_metrics; DELETE FROM marketing_attribution; DELETE FROM marketing_leads; DELETE FROM marketing_events;')
})

describe('weekly report', () => {
  it('renders an honest empty state (all zeros, no invented analytics)', async () => {
    const r = await marketingReport(RANGE)
    expect(r.isEmpty).toBe(true)
    expect(r.spendCents).toBe(0)
    expect(r.attributedRevenueCents).toBe(0)
    expect(r.roas).toBeNull()
    expect(r.leads).toBe(0)
    expect(r.byChannel).toEqual([])
  })

  it('computes spend, attributed revenue, ROAS and service breakdown from stored data', async () => {
    // Google Ads: ceramic hugely profitable, general detailing barely.
    await upsertAdMetric({ serviceCategory: 'ceramic', statDate: '2026-10-03', spendCents: 41000, clicks: 50, conversions: 3, revenueCents: 430000 }, 'admin')
    await upsertAdMetric({ serviceCategory: 'general', statDate: '2026-10-03', spendCents: 39000, clicks: 80, conversions: 1, revenueCents: 55000 }, 'admin')
    // A reactivation campaign win (non-ads revenue lives in attribution).
    await recordAttribution({ source: 'sms', confidence: 'direct', revenueCents: 224000, occurredAt: new Date('2026-10-04T00:00:00Z') }, 'admin')
    await createLead({ source: 'google_ads', name: 'Lead A' }, 'admin')
    await createLead({ source: 'facebook_organic', name: 'Lead B' }, 'admin')

    const r = await marketingReport(RANGE)
    expect(r.isEmpty).toBe(false)
    expect(r.spendCents).toBe(80000)
    expect(r.adRevenueCents).toBe(485000)
    expect(r.attributionRevenueCents).toBe(224000)
    expect(r.attributedRevenueCents).toBe(709000)
    expect(r.roas).toBeCloseTo(8.9, 1) // 709000 / 80000
    expect(r.leads).toBe(2)

    const ceramic = r.byService.find((s) => s.serviceCategory === 'ceramic')!
    const general = r.byService.find((s) => s.serviceCategory === 'general')!
    expect(ceramic.roas).toBeGreaterThan(general.roas!) // ceramic far more profitable

    const gaChannel = r.byChannel.find((c) => c.channel === 'google_ads')!
    expect(gaChannel.spendCents).toBe(80000)
    expect(gaChannel.leads).toBe(1)
  })

  it('keeps unknown attribution labeled unknown (never forced to a channel)', async () => {
    await recordAttribution({ source: 'unknown', confidence: 'unknown', revenueCents: 10000, occurredAt: new Date('2026-10-02T00:00:00Z') }, 'admin')
    const r = await marketingReport(RANGE)
    const unknown = r.bySource.find((s) => s.source === 'unknown')!
    expect(unknown.unknown).toBe(1)
    expect(unknown.revenueCents).toBe(10000)
  })
})

describe('weekStart', () => {
  it('snaps to Monday', () => {
    expect(weekStart(new Date('2026-10-07T12:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-05') // Mon
    expect(weekStart(new Date('2026-10-05T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-05')
  })
})
