import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { createCampaign, getCampaign, listRecipients, transitionCampaign, InvalidTransitionError } from './db'
import { buildCampaignRecipients, sendCampaign } from './campaigns'
import { linkRecipientOutcome, campaignFunnel } from './attribution'
import { grantSmsConsent } from './consent'
import type { Providers, SendResult } from './providers'

const pg = new PGlite()
const NOW = Date.now()
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const PARENTS = `
  CREATE TABLE customers (id uuid PRIMARY KEY, display_name text, first_name text, last_name text, phone text, email text, active boolean NOT NULL DEFAULT true);
  CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text NOT NULL DEFAULT 'delivered',
    completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), approved_price_cents integer, services jsonb);
  CREATE TABLE order_photos (id uuid PRIMARY KEY);
  CREATE TABLE job_estimates (id uuid PRIMARY KEY, service_order_id uuid, total_cents integer);
`

const both = randomUUID()     // phone + email, eligible
const smsOnly = randomUUID()  // phone only
const optout = randomUUID()   // unsubscribed
const noContact = randomUUID()// no phone/email

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0047_marketing_sms_consent.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())

beforeEach(async () => {
  await pg.exec(`DELETE FROM marketing_attribution; DELETE FROM marketing_campaign_recipients;
    DELETE FROM marketing_campaigns; DELETE FROM marketing_preferences; DELETE FROM marketing_events;
    DELETE FROM service_orders; DELETE FROM customers;`)
  await pg.query('INSERT INTO customers (id, display_name, phone, email) VALUES ($1,$2,$3,$4),($5,$6,$7,$8),($9,$10,$11,$12),($13,$14,$15,$16)', [
    both, 'Both Channels', '5120000001', 'both@example.com',
    smsOnly, 'Sms Only', '5120000002', null,
    optout, 'Opt Out', '5120000003', 'opt@example.com',
    noContact, 'No Contact', null, null,
  ])
  // Each gets a recent order so they are a real customer in the aggregate.
  for (const id of [both, smsOnly, optout, noContact]) {
    await pg.query('INSERT INTO service_orders (id, customer_id, status, completed_at, created_at, approved_price_cents, services) VALUES ($1,$2,$3,$4,$4,$5,$6)',
      [randomUUID(), id, 'delivered', daysAgo(10), 50000, JSON.stringify(['Full detail'])])
  }
  await pg.query('INSERT INTO marketing_preferences (id, customer_id, unsubscribed_at) VALUES ($1,$2,$3)', [randomUUID(), optout, new Date(NOW).toISOString()])
  // SMS consent is required to receive texts. Grant it ONLY to `both` — `smsOnly` has a phone but no
  // consent, proving a phone number alone never qualifies.
  await grantSmsConsent(both, { source: 'website_form', phone: '5120000001', actor: 'test' })
})

async function newBuiltCampaign(channel: 'sms' | 'email' | 'both' = 'both', criteria: Record<string, unknown> = { requireContactable: true }) {
  const c = await createCampaign({
    name: 'Reactivation', channel, segmentCriteria: criteria as never,
    smsCopy: 'Hi {{name}}, your {{vehicle}} is due for a reset. Reply to book.',
    emailSubject: 'Time for a reset', emailBody: 'Hi {{name}}, your {{vehicle}} is due.',
  }, 'Torlan')
  const summary = await buildCampaignRecipients(c.id, { now: NOW, actor: 'Torlan' })
  return { campaign: await getCampaign(c.id), summary }
}

describe('recipient building + consent', () => {
  it('excludes unsubscribed and unreachable customers with reasons', async () => {
    // Permissive segment (no requireContactable) so ineligible contacts still surface as audited
    // `excluded` rows at the recipient stage with a reason.
    const { campaign, summary } = await newBuiltCampaign('both', {})
    const recips = await listRecipients(campaign!.id)
    const byReason = recips.filter((r) => r.status === 'excluded').map((r) => r.exclusionReason)
    // optout → unsubscribed; noContact → no_phone/no_email; smsOnly → no_sms_consent (phone, no opt-in) + no_email.
    expect(byReason).toContain('unsubscribed')
    expect(byReason).toContain('no_email')
    expect(byReason).toContain('no_phone')
    expect(byReason).toContain('no_sms_consent') // a phone number is NOT consent
    expect(summary.matched).toBeGreaterThan(0)
    // Nobody unsubscribed is ever pending.
    const optoutRows = recips.filter((r) => r.customerId === optout)
    expect(optoutRows.every((r) => r.status === 'excluded')).toBe(true)
  })

  it('is deterministic and idempotent (re-build inserts nothing new)', async () => {
    const { campaign } = await newBuiltCampaign('sms')
    const first = await listRecipients(campaign!.id)
    const again = await buildCampaignRecipients(campaign!.id, { now: NOW })
    expect(again.inserted).toBe(0)
    const second = await listRecipients(campaign!.id)
    expect(second).toHaveLength(first.length)
  })

  it('personalizes the rendered body with the customer name', async () => {
    const { campaign } = await newBuiltCampaign('sms')
    const pending = (await listRecipients(campaign!.id)).filter((r) => r.status === 'pending')
    expect(pending.length).toBeGreaterThan(0)
    expect(pending[0].renderedBody).toContain('your vehicle') // {{vehicle}} fallback, never blank token
    expect(pending[0].renderedBody).not.toContain('{{')
  })
})

describe('dry-run send never pretends to send', () => {
  it('suppresses recipients, records zero real sends, and flags dry_run', async () => {
    const { campaign } = await newBuiltCampaign('both')
    await transitionCampaign(campaign!.id, 'ready', 'Torlan')
    const result = await sendCampaign(campaign!.id, { actor: 'Torlan' }) // default providers = dry-run
    expect(result.dryRun).toBe(true)
    expect(result.sent).toBe(0)
    expect(result.suppressed).toBeGreaterThan(0)
    const after = await getCampaign(campaign!.id)
    expect(after!.status).toBe('sent')
    expect(after!.dryRun).toBe(true)
    expect(after!.sentCount).toBe(0)
    const sentRows = (await listRecipients(campaign!.id)).filter((r) => r.status === 'sent')
    expect(sentRows).toHaveLength(0) // nothing is ever marked sent in dry-run
  })
})

describe('live send (fake live provider)', () => {
  function liveProviders(): Providers {
    const ok = async (): Promise<SendResult> => ({ status: 'sent', providerMessageId: 'x1' })
    return {
      sms: { name: 'fake-sms', live: true, send: ok },
      email: { name: 'fake-email', live: true, send: ok },
      facebook: { name: 'f', live: false, publishPost: async () => ({ status: 'dry_run' }), fetchComments: async () => [] },
      googleAds: { name: 'g', live: false, fetchMetrics: async () => [] },
    }
  }

  it('marks recipients sent, counts real sends, and is idempotent on re-send', async () => {
    const { campaign } = await newBuiltCampaign('sms')
    await transitionCampaign(campaign!.id, 'ready', 'Torlan')
    const res = await sendCampaign(campaign!.id, { actor: 'Torlan', providers: liveProviders() })
    expect(res.dryRun).toBe(false)
    expect(res.sent).toBeGreaterThan(0)
    const after = await getCampaign(campaign!.id)
    expect(after!.status).toBe('sent')
    expect(after!.dryRun).toBe(false)
    expect(after!.sentCount).toBe(res.sent)

    // Re-sending a sent campaign is a safe no-op (no duplicate sends).
    const reSend = await sendCampaign(campaign!.id, { actor: 'Torlan', providers: liveProviders() })
    expect(reSend.alreadySent).toBe(true)
    expect(reSend.sent).toBe(res.sent)
  })
})

describe('status machine enforcement', () => {
  it('rejects an illegal transition', async () => {
    const { campaign } = await newBuiltCampaign('sms')
    await expect(transitionCampaign(campaign!.id, 'completed', 'Torlan')).rejects.toBeInstanceOf(InvalidTransitionError)
  })
})

describe('attribution funnel', () => {
  it('links a booking + revenue and reports it in the funnel', async () => {
    const { campaign } = await newBuiltCampaign('sms')
    await transitionCampaign(campaign!.id, 'ready', 'Torlan')
    await sendCampaign(campaign!.id, { actor: 'Torlan' })
    const recips = await listRecipients(campaign!.id)
    const target = recips.find((r) => r.customerId === both || r.customerId === smsOnly)!

    const orderId = randomUUID()
    await pg.query('INSERT INTO service_orders (id, customer_id, status) VALUES ($1,$2,$3)', [orderId, target.customerId, 'delivered'])
    await linkRecipientOutcome(target.id, { bookedOrderId: orderId, completedRevenueCents: 65000 }, 'Torlan')

    const funnel = await campaignFunnel(campaign!.id)
    expect(funnel.appointments).toBe(1)
    expect(funnel.completedJobs).toBe(1)
    expect(funnel.completedRevenueCents).toBe(65000)

    // A direct attribution row was recorded.
    const attr = await pg.query('SELECT source, confidence, revenue_cents FROM marketing_attribution')
    expect(attr.rows).toHaveLength(1)
    expect((attr.rows[0] as { confidence: string }).confidence).toBe('direct')
  })
})
