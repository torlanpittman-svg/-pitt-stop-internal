/**
 * POST /api/workflow/orders/[id]/parts — the Job screen's add / remove rules, with the service layer
 * injected (no DB): who may price, where an add goes, and the ONE removal rule (a charged part needs a
 * manager; nothing is hidden while its charge stays). The money/record behaviour of the service layer
 * itself is covered in apps/parts/remove-service-with-parts.test.ts (PGlite).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  actor: null as { key: string; name: string; role: string } | null,
  authorized: true,
  estimateOn: true,
  order: { source: 'quick_entry', serviceType: 'retail' } as { source: string; serviceType: string } | null,
  parts: [] as Array<{ id: string; status: string; jobLineItemId: string | null }>,
  charged: false,
  calls: { addPartForJob: [] as unknown[][], addPart: [] as unknown[][], removeWithLabor: [] as unknown[][], partIsCharged: 0 },
  addThrows: null as Error | null,
}))

vi.mock('@/apps/auth/employee-guard', () => ({
  employeeAuthorizedFromRequest: async () => h.authorized,
  shopActorFromRequest: async () => h.actor,
  isManagerRole: (r: unknown) => r === 'manager' || r === 'admin',
}))
vi.mock('@/apps/parts/visibility', () => ({ partsVisibleFor: () => true }))
vi.mock('@/apps/workflow/estimate', () => ({ estimateEnabled: () => h.estimateOn }))
vi.mock('@/apps/workflow/fees', () => ({ isDealerOrder: (o: { source: string }) => o.source === 'dealer_checkin' }))
vi.mock('@/platform/db', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => (h.order ? [h.order] : []) }) }) }) }),
}))
vi.mock('@/apps/workflow/schema', () => ({ serviceOrders: { id: 'id', source: 'source', serviceType: 'service_type' } }))
vi.mock('@/apps/parts/estimate-parts', () => ({
  addPartForJob: async (...a: unknown[]) => { h.calls.addPartForJob.push(a); if (h.addThrows) throw h.addThrows; return { id: 'new-part' } },
  partIsCharged: async () => { h.calls.partIsCharged++; return h.charged },
  removeEstimatePartWithLabor: async (...a: unknown[]) => { h.calls.removeWithLabor.push(a) },
}))
vi.mock('@/apps/parts/db', () => ({
  listPartsForOrder: async () => h.parts,
  addPart: async (input: unknown) => { h.calls.addPart.push([input]); return { id: 'legacy-part' } },
  updatePart: vi.fn(), markOrdered: vi.fn(), receivePart: vi.fn(), recordReturn: vi.fn(), billPart: vi.fn(),
}))

import { POST } from './route'
const post = (body: unknown) => POST(new Request('http://x/api/workflow/orders/o1/parts', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'o1' }) })
const MANAGER = { key: 'tony', name: 'Tony', role: 'manager' }

beforeEach(() => {
  h.actor = null; h.authorized = true; h.estimateOn = true; h.order = { source: 'quick_entry', serviceType: 'retail' }
  h.parts = [{ id: 'p1', status: 'needed', jobLineItemId: 'line-1' }]; h.charged = false; h.addThrows = null
  h.calls = { addPartForJob: [], addPart: [], removeWithLabor: [], partIsCharged: 0 }
})

describe('add', () => {
  it('an employee (shared PIN) adds through the estimate path WITH the customer price they entered; our cost is dropped', async () => {
    const res = await post({ action: 'add', description: ' Cabin air filter ', quantity: 2, partNumber: 'CF-1', unitCostCents: 400, sellPriceCents: 1500, laborServiceId: 'svc-1' })
    expect(res.status).toBe(200)
    expect((await res.json()).partId).toBe('new-part')
    expect(h.calls.addPartForJob).toHaveLength(1)
    const [orderId, input, actor, role, attach] = h.calls.addPartForJob[0]
    expect(orderId).toBe('o1')
    expect(input).toMatchObject({ description: 'Cabin air filter', quantity: 2, partNumber: 'CF-1', unitCostCents: null, sellPriceCents: 1500 })
    expect(actor).toBe('Employee'); expect(role).toBeNull(); expect(attach).toBe('svc-1')
    expect(h.calls.addPart).toHaveLength(0)
  })
  it('the customer price is forwarded as sent (string or number) for the service layer to validate; a non-amount is forwarded as missing', async () => {
    await post({ action: 'add', description: 'Gasket', sellPriceCents: '1250' })
    await post({ action: 'add', description: 'Gasket', sellPriceCents: -5 })
    await post({ action: 'add', description: 'Gasket' })
    await post({ action: 'add', description: 'Gasket', sellPriceCents: { cents: 5 } })
    expect(h.calls.addPartForJob.map((c) => (c[1] as { sellPriceCents: unknown }).sellPriceCents)).toEqual(['1250', -5, null, null])
  })
  it('a missing / invalid customer price rejected by the service layer is a 400 with its message — nothing else is tried', async () => {
    h.addThrows = new Error('Enter the customer price · each before adding this part (use 0 for no charge).')
    const res = await post({ action: 'add', description: 'Gasket' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/customer price/)
    expect(h.calls.addPart).toHaveLength(0)
  })
  it('a manager’s prices are kept (whole cents) and a job-level add carries no service', async () => {
    h.actor = MANAGER
    const res = await post({ action: 'add', description: 'Wiper blades', unitCostCents: '799.6', sellPriceCents: 1999 })
    expect(res.status).toBe(200)
    const [, input, actor, role, attach] = h.calls.addPartForJob[0]
    expect(input).toMatchObject({ quantity: 1, unitCostCents: 800, sellPriceCents: 1999 })
    expect(actor).toBe('Tony'); expect(role).toBe('manager'); expect(attach).toBeNull()
  })
  it('a dealer Job never touches the retail estimate path (legacy tracker record only)', async () => {
    h.order = { source: 'dealer_checkin', serviceType: 'dealer' }; h.actor = MANAGER
    const res = await post({ action: 'add', description: 'Mirror', sellPriceCents: 5000 })
    expect(res.status).toBe(200)
    expect(h.calls.addPartForJob).toHaveLength(0)
    expect(h.calls.addPart).toHaveLength(1)
    expect((await res.json()).partId).toBe('legacy-part')
  })
  it('with the estimate layer off the legacy tracker path is used', async () => {
    h.estimateOn = false
    await post({ action: 'add', description: 'Mirror' })
    expect(h.calls.addPartForJob).toHaveLength(0); expect(h.calls.addPart).toHaveLength(1)
  })
  it('a blank description is a 400; a service-layer validation error is a 400 with its message', async () => {
    expect((await post({ action: 'add', description: '  ' })).status).toBe(400)
    h.addThrows = new Error('That service is no longer on this job. Refresh to see the current list.')
    const res = await post({ action: 'add', description: 'Bulb', laborServiceId: 'stale' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/no longer on this job/)
  })
  it('refuses without a shop session', async () => {
    h.authorized = false
    expect((await post({ action: 'add', description: 'Bulb' })).status).toBe(401)
  })
})

describe('remove — one rule for every caller', () => {
  it('an employee may NOT remove a part that carries a customer charge: 403, needsManager, nothing removed', async () => {
    h.charged = true
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.needsManager).toBe(true)
    expect(body.error).toMatch(/manager/i)
    expect(h.calls.removeWithLabor).toHaveLength(0)
  })
  it('an employee may remove an uncharged part — through the estimate removal (record + any line), labor kept', async () => {
    h.charged = false
    const res = await post({ action: 'cancel', partId: 'p1' })
    expect(res.status).toBe(200)
    expect(h.calls.removeWithLabor).toEqual([['o1', 'p1', { action: 'keep' }, 'Employee']])
  })
  it('a manager removes a charged part without the charge check', async () => {
    h.actor = MANAGER; h.charged = true
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(200)
    expect(h.calls.partIsCharged).toBe(0)
    expect(h.calls.removeWithLabor).toEqual([['o1', 'p1', { action: 'keep' }, 'Tony']])
  })
  it('removing an already-removed part is an idempotent no-op (double-tap / retry)', async () => {
    h.parts = [{ id: 'p1', status: 'cancelled', jobLineItemId: null }]; h.charged = true
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(200)
    expect(h.calls.removeWithLabor).toHaveLength(0)
  })
  it('a part that is not on THIS order is a 404 (no cross-order removal)', async () => {
    h.actor = MANAGER
    const res = await post({ action: 'remove', partId: 'someone-elses' })
    expect(res.status).toBe(404)
    expect(h.calls.removeWithLabor).toHaveLength(0)
  })
})
