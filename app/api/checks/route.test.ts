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
vi.mock('@/apps/checks/numbering', () => {
  class SequenceNotInitializedError extends Error {}
  return { SequenceNotInitializedError }
})

import { GET, POST } from './route'
import { proxy } from '@/proxy'
import { EMP_COOKIE, signEmployeeSession } from '@/apps/auth/employee-session'
import { PayeeLookupError, PayeeExistsError, PayeeBlockedError, PayeeNotFoundError, AmbiguousPayeeError } from '@/apps/checks/payee'

// Throwaway TEST values — NOT the production secret / password / PIN.
const TORLAN = { key: 'torlan', name: 'Torlan', role: 'manager' as const }
const EMPLOYEE = { key: 'emp', name: 'Shop Employee', role: 'employee' as const }
const BODY = { payeeName: 'Test Vendor', vendorId: 'V1', payeeType: 'Vendor', allowCreateVendor: false, amountCents: 12345, memo: 'test memo', category: 'shop_general', linkedJobId: null, linkedVehicleId: null, idempotencyKey: 'idem-test-1' }

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
      expect.objectContaining({ payeeName: 'Test Vendor', vendorId: 'V1', payeeType: 'Vendor', amountCents: 12345, memo: 'test memo', category: 'shop_general', idempotencyKey: 'idem-test-1' }),
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

describe('/api/checks — payee problems come back as clear, distinct answers (never a generic 500)', () => {
  const ANTHONY = { id: '400000021', type: 'Employee' as const, displayName: 'Anthony Pittman', active: true }
  it.each([
    ['lookup failed', new PayeeLookupError(new Error('503')), 502, { error: 'payee_lookup_failed' }],
    ['name already exists (6240) → existing payee to confirm', new PayeeExistsError(ANTHONY), 409, { error: 'payee_exists', payee: ANTHONY }],
    ['name blocked', new PayeeBlockedError('inactive employee', []), 409, { error: 'payee_blocked', message: 'inactive employee', conflicts: [] }],
    ['new payee not confirmed', new PayeeNotFoundError('Brand New LLC'), 409, { error: 'payee_not_found' }],
    ['ambiguous', new AmbiguousPayeeError([ANTHONY]), 409, { error: 'ambiguous_payee', matches: [ANTHONY] }],
  ])('%s', async (_l, err, status, body) => {
    h.create.mockRejectedValue(err)
    const res = await POST(request('POST', await signEmployeeSession(TORLAN)))
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject(body)
  })
})
