/**
 * Combine unpaid invoices route gates: managers/admins only (server-enforced, actor from the session), flag off →
 * nothing discovered or written, and a start must include the screen's own Job plus a full review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const actor = vi.hoisted(() => ({ current: null as null | { name: string; role: string } }))
const flag = vi.hoisted(() => ({ on: false }))
const svc = vi.hoisted(() => ({
  find: vi.fn(), preview: vi.fn(), start: vi.fn(), resume: vi.fn(), cancel: vi.fn(), separate: vi.fn(), state: vi.fn(), review: vi.fn(),
}))
vi.mock('@/apps/auth/employee-guard', () => ({ authenticatedActorFromRequest: async () => actor.current }))
vi.mock('@/apps/settings/db', () => ({ retailQbCombineInvoicesEnabled: async () => flag.on }))
vi.mock('@/apps/quickbooks/invoice-consolidation', () => ({
  findCombineCandidates: svc.find, previewCombineInvoices: svc.preview, startCombineInvoices: svc.start, resumeCombineInvoices: svc.resume,
  cancelCombineInvoices: svc.cancel, separateCombineInvoices: svc.separate, loadCombineState: svc.state,
}))
vi.mock('@/apps/quickbooks/shared-invoice', () => ({ previewSharedInvoiceUpdate: svc.review }))

import { GET, POST } from './route'

const ctx = { params: Promise.resolve({ id: 'o1' }) }
const get = (q = '') => GET(new Request(`http://x/api/workflow/orders/o1/invoice/combine${q}`), ctx)
const post = (body: unknown) => POST(new Request('http://x/api/workflow/orders/o1/invoice/combine', { method: 'POST', body: JSON.stringify(body) }), ctx)
const START = { action: 'start', retainedOrderId: 'o1', replacedOrderId: 'o2', requestId: 'r1', expected: { retainedSyncToken: '0', replacedSyncToken: '0', combinedTotalCents: 31828 } }

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset()
  svc.state.mockResolvedValue(null)
  svc.find.mockResolvedValue({ ok: true, candidates: [] })
  svc.start.mockResolvedValue({ ok: true, status: 'completed' })
  flag.on = true
  actor.current = { name: 'Darryl', role: 'manager' }
})

describe('combine invoices route', () => {
  it('refuses employees and unauthenticated callers — no service call at all', async () => {
    for (const who of [{ name: 'Tony', role: 'employee' }, null]) {
      actor.current = who
      expect((await get('?discover=1')).status).toBe(403)
      expect((await post(START)).status).toBe(403)
    }
    expect(svc.find).not.toHaveBeenCalled(); expect(svc.start).not.toHaveBeenCalled(); expect(svc.state).not.toHaveBeenCalled()
  })
  it('flag off → GET reports enabled:false without discovery; every POST is refused', async () => {
    flag.on = false
    expect(await (await get('?discover=1')).json()).toMatchObject({ ok: true, enabled: false })
    expect(svc.find).not.toHaveBeenCalled()
    for (const action of ['preview', 'start', 'resume', 'cancel', 'separate']) expect((await post({ ...START, action, otherOrderId: 'o2' })).status).toBe(503)
    expect(svc.start).not.toHaveBeenCalled(); expect(svc.cancel).not.toHaveBeenCalled()
  })
  it('admin is allowed; the actor comes from the session, never the body', async () => {
    actor.current = { name: 'Torlan', role: 'admin' }
    await post({ ...START, actor: 'Spoofed' })
    expect(svc.start).toHaveBeenCalledWith(expect.objectContaining({ actor: 'Torlan', retainedOrderId: 'o1', replacedOrderId: 'o2', acknowledgeEmailed: false }))
  })
  it('start requires a full review and must include this screen’s Job', async () => {
    expect((await post({ ...START, expected: undefined })).status).toBe(400)
    expect((await post({ ...START, retainedOrderId: 'x', replacedOrderId: 'y' })).status).toBe(400)
    expect(svc.start).not.toHaveBeenCalled()
  })
  it('maps refusals to status codes', async () => {
    svc.start.mockResolvedValue({ ok: false, block: 'stale' })
    expect((await post(START)).status).toBe(409)
    svc.start.mockResolvedValue({ ok: false, block: 'qb_read_failed' })
    expect((await post(START)).status).toBe(502)
  })
})
