import { vi, describe, it, expect, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ actor: null as null | { key: string; name: string; role: string }, enqueue: vi.fn() }))
vi.mock('@/apps/checks/authz', () => ({ managerFromRequest: vi.fn(async () => h.actor) }))
vi.mock('@/apps/checks/service', () => {
  class CheckValidationError extends Error { constructor(m: string, public code: string) { super(m) } }
  return { enqueueBankSpecimen: h.enqueue, CheckValidationError }
})
vi.mock('@/apps/checks/micr', () => ({ specimenReadiness: () => ({ secretsPresent: true, routingValid: true, accountValid: true, fontInstalled: true, ready: true }) }))

import { GET, POST } from './route'

const post = (body: unknown) => POST(new Request('http://x/api/admin/checks/specimen', { method: 'POST', body: JSON.stringify(body) }))
const OK = { confirm: 'PRINT BANK SPECIMEN' }

beforeEach(() => { h.enqueue.mockReset().mockResolvedValue({ jobId: 'J1', alreadyQueued: false }) })

describe('bank specimen route — admin only', () => {
  it.each([
    ['nobody signed in', null],
    ['a manager PIN session', { key: 'darryl', name: 'Darryl', role: 'manager' }],
    ['an employee', { key: 'e', name: 'E', role: 'employee' }],
  ])('refuses %s for both GET and POST, and queues nothing', async (_l, actor) => {
    h.actor = actor
    expect((await GET(new Request('http://x'))).status).toBe(403)
    expect((await post(OK)).status).toBe(403)
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('lets the admin through only with the exact confirmation phrase', async () => {
    h.actor = { key: 'admin', name: 'Admin', role: 'admin' }
    expect((await post({})).status).toBe(400)
    expect((await post({ confirm: 'print bank specimen' })).status).toBe(400)
    expect(h.enqueue).not.toHaveBeenCalled()
    const res = await post(OK)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, jobId: 'J1', alreadyQueued: false })
    expect(h.enqueue).toHaveBeenCalledTimes(1)
  })

  it('never lets a response be cached and never returns bank numbers', async () => {
    h.actor = { key: 'admin', name: 'Admin', role: 'admin' }
    const get = await GET(new Request('http://x'))
    expect(get.headers.get('cache-control')).toBe('no-store')
    expect(Object.keys((await get.json()).specimen).sort()).toEqual(['accountValid', 'fontInstalled', 'ready', 'routingValid', 'secretsPresent'])
    expect((await post(OK)).headers.get('cache-control')).toBe('no-store')
  })
})
