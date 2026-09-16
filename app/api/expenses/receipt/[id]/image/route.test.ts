import { describe, it, expect, vi, beforeEach } from 'vitest'

// Behavioral tests for the gated retrieval route. decideRetrieval (view) stays REAL; the actor resolver,
// db, and blob fetch are mocked. Covers anonymous/employee/manager boundaries, IDOR/nonexistent, and that
// the Blob pathname is resolved server-side (never taken from the client) with safe headers.
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: vi.fn(),
  isManagerRole: (role: string | null | undefined) => role === 'manager' || role === 'admin',
}))
vi.mock('@/apps/expenses/db', () => ({ getReceipt: vi.fn() }))
vi.mock('@/platform/blob', () => ({ getPrivateBlob: vi.fn() }))

import { GET } from './route'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { getReceipt } from '@/apps/expenses/db'
import { getPrivateBlob } from '@/platform/blob'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const req = new Request('http://x/api/expenses/receipt/r1/image')
const privateRow = { id: 'r1', storage: 'blob_private', storageRef: 'business-receipts/abc.jpg', contentType: 'image/jpeg' }

beforeEach(() => {
  vi.clearAllMocks()
  asMock(getReceipt).mockResolvedValue(privateRow)
  asMock(getPrivateBlob).mockResolvedValue({ bytes: Buffer.from([1, 2, 3]), contentType: 'image/jpeg', size: 3 })
})

describe('gated receipt image retrieval', () => {
  it('anonymous → 401, and never queries the DB (no existence leak)', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue(null)
    const res = await GET(req, params('r1'))
    expect(res.status).toBe(401)
    expect(asMock(getReceipt)).not.toHaveBeenCalled()
  })

  it('verified EMPLOYEE (non-manager) → 403, and never queries the DB', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue({ key: 'e', name: 'Ed', role: 'employee' })
    const res = await GET(req, params('r1'))
    expect(res.status).toBe(403)
    expect(asMock(getReceipt)).not.toHaveBeenCalled()
  })

  it('manager + NONEXISTENT receipt → 404 (IDOR-safe; no Blob fetch)', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue({ key: 'd', name: 'Darryl', role: 'manager' })
    asMock(getReceipt).mockResolvedValue(null)
    const res = await GET(req, params('does-not-exist'))
    expect(res.status).toBe(404)
    expect(asMock(getPrivateBlob)).not.toHaveBeenCalled()
  })

  it('manager + receipt without private storage → 404', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue({ key: 'd', name: 'Darryl', role: 'manager' })
    asMock(getReceipt).mockResolvedValue({ ...privateRow, storage: 'none', storageRef: null })
    const res = await GET(req, params('r1'))
    expect(res.status).toBe(404)
  })

  it('manager → 200 with safe headers; the pathname is resolved server-side from the row', async () => {
    asMock(authenticatedActorFromRequest).mockResolvedValue({ key: 'd', name: 'Darryl', role: 'manager' })
    const res = await GET(req, params('r1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    // pathname came from the DB row, not the client-provided id.
    expect(asMock(getPrivateBlob)).toHaveBeenCalledWith('business-receipts/abc.jpg')
  })
})
