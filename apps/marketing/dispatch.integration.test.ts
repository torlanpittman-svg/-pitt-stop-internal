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
import { dispatchCampaign, withinQuietHours } from './dispatch'
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

describe('dispatch send-safety', () => {
  it.each(['a2pBrandApproved', 'a2pCampaignApproved', 'advancedOptOutConfigured', 'optInPublished', 'privacyPublished', 'termsPublished', 'webhooksVerified', 'enabled'] as const)('blocks live SMS while %s is false', async (key) => {
    cfg = baseCfg({ smsLive: true, publicBaseUrl: 'https://text.example.com', supportContact: 'shop@example.com', a2pBrandApproved: true, a2pCampaignApproved: true, advancedOptOutConfigured: true, optInPublished: true, privacyPublished: true, termsPublished: true, webhooksVerified: true, [key]: false })
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC')
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token')
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', 'MG')
    vi.stubEnv('TWILIO_WEBHOOK_BASE_URL', 'https://internal.example.com')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const id = await readyCampaign(1)
    const result = await dispatchCampaign(id, { now: new Date('2026-10-06T18:00:00Z') })
    expect(result.reason).toBe('launch_not_ready')
    expect((await getCampaign(id))?.status).toBe('ready')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    vi.unstubAllEnvs()
  })
  it('forces DRY-RUN when sms_live is off — nothing is sent even though recipients are ready', async () => {
    const id = await readyCampaign(2)
    const r = await dispatchCampaign(id, { actor: 'test' })
    expect(r.ok).toBe(true)
    expect(r.live).toBe(false)
    expect(r.summary?.dryRun).toBe(true)
    expect(r.summary?.sent).toBe(0)
    expect((await getCampaign(id))?.dryRun).toBe(true)
  })

  it('refuses a live SMS send when Twilio is NOT configured (sms_live on, no creds)', async () => {
    cfg = baseCfg({ smsLive: true })
    const id = await readyCampaign(1)
    const r = await dispatchCampaign(id, { actor: 'test' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('sms_not_configured')
    expect((await getCampaign(id))?.status).toBe('ready') // not sent
  })

  it('blocks a live send outside quiet hours (configured Twilio, overnight)', async () => {
    cfg = baseCfg({ smsLive: true })
    process.env.TWILIO_ACCOUNT_SID = 'AC'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG'
    const id = await readyCampaign(1)
    const r = await dispatchCampaign(id, { actor: 'test', now: new Date('2026-10-06T08:00:00Z') }) // ~3am Central
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('quiet_hours')
    expect((await getCampaign(id))?.status).toBe('ready') // nothing sent
  })

  it('enforces the per-run SMS cap (dry-run): extra recipients stay pending', async () => {
    cfg = baseCfg({ smsGlobalCap: 1 })
    const id = await readyCampaign(3)
    const r = await dispatchCampaign(id, { actor: 'test' })
    expect(r.summary?.capped).toBe(2)       // 3 pending, cap 1 → 2 held back
    expect((await getCampaign(id))?.status).toBe('sending') // not finalized while capped
  })
})
