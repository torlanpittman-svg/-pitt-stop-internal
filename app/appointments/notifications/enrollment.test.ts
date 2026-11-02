/**
 * The notification setup screen's honesty rules, tested without a browser (this project has no DOM
 * test environment, so the rules live in enrollment.ts rather than inside the component).
 *
 * What these protect, in plain terms: the screen must never say "Notifications are ON" for a device
 * the server did not confirm, and it must never be left saying "Checking this device…". Both
 * failures look like a working feature while no booking alert ever arrives.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PUSH_API, TimeoutError, enrollDevice, enrollErrorForStatus, fetchPushStatus, refreshDevice,
  releaseDevice, stopDevice, withTimeout,
} from './enrollment'

const SUB = {
  endpoint: 'https://web.push.apple.com/the-endpoint',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  label: 'iPhone · Safari',
}

const json = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
const text = (status: number, body = 'not json') => vi.fn(async () => new Response(body, { status }))
const fetchOf = (impl: unknown) => impl as unknown as typeof fetch
/** A request that never answers — a phone with a half-open connection. */
const hangs = () => vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch

describe('enrollDevice — "ON" only when the server says so', () => {
  it('reports success only for HTTP ok AND ok:true in the body', async () => {
    const fetchImpl = json(200, { ok: true, id: 'sub-1' })
    expect(await enrollDevice(SUB, { fetchImpl: fetchOf(fetchImpl) })).toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(PUSH_API)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      endpoint: SUB.endpoint, p256dh: SUB.p256dh, auth: SUB.auth, label: SUB.label, mode: 'enroll',
    })
  })

  it('does NOT report success for a 200 whose body says ok:false', async () => {
    const out = await enrollDevice(SUB, { fetchImpl: fetchOf(json(200, { ok: false, error: 'That subscription could not be read.' })) })
    expect(out).toEqual({ ok: false, reason: 'server', error: 'That subscription could not be read.' })
  })

  it('does NOT report success for a 200 with no ok field at all', async () => {
    expect((await enrollDevice(SUB, { fetchImpl: fetchOf(json(200, { id: 'sub-1' })) })).ok).toBe(false)
  })

  it('does NOT report success for a 200 that is not JSON', async () => {
    expect((await enrollDevice(SUB, { fetchImpl: fetchOf(text(200)) })).ok).toBe(false)
  })

  it('explains a 403 as a sign-in problem the reader can fix', async () => {
    const out = await enrollDevice(SUB, { fetchImpl: fetchOf(json(403, { ok: false })) })
    expect(out).toMatchObject({ ok: false, reason: 'denied' })
    expect(out.ok === false && out.error).toMatch(/manager PIN/i)
  })

  it('separates "the server has no keys yet" (503) from a real failure', async () => {
    const out = await enrollDevice(SUB, { fetchImpl: fetchOf(json(503, { ok: false, error: 'Push notifications are not configured on the server yet.' })) })
    expect(out).toMatchObject({ ok: false, reason: 'not_configured' })
  })

  it('reports a 500 as a failure, never as ON', async () => {
    const out = await enrollDevice(SUB, { fetchImpl: fetchOf(json(500, { ok: false })) })
    expect(out).toMatchObject({ ok: false, reason: 'server' })
    expect(out.ok === false && out.error).toMatch(/error 500/)
  })

  it('reports a dropped connection as a failure, never as ON', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const out = await enrollDevice(SUB, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(out).toMatchObject({ ok: false, reason: 'network' })
    expect(out.ok === false && out.error).toMatch(/connection/i)
  })

  it('gives up on a request that never answers instead of waiting forever', async () => {
    const out = await enrollDevice(SUB, { fetchImpl: hangs(), timeoutMs: 20 })
    expect(out).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('prefers the server‘s own wording when it supplied one', async () => {
    const out = await enrollDevice(SUB, { fetchImpl: fetchOf(json(400, { ok: false, error: 'That subscription could not be read.' })) })
    expect(out.ok === false && out.error).toBe('That subscription could not be read.')
  })

  it('maps every status onto an actionable message, never a bare code', () => {
    for (const status of [401, 403, 400, 409, 422, 500, 503, 418]) {
      expect(enrollErrorForStatus(status).error.length).toBeGreaterThan(20)
    }
    expect(enrollErrorForStatus(401).reason).toBe('denied')
    expect(enrollErrorForStatus(503).reason).toBe('not_configured')
    expect(enrollErrorForStatus(409).reason).toBe('not_refreshable')
    expect(enrollErrorForStatus(422).reason).toBe('rejected')
    expect(enrollErrorForStatus(502).reason).toBe('server')
  })
})

describe('the automatic refresh asks for strictly less than Enable', () => {
  it('sends mode:"refresh", so the server cannot enrol, re-enable or transfer on a mere page load', async () => {
    const fetchImpl = json(200, { ok: true, id: 'sub-1' })
    expect(await refreshDevice(SUB, { fetchImpl: fetchOf(fetchImpl) })).toEqual({ ok: true })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).mode).toBe('refresh')
  })

  it('sends mode:"enroll" for an explicit tap', async () => {
    const fetchImpl = json(200, { ok: true, id: 'sub-1' })
    await enrollDevice(SUB, { fetchImpl: fetchOf(fetchImpl) })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).mode).toBe('enroll')
  })

  it('treats a refused refresh (409) as "off, tap Enable" rather than an error to fix', async () => {
    const out = await refreshDevice(SUB, { fetchImpl: fetchOf(json(409, { ok: false })) })
    expect(out).toMatchObject({ ok: false, reason: 'not_refreshable' })
    expect(out.ok === false && out.error).toMatch(/Tap Enable/)
  })

  it('does not report ON for a refused refresh, whatever the server says', async () => {
    for (const status of [409, 403, 500]) {
      expect((await refreshDevice(SUB, { fetchImpl: fetchOf(json(status, { ok: false })) })).ok).toBe(false)
    }
  })
})

describe('fetchPushStatus — "unknown" is not "nothing enrolled"', () => {
  it('returns the server state when it can be trusted', async () => {
    const devices = [{ id: 'd1', label: 'iPhone · Safari', enrolledAt: '2026-11-02T12:00:00.000Z', lastSuccessAt: null }]
    const out = await fetchPushStatus({ fetchImpl: fetchOf(json(200, { ok: true, configured: true, publicKey: 'BPk', devices })) })
    expect(out).toEqual({ configured: true, publicKey: 'BPk', devices })
  })

  it('returns null — not a fabricated "off" — for 403, 500, bad JSON, a dead connection or a hang', async () => {
    expect(await fetchPushStatus({ fetchImpl: fetchOf(json(403, { ok: false })) })).toBeNull()
    expect(await fetchPushStatus({ fetchImpl: fetchOf(json(500, { ok: false })) })).toBeNull()
    expect(await fetchPushStatus({ fetchImpl: fetchOf(text(200)) })).toBeNull()
    expect(await fetchPushStatus({ fetchImpl: fetchOf(json(200, { ok: true })) })).toBeNull()   // no `configured`
    expect(await fetchPushStatus({ fetchImpl: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch })).toBeNull()
    expect(await fetchPushStatus({ fetchImpl: hangs(), timeoutMs: 20 })).toBeNull()
  })

  it('tolerates a missing devices list rather than throwing on render', async () => {
    const out = await fetchPushStatus({ fetchImpl: fetchOf(json(200, { ok: true, configured: false, publicKey: null })) })
    expect(out).toEqual({ configured: false, publicKey: null, devices: [] })
  })
})

describe('releaseDevice — turning alerts off must not depend on the network', () => {
  it('reports whether the server accepted it, and never throws', async () => {
    expect(await releaseDevice(SUB.endpoint, 'disabled_by_staff', { fetchImpl: fetchOf(json(200, { ok: true, removed: true })) })).toBe(true)
    expect(await releaseDevice(SUB.endpoint, 'signed_out', { fetchImpl: fetchOf(json(500, { ok: false })) })).toBe(false)
    expect(await releaseDevice(SUB.endpoint, 'signed_out', { fetchImpl: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch })).toBe(false)
    expect(await releaseDevice(SUB.endpoint, 'signed_out', { fetchImpl: hangs(), timeoutMs: 20 })).toBe(false)
  })
})

describe('stopDevice — "off" only when something actually stopped', () => {
  const ok = () => fetchOf(json(200, { ok: true, removed: true }))
  const serverDown = () => fetchOf(json(500, { ok: false }))

  it('is stopped and silent when both halves succeed', async () => {
    const out = await stopDevice({ endpoint: SUB.endpoint, unsubscribe: async () => true }, { fetchImpl: ok() })
    expect(out).toEqual({ stopped: true, serverReleased: true, locallyUnsubscribed: true })
  })

  it('is NOT stopped when the server refuses AND the browser keeps the subscription', async () => {
    const out = await stopDevice({ endpoint: SUB.endpoint, unsubscribe: async () => false }, { fetchImpl: serverDown() })
    expect(out).toMatchObject({ stopped: false, serverReleased: false, locallyUnsubscribed: false })
    expect(out.error).toMatch(/could NOT be turned off/)
    expect(out.error).toMatch(/may still arrive/)
  })

  it('is NOT stopped when the server is unreachable and unsubscribe throws', async () => {
    const out = await stopDevice(
      { endpoint: SUB.endpoint, unsubscribe: async () => { throw new Error('no service worker') } },
      { fetchImpl: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch },
    )
    expect(out.stopped).toBe(false)
  })

  it('is NOT stopped when the server is unreachable and unsubscribe never answers', async () => {
    const out = await stopDevice(
      { endpoint: SUB.endpoint, unsubscribe: () => new Promise<boolean>(() => {}) },
      { fetchImpl: hangs(), timeoutMs: 20 },
    )
    expect(out).toMatchObject({ stopped: false, serverReleased: false, locallyUnsubscribed: false })
  })

  it('counts as stopped — with a caveat — when only the browser side worked', async () => {
    const out = await stopDevice({ endpoint: SUB.endpoint, unsubscribe: async () => true }, { fetchImpl: serverDown() })
    expect(out).toMatchObject({ stopped: true, serverReleased: false, locallyUnsubscribed: true })
    expect(out.error).toMatch(/server could not be told/)
  })

  it('counts as stopped — with a caveat — when only the server side worked', async () => {
    const out = await stopDevice({ endpoint: SUB.endpoint, unsubscribe: async () => false }, { fetchImpl: ok() })
    expect(out).toMatchObject({ stopped: true, serverReleased: true, locallyUnsubscribed: false })
    expect(out.error).toMatch(/no longer send/)
  })
})

describe('withTimeout — no unbounded wait anywhere on this screen', () => {
  it('passes a value straight through and clears its timer', async () => {
    await expect(withTimeout(Promise.resolve('ready'), 1_000, 'the worker')).resolves.toBe('ready')
  })

  it('passes a rejection through unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 1_000, 'the worker')).rejects.toThrow('nope')
  })

  it('rejects with a readable TimeoutError when the work never settles', async () => {
    const stuck = new Promise<never>(() => {})
    await expect(withTimeout(stuck, 20, 'the app’s background worker')).rejects.toThrow(TimeoutError)
    await expect(withTimeout(stuck, 20, 'the app’s background worker')).rejects.toThrow(/background worker/)
  })
})
