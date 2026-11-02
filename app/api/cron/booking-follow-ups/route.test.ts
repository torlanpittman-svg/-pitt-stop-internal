import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The jobs are mocked so the auth/ordering checks never touch a DB or an email provider.
const calls: string[] = []
vi.mock('@/apps/appointments/drafts', () => ({
  purgeExpiredDrafts: vi.fn(async () => { calls.push('purge'); return { enabled: true, purged: 0, recovered: 0 } }),
  dispatchDraftFollowUps: vi.fn(async () => { calls.push('dispatch'); return { enabled: true, sent: 0, notConfigured: 0, failed: 0, suppressed: 0, deferred: 0, recovered: 0 } }),
}))

vi.mock('@/apps/staff-alerts/db', () => ({
  dispatchStaffAlerts: vi.fn(async () => { calls.push('staff-alerts'); return { sent: 0, retrying: 0, failed: 0, expired: 0, skipped: 0, staleAlerts: 0, deferred: 0, notConfigured: true } }),
}))

import { GET } from './route'

function req(auth?: string): Request {
  return new Request('https://app/api/cron/booking-follow-ups', auth ? { headers: { authorization: auth } } : undefined)
}

beforeEach(() => { delete process.env.CRON_SECRET; calls.length = 0 })
afterEach(() => { delete process.env.CRON_SECRET })

describe('booking-follow-ups cron (fail-closed)', () => {
  it('denies when NO secret is configured (never falls open)', async () => {
    expect((await GET(req('Bearer anything'))).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('denies a missing or wrong bearer', async () => {
    process.env.CRON_SECRET = 's3cret'
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('Bearer nope'))).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('with the right bearer, erases expired drafts BEFORE sending follow-ups', async () => {
    process.env.CRON_SECRET = 's3cret'
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(200)
    // Customer-facing jobs first; the staff push retry runs last and can never delay or block them.
    expect(calls).toEqual(['purge', 'dispatch', 'staff-alerts'])
  })

  it('still reports success when the staff push retry itself fails', async () => {
    process.env.CRON_SECRET = 's3cret'
    const { dispatchStaffAlerts } = await import('@/apps/staff-alerts/db')
    vi.mocked(dispatchStaffAlerts).mockRejectedValueOnce(new Error('push service unreachable'))
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, staffAlerts: { error: 'dispatch failed' } })
  })
})
