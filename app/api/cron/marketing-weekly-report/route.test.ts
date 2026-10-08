import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Report is mocked so the 200 path doesn't touch a DB.
vi.mock('@/apps/marketing/report', () => ({
  weeklyReport: vi.fn(async () => ({
    current: { spendCents: 0, invoicedRevenueCents: 0, completedJobs: 0, leads: 0 },
    previous: { spendCents: 0, invoicedRevenueCents: 0, completedJobs: 0, leads: 0 },
  })),
}))

import { GET } from './route'

function req(auth?: string): Request {
  return new Request('https://app/api/cron/marketing-weekly-report', auth ? { headers: { authorization: auth } } : undefined)
}

beforeEach(() => { delete process.env.CRON_SECRET; delete process.env.MARKETING_CRON_TOKEN })
afterEach(() => { vi.unstubAllEnvs(); delete process.env.CRON_SECRET; delete process.env.MARKETING_CRON_TOKEN })

describe('marketing-weekly-report cron auth (fail-closed)', () => {
  it('denies when NO secret is configured (never falls open)', async () => {
    const res = await GET(req('Bearer anything'))
    expect(res.status).toBe(401)
  })

  it('denies a request with the wrong bearer when a secret IS configured', async () => {
    process.env.CRON_SECRET = 's3cret'
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('Bearer nope'))).status).toBe(401)
  })

  it('allows the correct bearer (CRON_SECRET or MARKETING_CRON_TOKEN)', async () => {
    process.env.CRON_SECRET = 's3cret'
    expect((await GET(req('Bearer s3cret'))).status).toBe(200)

    delete process.env.CRON_SECRET
    process.env.MARKETING_CRON_TOKEN = 'tok'
    expect((await GET(req('Bearer tok'))).status).toBe(200)
  })
})
