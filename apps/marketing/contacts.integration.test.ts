import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { contactAggregates, listMarketingContacts } from './contacts'
import { applySegment, estimateSegment, NAMED_SEGMENTS } from './segments'
import { grantSmsConsent, revokeSmsConsent } from './consent'

const pg = new PGlite()
const NOW = Date.now()
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

// Minimal canonical parents so the 0046 FKs resolve, then the marketing migration on top.
const PARENTS = `
  CREATE TABLE customers (
    id uuid PRIMARY KEY, display_name text, first_name text, last_name text,
    phone text, email text, active boolean NOT NULL DEFAULT true
  );
  CREATE TABLE service_orders (
    id uuid PRIMARY KEY, customer_id uuid, status text NOT NULL DEFAULT 'delivered',
    completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    approved_price_cents integer, services jsonb
  );
  CREATE TABLE order_photos (id uuid PRIMARY KEY);
  CREATE TABLE job_estimates (id uuid PRIMARY KEY, service_order_id uuid, total_cents integer);
`

const custA = randomUUID()  // high-value, ceramic + paint correction, recent
const custB = randomUUID()  // paint correction only, inactive 400d
const custC = randomUUID()  // unsubscribed
const custD = randomUUID()  // no orders, no contact info

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0047_marketing_sms_consent.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0047_marketing_sms_consent.sql', 'utf8')) // idempotent re-run
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())

beforeEach(async () => {
  await pg.exec('DELETE FROM marketing_preferences; DELETE FROM job_estimates; DELETE FROM service_orders; DELETE FROM customers;')

  await pg.query('INSERT INTO customers (id, display_name, phone, email) VALUES ($1,$2,$3,$4),($5,$6,$7,$8),($9,$10,$11,$12),($13,$14,$15,$16)', [
    custA, 'Alice Premium', '5120000001', 'alice@example.com',
    custB, 'Bob Paint', '5120000002', 'bob@example.com',
    custC, 'Carol Optout', '5120000003', 'carol@example.com',
    custD, 'Dan Nocontact', null, null,
  ])

  const o1 = randomUUID(), o2 = randomUUID(), o3 = randomUUID(), o4 = randomUUID()
  await pg.query(
    `INSERT INTO service_orders (id, customer_id, status, completed_at, created_at, approved_price_cents, services) VALUES
       ($1,$2,'delivered',$3,$3,$4,$5),
       ($6,$7,'delivered',$8,$8,$9,$10),
       ($11,$12,'delivered',$13,$13,$14,$15),
       ($16,$17,'delivered',$18,$18,$19,$20)`,
    [
      o1, custA, daysAgo(20), 80000, JSON.stringify(['Ceramic Coating 1yr']),
      o2, custA, daysAgo(60), 60000, JSON.stringify(['Paint correction']),
      o3, custB, daysAgo(400), 55000, JSON.stringify(['Paint correction']),
      o4, custC, daysAgo(30), 20000, JSON.stringify(['Interior detail']),
    ],
  )
  // Alice has a precise invoice total on one order (overrides approved price for that order).
  await pg.query('INSERT INTO job_estimates (id, service_order_id, total_cents) VALUES ($1,$2,$3)', [randomUUID(), o1, 90000])

  // Carol unsubscribed.
  await pg.query(
    'INSERT INTO marketing_preferences (id, customer_id, unsubscribed_at, unsubscribe_reason) VALUES ($1,$2,$3,$4)',
    [randomUUID(), custC, new Date(NOW).toISOString(), 'requested'],
  )
})

describe('contact aggregates from canonical data', () => {
  it('rolls up visits, revenue, average ticket, and purchased categories', async () => {
    const aggs = await contactAggregates()
    const byId = new Map(aggs.map((a) => [a.customerId, a]))
    expect(aggs).toHaveLength(4)

    const a = byId.get(custA)!
    expect(a.totalVisits).toBe(2)
    expect(a.lifetimeRevenueCents).toBe(150000) // 90000 (estimate) + 60000 (approved price)
    expect(a.avgTicketCents).toBe(75000)
    expect(a.categories).toEqual(['ceramic', 'paint_correction'])

    const b = byId.get(custB)!
    expect(b.categories).toEqual(['paint_correction'])
    expect(b.totalVisits).toBe(1)
  })

  it('reflects unsubscribe consent from marketing_preferences', async () => {
    const c = (await contactAggregates()).find((x) => x.customerId === custC)!
    expect(c.unsubscribed).toBe(true)
  })

  it('defaults eligibility to true for customers without a preferences row', async () => {
    const a = (await contactAggregates()).find((x) => x.customerId === custA)!
    expect(a.smsEligible).toBe(true)
    expect(a.emailEligible).toBe(true)
    expect(a.unsubscribed).toBe(false)
  })

  it('a phone number alone is NOT SMS consent (default smsConsent=false)', async () => {
    const a = (await contactAggregates()).find((x) => x.customerId === custA)!
    expect(a.phone).toBeTruthy()
    expect(a.smsConsent).toBe(false) // has a phone, but never opted in
  })

  it('granting SMS consent flips smsConsent to true; revoking flips it back', async () => {
    await grantSmsConsent(custA, { source: 'website_form', phone: '5120000001', actor: 'test' })
    expect((await contactAggregates()).find((x) => x.customerId === custA)!.smsConsent).toBe(true)
    await revokeSmsConsent(custA, { source: 'sms_keyword' })
    expect((await contactAggregates()).find((x) => x.customerId === custA)!.smsConsent).toBe(false)
  })
})

describe('segments over real aggregates', () => {
  it('inactive_365 catches Bob, not recent Alice', async () => {
    const aggs = await contactAggregates()
    const ids = applySegment(aggs, NAMED_SEGMENTS.inactive_365.criteria, NOW).map((c) => c.customerId)
    expect(ids).toContain(custB)
    expect(ids).not.toContain(custA)
  })

  it('paint_without_ceramic catches Bob (has paint, no ceramic), excludes Alice (has ceramic)', async () => {
    const aggs = await contactAggregates()
    const ids = applySegment(aggs, NAMED_SEGMENTS.paint_without_ceramic.criteria, NOW).map((c) => c.customerId)
    expect(ids).toEqual([custB])
  })

  it('high_value catches Alice and excludes the unsubscribed Carol', async () => {
    const aggs = await contactAggregates()
    const est = estimateSegment(aggs, NAMED_SEGMENTS.high_value.criteria, NOW)
    const ids = applySegment(aggs, NAMED_SEGMENTS.high_value.criteria, NOW).map((c) => c.customerId)
    expect(ids).toContain(custA)
    expect(ids).not.toContain(custC)
    expect(est.total).toBeGreaterThanOrEqual(1)
  })
})

describe('paginated contact listing', () => {
  it('sorts by lifetime revenue and paginates', async () => {
    const page = await listMarketingContacts({ page: 1, pageSize: 2, now: NOW })
    expect(page.total).toBe(4)
    expect(page.contacts).toHaveLength(2)
    expect(page.contacts[0].customerId).toBe(custA) // highest lifetime revenue first
  })

  it('filters by search text', async () => {
    const page = await listMarketingContacts({ search: 'bob', now: NOW })
    expect(page.total).toBe(1)
    expect(page.contacts[0].customerId).toBe(custB)
  })
})
