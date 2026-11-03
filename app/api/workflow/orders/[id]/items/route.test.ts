/**
 * GET /api/workflow/orders/[id]/items — the Job screen's view is STRICTLY read-only: opening / refreshing a Job
 * never creates an estimate, mirrors a service row or recalculates anything, for any role, however often it is
 * requested. Our cost leaves only for managers; the persisted QuickBooks linkage is reported as `qbInvoiced`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  actor: null as { key: string; name: string; role: string } | null,
  est: null as null | { id: string; qbInvoiceId: string | null; qbStatus: string },
  reads: 0,
  writes: [] as string[],
}))
vi.mock('@/apps/auth/employee-guard', () => ({
  employeeAuthorizedFromRequest: async () => true,
  shopActorFromRequest: async () => h.actor,
  isManagerRole: (r: unknown) => r === 'manager' || r === 'admin',
}))
vi.mock('@/apps/workflow/estimate', () => ({ estimateEnabled: () => true }))
vi.mock('@/apps/parts/visibility', () => ({ partsVisibleFor: () => true }))
vi.mock('@/apps/workflow/estimate-db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/apps/workflow/estimate-db')>()
  return {
    estimateHasQbInvoice: real.estimateHasQbInvoice,
    getEstimateRow: async () => { h.reads++; return h.est },
    getEstimateView: async () => ({
      exists: !!h.est, flat: false, workTotalCents: 6000, services: [{ id: 's1', title: 'Oil change', priceCents: 6000 }], incomplete: false, referenceCents: null,
      parts: [{ id: 'p1', description: 'Oil filter', unitCostCents: 400, sellPriceCents: 1200, lineCents: 1200 }], review: { ready: true, issues: [] },
    }),
    // Any of these running on a read is the bug this test exists to catch.
    promoteTextServices: async () => { h.writes.push('promoteTextServices'); return 1 },
    recomputeEstimate: async () => { h.writes.push('recomputeEstimate') },
    getOrCreateEstimate: async () => { h.writes.push('getOrCreateEstimate'); return { id: 'x' } },
  }
})

import { GET } from './route'
const get = () => GET(new Request('http://x/api/workflow/orders/o1/items'), { params: Promise.resolve({ id: 'o1' }) })

beforeEach(() => { h.actor = null; h.est = { id: 'e1', qbInvoiceId: null, qbStatus: 'none' }; h.reads = 0; h.writes = [] })

describe('GET /items is read-only', () => {
  it('an employee opening and refreshing a Job: the view is served, our cost stripped, and NOTHING is written', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await get()
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.manager).toBe(false)
      expect(body.view.parts[0].unitCostCents).toBeNull()
      expect(body.view.qbInvoiced).toBe(false)
    }
    expect(h.writes).toEqual([])
    expect(h.reads).toBe(3)
  })
  it('an older Job with NO estimate (text services only) gets no estimate from being opened', async () => {
    h.est = null
    const body = await (await get()).json()
    expect(body.view.exists).toBe(false)
    expect(body.view.qbInvoiced).toBe(false)
    expect(h.writes).toEqual([])
  })
  it('a manager keeps our cost; the persisted QuickBooks linkage (incl. a shared-invoice member) is reported, still with no writes', async () => {
    h.actor = { key: 'tony', name: 'Tony', role: 'manager' }
    h.est = { id: 'e1', qbInvoiceId: null, qbStatus: 'linked' }
    const body = await (await get()).json()
    expect(body.manager).toBe(true)
    expect(body.view.parts[0].unitCostCents).toBe(400)
    expect(body.view.qbInvoiced).toBe(true)
    h.est = { id: 'e1', qbInvoiceId: '100931', qbStatus: 'created' }
    expect((await (await get()).json()).view.qbInvoiced).toBe(true)
    expect(h.writes).toEqual([])
  })
})
