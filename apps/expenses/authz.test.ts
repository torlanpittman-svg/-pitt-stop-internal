import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the underlying identity primitives. isManagerRole stays REAL (pure). verifyEmployeeToken + the
// request-scoped actor resolver are controlled per-test. next/headers cookies() is stubbed for the
// server-component variants (unused in the request-variant tests below).
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActor: vi.fn(),
  authenticatedActorFromRequest: vi.fn(),
  isManagerRole: (role: string | null | undefined) => role === 'manager' || role === 'admin',
}))
vi.mock('@/apps/auth/employee-session', () => ({ EMP_COOKIE: 'ps_emp', verifyEmployeeToken: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }))

import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { verifyEmployeeToken } from '@/apps/auth/employee-session'
import { receiptManagerFromRequest, receiptUploaderFromRequest } from './authz'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const reqWith = (cookie?: string) => new Request('http://x/api', { headers: cookie ? { cookie } : {} })

beforeEach(() => { vi.clearAllMocks(); asMock(verifyEmployeeToken).mockResolvedValue(null) })

describe('receiptManagerFromRequest — fail-closed', () => {
  it('anonymous (no verified actor) → null', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue(null)
    expect(await receiptManagerFromRequest(reqWith())).toBeNull()
  })
  it('verified EMPLOYEE (non-manager) → null', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue({ key: 'e', name: 'Ed', role: 'employee' })
    expect(await receiptManagerFromRequest(reqWith('ps_emp=t'))).toBeNull()
  })
  it('manager → actor; admin → actor', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue({ key: 'd', name: 'Darryl', role: 'manager' })
    expect((await receiptManagerFromRequest(reqWith('ps_emp=t')))?.name).toBe('Darryl')
    asMock(authenticatedActorFromRequest).mockResolvedValue({ key: 'a', name: 'Admin', role: 'admin' })
    expect((await receiptManagerFromRequest(reqWith()))?.role).toBe('admin')
  })
})

describe('receiptUploaderFromRequest — fail-closed, attribution', () => {
  it('anonymous with NO valid session → null (rejected even when unconfigured)', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue(null)
    asMock(verifyEmployeeToken).mockResolvedValue(null)
    expect(await receiptUploaderFromRequest(reqWith())).toBeNull()
  })
  it('a named individual is attributed by name', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue({ key: 'd', name: 'Darryl', role: 'manager' })
    expect(await receiptUploaderFromRequest(reqWith('ps_emp=t'))).toEqual({ actor: { key: 'd', name: 'Darryl', role: 'manager' }, name: 'Darryl' })
  })
  it('a valid shared-PIN session (no identity claims) is allowed and attributed generically', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue(null)
    asMock(verifyEmployeeToken).mockResolvedValue({ exp: Date.now() + 1000 })
    expect(await receiptUploaderFromRequest(reqWith('ps_emp=validtoken'))).toEqual({ actor: null, name: 'Shop device' })
  })
})
