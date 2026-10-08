import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { MarketingConfig } from '@/apps/settings/db'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))

// Controlled marketing config (dispatch reads getMarketingConfig; we drive it per test).
let cfg: MarketingConfig
vi.mock('@/apps/settings/db', () => ({ getMarketingConfig: vi.fn(async () => cfg) }))

import { getDb } from '@/platform/db'
import { dispatchCampaign, withinQuietHours, SEND_DEFERRED } from './dispatch'
import { createCampaign, insertRecipients, transitionCampaign, getCampaign } from './db'

const pg = new PGlite()
const PARENTS = `
  CREATE TABLE customers (id uuid PRIMARY KEY, display_name text, phone text, normalized_phone text, email text, active boolean NOT NULL DEFAULT true);
  CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text);
`
function baseCfg(over: Partial<MarketingConfig> = {}): MarketingConfig {
  return {
    enabled: true, requireApproval: true, sendDailyCap: 500, attributionWindowDays: 30, highValueCents: 100000, defaultOffer: '',
    smsLive: false, smsBrandName: 'Pitt Stop Detail', smsHelpText: 'Reply HELP for help.', smsFrequency: '1-2/mo',
    privacyUrl: '', termsUrl: '', smsQuietStartHour: 9, smsQuietEndHour: 20, smsGlobalCap: 250,
    publicBaseUrl: '', legalName: 'Pitt Stop Detail & Auto Sales', businessWebsite: '', supportContact: '',
    a2pBrandApproved: false, a2pCampaignApproved: false, advancedOptOutConfigured: false,
    optInPublished: false, webhooksVerified: false, privacyPublished: false, termsPublished: false, ...over,
  }
}

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0047_marketing_sms_consent.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0048_marketing_sms_delivery.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec('DELETE FROM marketing_campaign_recipients; DELETE FROM marketing_campaigns; DELETE FROM marketing_events; DELETE FROM customers;')
  cfg = baseCfg()
  delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_MESSAGING_SERVICE_SID
})
afterEach(() => {
  delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_MESSAGING_SERVICE_SID
})

async function readyCampaign(nRecipients = 2) {
  const c = await createCampaign({ name: 'Dispatch test', channel: 'sms', smsCopy: 'Hi' }, 'test')
  const seeds = []
  for (let i = 0; i < nRecipients; i++) {
    const id = randomUUID()
    await pg.query('INSERT INTO customers (id, display_name, phone, normalized_phone) VALUES ($1,$2,$3,$4)', [id, `R${i}`, '+15125550123', '5125550123'])
    seeds.push({ customerId: id, channel: 'sms' as const, addressSnapshot: '+15125550123', status: 'pending' as const, renderedBody: 'Hi there' })
  }
  await insertRecipients(c.id, seeds)
  await transitionCampaign(c.id, 'ready', 'test')
  return c.id
}

describe('withinQuietHours', () => {
  it('is true inside the window and false outside', () => {
    const inside = new Date('2026-10-06T18:00:00Z')  // ~13:00 Central
    const outside = new Date('2026-10-06T08:00:00Z') // ~03:00 Central
    expect(withinQuietHours(inside, 9, 20)).toBe(true)
    expect(withinQuietHours(outside, 9, 20)).toBe(false)
  })
})

async function statuses(campaignId: string): Promise<string[]> {
  const res = await pg.query('SELECT status FROM marketing_campaign_recipients WHERE campaign_id = $1', [campaignId])
  return (res.rows as { status: string }[]).map((r) => r.status)
}

describe('dispatch — non-destructive preview, SMS deferred in V1', () => {
  it('SEND_DEFERRED is a hard, reviewed constant (not env/settings driven)', () => {
    expect(SEND_DEFERRED).toBe(true)
  })

  it('previews without mutating: campaign stays ready, recipients stay pending', async () => {
    const id = await readyCampaign(2)
    const r = await dispatchCampaign(id)
    expect(r.ok).toBe(true)
    expect(r.live).toBe(false)
    expect(r.deferred).toBe(true)
    expect(r.preview?.dryRun).toBe(true)
    expect(r.preview?.total).toBe(2)
    expect(r.preview?.wouldSend).toBe(2)
    const c = await getCampaign(id)
    expect(c?.status).toBe('ready')   // NOT transitioned to sending/sent
    expect(c?.sentCount).toBe(0)
    expect(await statuses(id)).toEqual(['pending', 'pending']) // nothing suppressed
  })

  it('stays a non-destructive preview even with sms_live ON and Twilio configured (no live config bypass)', async () => {
    cfg = baseCfg({ smsLive: true })
    process.env.TWILIO_ACCOUNT_SID = 'AC'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG'
    const id = await readyCampaign(2)
    const r = await dispatchCampaign(id) // live config present, overnight — still a preview
    expect(r.ok).toBe(true)
    expect(r.live).toBe(false)
    expect(r.preview?.dryRun).toBe(true)
    const c = await getCampaign(id)
    expect(c?.status).toBe('ready')
    expect(await statuses(id)).toEqual(['pending', 'pending'])
  })

  it('reports the per-run cap without changing anything', async () => {
    cfg = baseCfg({ smsGlobalCap: 1 })
    const id = await readyCampaign(3)
    const r = await dispatchCampaign(id)
    expect(r.preview?.wouldSend).toBe(1)
    expect(r.preview?.capped).toBe(2)
    expect((await getCampaign(id))?.status).toBe('ready') // non-destructive
    expect(await statuses(id)).toEqual(['pending', 'pending', 'pending'])
  })
})
