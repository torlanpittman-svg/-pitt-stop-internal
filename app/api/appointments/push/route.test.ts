/**
 * The enrolment route's HTTP contract, with the database and the VAPID config mocked.
 *
 * The one that matters: POST has TWO modes, and the automatic one is strictly narrower. The setup
 * screen re-registers the device every time it loads, so if that request could create, re-enable or
 * take over an enrolment, merely OPENING the screen would undo somebody's opt-out (their browser
 * subscription often still exists) or move a colleague's phone to whoever is signed in. 'refresh'
 * must therefore reach refreshSubscription and never saveSubscription, and a refusal must be a clean
 * 409 with no mutation attempted at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  actor: null as { key: string; name: string; role: string } | null,
  employeeSession: true,
  configured: true,
  saveCalls: [] as unknown[],
  refreshCalls: [] as unknown[],
  disableCalls: [] as unknown[],
  /** What refreshSubscription answers: a row, or null for "not an active enrolment of yours". */
  refreshResult: { id: 'sub-1' } as unknown,
}))

vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/apps/auth/employee-guard', () => ({
  authorizedManagerStrictFromRequest: async () => h.actor,
  employeeAuthorizedFromRequest: async () => h.employeeSession,
}))
vi.mock('@/apps/staff-alerts/db', () => ({
  mayEnrol: (a: { role?: string } | null) => !!a && (a.role === 'manager' || a.role === 'admin'),
  listSubscriptions: async () => [],
  saveSubscription: async (input: unknown, actor: unknown) => { h.saveCalls.push({ input, actor }); return { id: 'sub-saved' } },
  refreshSubscription: async (input: unknown, actor: unknown) => { h.refreshCalls.push({ input, actor }); return h.refreshResult },
  disableSubscription: async (endpoint: string, reason: string) => { h.disableCalls.push({ endpoint, reason }); return true },
}))
// The endpoint allowlist stays REAL — this route is where it is first enforced.
vi.mock('@/apps/staff-alerts/web-push', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/apps/staff-alerts/web-push')>(),
  pushConfig: () => (h.configured ? { vapid: { publicKey: 'BPub', privateKey: 'priv' }, subject: 'mailto:shop@example.com' } : null),
}))

import { DELETE, GET, POST } from './route'

const ENDPOINT = 'https://web.push.apple.com/the-endpoint'
const BODY = {
  endpoint: ENDPOINT,
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  label: 'iPhone · Safari',
}
const MANAGER = { key: 'torlan', name: 'Torlan', role: 'manager' }

const post = (body: unknown) => POST(new Request('https://app/api/appointments/push', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

beforeEach(() => {
  h.actor = MANAGER
  h.employeeSession = true
  h.configured = true
  h.saveCalls.length = 0
  h.refreshCalls.length = 0
  h.disableCalls.length = 0
  h.refreshResult = { id: 'sub-1' }
})

describe('the automatic refresh is strictly narrower than Enable', () => {
  it('mode:refresh goes ONLY to the refresh-only path', async () => {
    const res = await post({ ...BODY, mode: 'refresh' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, id: 'sub-1' })
    expect(h.refreshCalls).toHaveLength(1)
    expect(h.saveCalls).toEqual([])        // it must never be able to enrol, re-enable or transfer
  })

  it('answers 409 with an actionable message when there is nothing of yours to refresh', async () => {
    h.refreshResult = null                 // disabled device, or somebody else's
    const res = await post({ ...BODY, mode: 'refresh' })
    expect(res.status).toBe(409)
    const body = await res.json() as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/Tap Enable/)
    // No fallback to the enrolling path — the opt-out stands.
    expect(h.saveCalls).toEqual([])
  })

  it('mode:enroll — an explicit tap — still creates, re-enables and transfers', async () => {
    const res = await post({ ...BODY, mode: 'enroll' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, id: 'sub-saved' })
    expect(h.saveCalls).toHaveLength(1)
    expect(h.refreshCalls).toEqual([])
  })

  it('defaults to enroll when no mode is given, so older clients are unchanged', async () => {
    expect((await post(BODY)).status).toBe(200)
    expect(h.saveCalls).toHaveLength(1)
    expect(h.refreshCalls).toEqual([])
  })
})

describe('authorization and validation run before any write, in both modes', () => {
  it('refuses a non-manager', async () => {
    h.actor = { key: 'tony', name: 'Tony', role: 'employee' }
    for (const mode of ['enroll', 'refresh']) {
      expect((await post({ ...BODY, mode })).status).toBe(403)
    }
    h.actor = null
    expect((await post({ ...BODY, mode: 'refresh' })).status).toBe(403)
    expect(h.saveCalls).toEqual([])
    expect(h.refreshCalls).toEqual([])
  })

  it('refuses when the server has no VAPID keys', async () => {
    h.configured = false
    expect((await post({ ...BODY, mode: 'refresh' })).status).toBe(503)
    expect(h.refreshCalls).toEqual([])
  })

  it('refuses an endpoint that is not a known push service, in both modes', async () => {
    for (const mode of ['enroll', 'refresh']) {
      const res = await post({ ...BODY, endpoint: 'https://web.push.apple.com.evil.example/abc', mode })
      expect(res.status).toBe(400)
    }
    expect((await post({ ...BODY, endpoint: 'https://evil.example/abc' })).status).toBe(400)
    expect(h.saveCalls).toEqual([])
    expect(h.refreshCalls).toEqual([])
  })

  it('refuses a malformed subscription key', async () => {
    expect((await post({ ...BODY, p256dh: 'too-short' })).status).toBe(400)
    expect(h.saveCalls).toEqual([])
  })
})

describe('reading state and releasing a device are unchanged', () => {
  it('GET reports configuration and the public key to a manager only', async () => {
    const res = await GET(new Request('https://app/api/appointments/push'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, configured: true, publicKey: 'BPub' })
    h.actor = null
    expect((await GET(new Request('https://app/api/appointments/push'))).status).toBe(403)
  })

  it('DELETE only needs a valid employee session — whoever holds the phone may stop its alerts', async () => {
    h.actor = null
    const res = await DELETE(new Request('https://app/api/appointments/push', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: ENDPOINT, reason: 'signed_out' }),
    }))
    expect(res.status).toBe(200)
    expect(h.disableCalls).toEqual([{ endpoint: ENDPOINT, reason: 'signed_out' }])
  })

  it('DELETE refuses a signed-out caller', async () => {
    h.employeeSession = false
    const res = await DELETE(new Request('https://app/api/appointments/push', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: ENDPOINT }),
    }))
    expect(res.status).toBe(401)
    expect(h.disableCalls).toEqual([])
  })
})
