/**
 * POST /api/workflow/orders/[id]/parts — the Job screen's add / remove rules, with the service layer
 * injected (no DB): who may price, where an add goes, and the ONE removal rule (an employee removes parts
 * until the Job has a QuickBooks invoice; then a manager is needed). The money/record behaviour of the service layer
 * itself is covered in apps/parts/remove-service-with-parts.test.ts (PGlite).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  actor: null as { key: string; name: string; role: string } | null,
  authorized: true,
  estimateOn: true,
  guidedOn: true,
  order: { source: 'quick_entry', serviceType: 'retail', status: 'in_progress' } as { source: string; serviceType: string; status: string } | null,
  parts: [] as Array<{ id: string; status: string; jobLineItemId: string | null; laborStatus?: string }>,
  invoiced: false,
  calls: { addPartForJob: [] as unknown[][], addPart: [] as unknown[][], removeWithLabor: [] as unknown[][], cancelPart: [] as unknown[][], hasInvoice: 0 },
  addThrows: null as Error | null,
  removeThrows: null as Error | null,
}))

vi.mock('@/apps/auth/employee-guard', () => ({
  employeeAuthorizedFromRequest: async () => h.authorized,
  shopActorFromRequest: async () => h.actor,
  isManagerRole: (r: unknown) => r === 'manager' || r === 'admin',
}))
vi.mock('@/apps/parts/visibility', () => ({ partsVisibleFor: () => true }))
vi.mock('@/apps/workflow/estimate', () => ({ estimateEnabled: () => h.estimateOn }))
vi.mock('@/apps/settings/db', () => ({ guidedJobItemsEnabled: async () => h.guidedOn }))
vi.mock('@/apps/workflow/fees', () => ({ isDealerOrder: (o: { source: string }) => o.source === 'dealer_checkin' }))
vi.mock('@/platform/db', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => (h.order ? [h.order] : []) }) }) }) }),
}))
vi.mock('@/apps/workflow/schema', () => ({ serviceOrders: { id: 'id', source: 'source', serviceType: 'service_type', status: 'status' } }))
vi.mock('@/apps/parts/estimate-parts', () => ({
  addPartForJob: async (...a: unknown[]) => { h.calls.addPartForJob.push(a); if (h.addThrows) throw h.addThrows; return { id: 'new-part' } },
  jobHasQbInvoice: async () => { h.calls.hasInvoice++; return h.invoiced },
  removeEstimatePartWithLabor: async (...a: unknown[]) => { h.calls.removeWithLabor.push(a); if (h.removeThrows) throw h.removeThrows },
}))
vi.mock('@/apps/parts/db', () => ({
  listPartsForOrder: async () => h.parts,
  addPart: async (input: unknown) => { h.calls.addPart.push([input]); return { id: 'legacy-part' } },
  cancelPart: async (...a: unknown[]) => { h.calls.cancelPart.push(a) },
  updatePart: vi.fn(), markOrdered: vi.fn(), receivePart: vi.fn(), recordReturn: vi.fn(), billPart: vi.fn(),
}))

import { POST } from './route'
const post = (body: unknown) => POST(new Request('http://x/api/workflow/orders/o1/parts', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'o1' }) })
const MANAGER = { key: 'tony', name: 'Tony', role: 'manager' }

beforeEach(() => {
  h.actor = null; h.authorized = true; h.estimateOn = true; h.guidedOn = true; h.order = { source: 'quick_entry', serviceType: 'retail', status: 'in_progress' }
  h.parts = [{ id: 'p1', status: 'needed', jobLineItemId: 'line-1' }]; h.invoiced = false; h.addThrows = null; h.removeThrows = null
  h.calls = { addPartForJob: [], addPart: [], removeWithLabor: [], cancelPart: [], hasInvoice: 0 }
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
  it('the client replay key is forwarded with the add (a retry after a lost response must not charge twice)', async () => {
    await post({ action: 'add', description: 'Gasket', sellPriceCents: 500, requestId: 'c3f1a9d2-aaaa-bbbb-cccc-000000000001' })
    expect((h.calls.addPartForJob[0][1] as { requestId: unknown }).requestId).toBe('c3f1a9d2-aaaa-bbbb-cccc-000000000001')
    await post({ action: 'add', description: 'Gasket', sellPriceCents: 500 })
    expect((h.calls.addPartForJob[1][1] as { requestId: unknown }).requestId).toBeNull()
  })
  it('a removed (cancelled) Job is frozen: add / remove / cancel are a 409 and nothing is called', async () => {
    h.order = { source: 'quick_entry', serviceType: 'retail', status: 'cancelled' }; h.actor = MANAGER
    for (const body of [{ action: 'add', description: 'Mirror', sellPriceCents: 100 }, { action: 'remove', partId: 'p1' }, { action: 'cancel', partId: 'p1' }]) {
      const res = await post(body)
      expect(res.status).toBe(409)
      expect((await res.json()).error).toMatch(/was removed/)
    }
    expect(h.calls.addPartForJob).toHaveLength(0); expect(h.calls.addPart).toHaveLength(0); expect(h.calls.removeWithLabor).toHaveLength(0)
  })
  it('a dealer Job never touches the retail estimate path (legacy tracker record only)', async () => {
    h.order = { source: 'dealer_checkin', serviceType: 'dealer', status: 'in_progress' }; h.actor = MANAGER
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
  it('a service that only exists as Work Board text (older Job) is attached BY TITLE — the server mirrors it inside the add, never on a read', async () => {
    await post({ action: 'add', description: 'Pads', sellPriceCents: 4500, laborServiceTitle: '  Brake job ' })
    expect(h.calls.addPartForJob[0][4]).toEqual({ title: 'Brake job' })
    // An estimate service id wins when both are sent; a blank title is a job-level add.
    await post({ action: 'add', description: 'Pads', sellPriceCents: 4500, laborServiceId: 'svc-1', laborServiceTitle: 'Brake job' })
    await post({ action: 'add', description: 'Pads', sellPriceCents: 4500, laborServiceTitle: '   ' })
    expect(h.calls.addPartForJob[1][4]).toBe('svc-1'); expect(h.calls.addPartForJob[2][4]).toBeNull()
  })
  it('rollout switch OFF: adds go to the legacy tracker record exactly as before (previous interface), never the guided path', async () => {
    h.guidedOn = false
    const res = await post({ action: 'add', description: 'Mirror', quantity: 2 })
    expect(res.status).toBe(200)
    expect(h.calls.addPartForJob).toHaveLength(0); expect(h.calls.addPart).toHaveLength(1)
    expect((await res.json()).partId).toBe('legacy-part')
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
  it('before a QuickBooks invoice exists an employee removes a PRICED part through the guarded estimate removal (charge + record), labor kept', async () => {
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(200)
    expect(h.calls.removeWithLabor).toEqual([['o1', 'p1', { action: 'keep' }, 'Employee', { requireNotInvoiced: true, refuseOwnLabor: true }]])
  })
  it('the legacy `cancel` action follows the same rule and path (no bypass)', async () => {
    const res = await post({ action: 'cancel', partId: 'p1' })
    expect(res.status).toBe(200)
    expect(h.calls.removeWithLabor).toEqual([['o1', 'p1', { action: 'keep' }, 'Employee', { requireNotInvoiced: true, refuseOwnLabor: true }]])
    h.invoiced = true
    expect((await post({ action: 'cancel', partId: 'p1' })).status).toBe(403)
    expect(h.calls.removeWithLabor).toHaveLength(1)
  })
  it('once the Job has a QuickBooks invoice an employee may NOT remove a part: 403 with the exact message, nothing removed', async () => {
    h.invoiced = true
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.needsManager).toBe(true)
    expect(body.error).toBe('This job has a QuickBooks invoice. Ask a manager to remove this part.')
    expect(h.calls.removeWithLabor).toHaveLength(0)
  })
  it('the removal statement’s own guard losing to a concurrent invoice Create is a 403 too (not a 400/500)', async () => {
    h.invoiced = false   // the pre-check passed…
    h.removeThrows = Object.assign(new Error('This job has a QuickBooks invoice. Ask a manager to remove this part.'), { invoiced: true })   // …but the atomic guard refused
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, needsManager: true, error: /QuickBooks invoice/ })
  })
  it('a manager removes a part on an invoiced Job without the guard (existing behaviour: the invoice is flagged for sync, never voided)', async () => {
    h.actor = MANAGER; h.invoiced = true
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(200)
    expect(h.calls.hasInvoice).toBe(0)
    expect(h.calls.removeWithLabor).toEqual([['o1', 'p1', { action: 'keep' }, 'Tony']])
  })
  it('removing an already-removed part is an idempotent no-op (double-tap / retry)', async () => {
    h.parts = [{ id: 'p1', status: 'cancelled', jobLineItemId: null }]; h.invoiced = true
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(200)
    expect(h.calls.removeWithLabor).toHaveLength(0)
  })
  it('a dealer Job’s part is cancelled through the plain tracker record (dealer isolation) — never the retail estimate path', async () => {
    h.order = { source: 'dealer_checkin', serviceType: 'dealer', status: 'in_progress' }
    const res = await post({ action: 'cancel', partId: 'p1' })
    expect(res.status).toBe(200)
    expect(h.calls.cancelPart).toEqual([['p1', 'Employee']])
    expect(h.calls.removeWithLabor).toHaveLength(0); expect(h.calls.hasInvoice).toBe(0)
  })
  it('a part with its own installation line: the service layer’s refusal reaches the employee as a 403 "ask a manager"; a manager removes it (labor kept, no refusal option)', async () => {
    h.removeThrows = Object.assign(new Error('This part has its own installation charge. Ask a manager to remove it.'), { needsManager: true })
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ needsManager: true, error: 'This part has its own installation charge. Ask a manager to remove it.' })
    expect(h.calls.removeWithLabor[0][4]).toEqual({ requireNotInvoiced: true, refuseOwnLabor: true })
    h.removeThrows = null; h.actor = MANAGER
    expect((await post({ action: 'remove', partId: 'p1' })).status).toBe(200)
    expect(h.calls.removeWithLabor[1]).toEqual(['o1', 'p1', { action: 'keep' }, 'Tony'])
  })
  it('rollout switch OFF changes nothing about removal: the invoiced-Job rule still stands for an employee', async () => {
    h.guidedOn = false; h.invoiced = true
    const res = await post({ action: 'remove', partId: 'p1' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ needsManager: true, error: 'This job has a QuickBooks invoice. Ask a manager to remove this part.' })
    expect(h.calls.removeWithLabor).toHaveLength(0)
    h.invoiced = false
    expect((await post({ action: 'remove', partId: 'p1' })).status).toBe(200)
    expect(h.calls.removeWithLabor[0][4]).toEqual({ requireNotInvoiced: true, refuseOwnLabor: true })
  })
  it('a part that is not on THIS order is a 404 (no cross-order removal)', async () => {
    h.actor = MANAGER
    const res = await post({ action: 'remove', partId: 'someone-elses' })
    expect(res.status).toBe(404)
    expect(h.calls.removeWithLabor).toHaveLength(0)
  })
})
