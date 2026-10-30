/**
 * The quick-sticker HTTP contract: these paths are NOT in proxy.ts's matcher (exactly like the
 * job-sticker routes), so the handler itself is the gate — it must fail closed for an
 * unauthenticated or anonymous session before any sticker work runs, and it must pass the
 * signed-in actor through as the OWNER of the request rather than trusting the body.
 * No database, no printer: the service layer is mocked (it is covered against real Postgres in
 * apps/stickers/quick.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StickerValidationError } from '@/apps/stickers/service'

const auth = vi.hoisted(() => ({ actor: null as { key: string; name: string; role: string } | null }))
const calls = vi.hoisted(() => ({ queue: [] as { input: Record<string, unknown>; actor: unknown }[], status: [] as unknown[], boot: [] as unknown[] }))
/** Injected service outcomes — no spying on ESM exports. */
const fail = vi.hoisted(() => ({ queue: null as unknown, status: null as unknown }))

vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => auth.actor,
}))
vi.mock('@/apps/stickers/quick', () => ({
  quickStickerBootstrap: async (actor: unknown) => {
    calls.boot.push(actor)
    return { actorKey: 'tony', actorName: 'Tony', defaults: { intervalMiles: 5000, intervalMonths: 6 }, today: '2026-10-30', bridge: { online: true, labelPrinterConfigured: true } }
  },
  queueQuickStickerPrint: async (input: Record<string, unknown>, actor: unknown) => {
    calls.queue.push({ input, actor })
    if (fail.queue) throw fail.queue
    return { requestId: input.requestId, job: { jobId: input.requestId, status: 'queued', error: null, uncertain: false, createdAt: 'now' }, alreadyQueued: false }
  },
  quickStickerJobStatus: async (requestId: unknown, actor: unknown) => {
    calls.status.push({ requestId, actor })
    if (fail.status) throw fail.status
    return { jobId: requestId, status: 'submitted', error: null, uncertain: false, createdAt: 'now' }
  },
}))

import { GET, POST } from './route'
import { GET as STATUS } from './status/route'

const REQ = '11111111-1111-4111-8111-111111111111'
const TECH = { key: 'tony', name: 'Tony', role: 'employee' }

const get = () => GET(new Request('http://x/api/oil-sticker'))
const post = (body: unknown) => POST(new Request('http://x/api/oil-sticker', { method: 'POST', body: JSON.stringify(body) }))
const status = (qs: string) => STATUS(new Request(`http://x/api/oil-sticker/status${qs}`))

beforeEach(() => {
  auth.actor = TECH
  calls.queue = []; calls.status = []; calls.boot = []
  fail.queue = null; fail.status = null
})

describe('authorization — the handler is the gate', () => {
  it('a signed-out or anonymous session is refused by every route before any work runs', async () => {
    auth.actor = null
    expect((await get()).status).toBe(401)
    expect((await post({ requestId: REQ, mileage: 187781 })).status).toBe(401)
    expect((await status(`?requestId=${REQ}`)).status).toBe(401)
    expect(calls.boot).toHaveLength(0)
    expect(calls.queue).toHaveLength(0)
    expect(calls.status).toHaveLength(0)
  })

  it('any signed-in role may print — and the SERVER-resolved actor is the owner, never the body', async () => {
    for (const role of ['employee', 'manager', 'admin']) {
      auth.actor = { ...TECH, role }
      expect((await post({ requestId: REQ, mileage: 187781, intervalMiles: 5000, intervalMonths: 6, actorKey: 'someone-else' })).status).toBe(200)
    }
    expect(calls.queue).toHaveLength(3)
    for (const c of calls.queue) {
      expect(c.actor).toMatchObject({ key: 'tony' })
      expect(c.input).not.toHaveProperty('actorKey') // a client-supplied owner is simply not read
    }
  })
})

describe('POST /api/oil-sticker', () => {
  it('passes the request token and the values through verbatim', async () => {
    await post({ requestId: REQ, mileage: 187781, intervalMiles: 5000, intervalMonths: 6, nextMileage: 200000, nextDate: '2027-01-15' })
    expect(calls.queue[0].input).toEqual({ requestId: REQ, mileage: 187781, intervalMiles: 5000, intervalMonths: 6, nextMileage: 200000, nextDate: '2027-01-15' })
  })

  it('decimals are NOT truncated into a different sticker — validation sees what was sent', async () => {
    await post({ requestId: REQ, mileage: 187781.9, intervalMiles: 5000.5, intervalMonths: 6, nextMileage: 200000.4, nextDate: '2027-01-15' })
    expect(calls.queue[0].input).toMatchObject({ mileage: 187781.9, intervalMiles: 5000.5, nextMileage: 200000.4 })
  })

  it('a missing interval is null (date-only / mileage-only reminders are legitimate)', async () => {
    await post({ requestId: REQ, mileage: 1000, nextMileage: 6000, nextDate: '2027-01-15' })
    expect(calls.queue[0].input).toMatchObject({ intervalMiles: null, intervalMonths: null, mileage: 1000 })
  })

  it('a non-numeric or non-finite mileage reaches validation as invalid rather than becoming 0', async () => {
    for (const mileage of ['187781', null, true, {}]) {
      calls.queue = []
      await post({ requestId: REQ, mileage })
      expect(calls.queue[0].input).toMatchObject({ mileage: -1 })
    }
  })

  it('a missing token reaches validation as empty — it is never invented server-side', async () => {
    await post({ mileage: 187781 })
    expect(calls.queue[0].input).toMatchObject({ requestId: '' })
  })

  it('unreadable JSON is a 400, not a 500', async () => {
    const res = await POST(new Request('http://x/api/oil-sticker', { method: 'POST', body: 'not json' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_json' })
    expect(calls.queue).toHaveLength(0)
  })

  it('a body that is not an object (null, array, string, number) is a 400 and queues nothing', async () => {
    for (const body of [null, [], ['x'], 'mileage', 7]) {
      calls.queue = []
      const res = await post(body)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid_body' })
      expect(calls.queue).toHaveLength(0)
    }
  })

  it('a validation refusal is 422 with the shop-readable reason', async () => {
    fail.queue = new StickerValidationError('Enter the vehicle’s current mileage (whole number).', 'bad_mileage')
    const res = await post({ requestId: REQ, mileage: -4 })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'bad_mileage' })
  })

  it('a token that is not ours is 409 — never a silent new print', async () => {
    fail.queue = new StickerValidationError('This print request could not be used.', 'request_id_conflict')
    expect((await post({ requestId: REQ, mileage: 187781 })).status).toBe(409)
  })

  it('an unexpected failure is a 500 with a generic message — no internal detail leaks', async () => {
    fail.queue = new Error('syntax error at or near "INSERT INTO print_jobs"')
    const res = await post({ requestId: REQ, mileage: 187781 })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'server_error', message: 'Something went wrong on the shop server — try again.' })
    expect(JSON.stringify(body)).not.toContain('print_jobs')
  })
})

describe('GET /api/oil-sticker/status', () => {
  it('reports the job for its own actor', async () => {
    const res = await status(`?requestId=${REQ}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'submitted' })
    expect(calls.status[0]).toMatchObject({ requestId: REQ, actor: { key: 'tony' } })
  })

  it('requires a token', async () => {
    expect((await status('')).status).toBe(400)
    expect(calls.status).toHaveLength(0)
  })

  it('someone else’s (or a check job’s) token is a plain 404 — nothing is leaked', async () => {
    fail.status = new StickerValidationError('Print job not found.', 'job_not_found')
    const res = await status(`?requestId=${REQ}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'job_not_found', message: 'Print job not found.' })
  })

  it('a malformed token is 422, not 404, so the UI can say "reopen the form"', async () => {
    fail.status = new StickerValidationError('bad', 'bad_request_id')
    expect((await status('?requestId=nope')).status).toBe(422)
  })

  it('an unexpected failure is a generic 500, never a false "not found" and never raw detail', async () => {
    fail.status = new Error('relation "print_jobs" does not exist')
    const res = await status(`?requestId=${REQ}`)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'server_error', message: 'Something went wrong on the shop server — try again.' })
  })
})

describe('GET /api/oil-sticker (form bootstrap)', () => {
  it('answers with the signed-in identity, the interval prefill, and the printer link', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ actorKey: 'tony', defaults: { intervalMiles: 5000, intervalMonths: 6 }, bridge: { labelPrinterConfigured: true } })
  })
})
