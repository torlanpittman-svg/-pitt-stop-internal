import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// The service / db / QuickBooks layers are mocked — nothing here records a check or touches a database.
// Authorization is NOT mocked: the real proxy, the real handler gate, and real signed test sessions run.
const h = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn() }))
vi.mock('@/apps/checks/service', () => {
  class CheckValidationError extends Error { constructor(m: string, public code: string) { super(m) } }
  return { createAndRecordCheck: h.create, CheckValidationError }
})
vi.mock('@/apps/checks/db', () => ({ listRecentChecks: h.list }))
vi.mock('@/apps/checks/vendor', () => {
  class AmbiguousVendorError extends Error { matches: unknown[] = [] }
  class VendorNotFoundError extends Error {}
  return { AmbiguousVendorError, VendorNotFoundError }
})
vi.mock('@/apps/checks/numbering', () => {
  class SequenceNotInitializedError extends Error {}
  return { SequenceNotInitializedError }
})

import { GET, POST } from './route'
import { proxy } from '@/proxy'
import { EMP_COOKIE, signEmployeeSession } from '@/apps/auth/employee-session'

// Throwaway TEST values — NOT the production secret / password / PIN.
const TORLAN = { key: 'torlan', name: 'Torlan', role: 'manager' as const }
const EMPLOYEE = { key: 'emp', name: 'Shop Employee', role: 'employee' as const }
const BODY = { payeeName: 'Test Vendor', vendorId: 'V1', allowCreateVendor: false, amountCents: 12345, memo: 'test memo', category: 'shop_general', linkedJobId: null, linkedVehicleId: null, idempotencyKey: 'idem-test-1' }

beforeEach(() => {
  vi.stubEnv('IDENTITY_SECRET', 'test-secret')
  vi.stubEnv('ADMIN_PASSWORD', 'test-admin-password')
  vi.stubEnv('PIN_TORLAN', '4003')
  h.create.mockReset().mockResolvedValue({ recorded: true, check: { id: 'C1', checkNumber: 1 } })
  h.list.mockReset().mockResolvedValue([])
})
afterEach(() => { vi.unstubAllEnvs() })

function request(method: 'GET' | 'POST', token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers.cookie = `${EMP_COOKIE}=${token}`
  return new NextRequest('https://os.example.test/api/checks', { method, headers, body: method === 'POST' ? JSON.stringify(BODY) : undefined })
}
const passedThrough = (res: Response) => res.status === 200 && res.headers.get('x-middleware-next') === '1'

describe('/api/checks — proxy + handler together', () => {
  it('a signed-in manager passes the proxy and reaches the service as that manager', async () => {
    const req = request('POST', await signEmployeeSession(TORLAN))
    const gate = await proxy(req)
    expect(gate.headers.get('www-authenticate')).toBeNull()
    expect(passedThrough(gate)).toBe(true)

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ payeeName: 'Test Vendor', vendorId: 'V1', amountCents: 12345, memo: 'test memo', category: 'shop_general', idempotencyKey: 'idem-test-1' }),
      { key: 'torlan', name: 'Torlan' },
    )
  })

  it('a signed-in manager can list recent checks through the proxy', async () => {
    const req = request('GET', await signEmployeeSession(TORLAN))
    expect(passedThrough(await proxy(req))).toBe(true)
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(h.list).toHaveBeenCalledTimes(1)
  })

  it('an ordinary employee session is refused by the handler and records nothing', async () => {
    const token = await signEmployeeSession(EMPLOYEE)
    const res = await POST(request('POST', token))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect((await GET(request('GET', token))).status).toBe(403)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.list).not.toHaveBeenCalled()
  })

  it.each([
    ['an anonymous shared-PIN session', async () => signEmployeeSession(null)],
    ['no session', async () => undefined],
    ['a malformed token', async () => 'not-a-token'],
  ])('%s is refused by the handler and records nothing', async (_label, mint) => {
    const res = await POST(request('POST', await mint()))
    expect(res.status).toBe(403)
    expect(h.create).not.toHaveBeenCalled()
  })
})
