/**
 * Shared retail invoice route gates: managers/admins only (employee intake is refused server-side), and with
 * the flag off nothing is discovered, linked, or written — GET reports enabled:false without a QuickBooks lookup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const actor = vi.hoisted(() => ({ current: null as null | { name: string; role: string } }))
const flag = vi.hoisted(() => ({ on: false }))
const svc = vi.hoisted(() => ({
  find: vi.fn(), link: vi.fn(), unlink: vi.fn(), state: vi.fn(), preview: vi.fn(), update: vi.fn(),
}))
vi.mock('@/apps/auth/employee-guard', () => ({ authenticatedActorFromRequest: async () => actor.current }))
vi.mock('@/apps/settings/db', () => ({ retailQbSharedInvoiceEnabled: async () => flag.on }))
vi.mock('@/apps/quickbooks/shared-invoice', () => ({
  findSharedInvoiceCandidates: svc.find, linkToSharedInvoice: svc.link, unlinkSharedInvoiceMember: svc.unlink,
  loadSharedInvoiceState: svc.state, previewSharedInvoiceUpdate: svc.preview, updateSharedInvoice: svc.update,
}))

import { GET, POST } from './route'

const ctx = { params: Promise.resolve({ id: 'o1' }) }
const get = (q = '') => GET(new Request(`http://x/api/workflow/orders/o1/invoice/shared${q}`), ctx)
const post = (body: unknown) => POST(new Request('http://x/api/workflow/orders/o1/invoice/shared', { method: 'POST', body: JSON.stringify(body) }), ctx)

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset()
  svc.state.mockResolvedValue(null)
  svc.find.mockResolvedValue({ ok: true, candidates: [] })
  svc.link.mockResolvedValue({ ok: true })
  flag.on = true
  actor.current = { name: 'Darryl', role: 'manager' }
})

describe('shared invoice route', () => {
  it('refuses employees (GET discovery and POST link) — no service call at all', async () => {
    actor.current = { name: 'Tony', role: 'employee' }
    expect((await get('?discover=1')).status).toBe(403)
    expect((await post({ action: 'link', anchorOrderId: 'a', invoiceId: '1' })).status).toBe(403)
    expect(svc.find).not.toHaveBeenCalled(); expect(svc.link).not.toHaveBeenCalled(); expect(svc.state).not.toHaveBeenCalled()
  })
  it('refuses an unauthenticated caller', async () => {
    actor.current = null
    expect((await get()).status).toBe(403)
  })
  it('flag off → GET reports enabled:false and never runs discovery; POST is refused', async () => {
    flag.on = false
    const r = await get('?discover=1')
    expect(await r.json()).toMatchObject({ ok: true, enabled: false })
    expect(svc.find).not.toHaveBeenCalled()
    expect((await post({ action: 'link', anchorOrderId: 'a', invoiceId: '1' })).status).toBe(503)
    expect(svc.link).not.toHaveBeenCalled()
  })
  it('manager with the flag on → discovery runs only when asked', async () => {
    await get()
    expect(svc.find).not.toHaveBeenCalled()
    const body = await (await get('?discover=1')).json()
    expect(body).toMatchObject({ enabled: true, discovery: { ok: true } })
    expect(svc.find).toHaveBeenCalledWith('o1')
  })
  it('link passes the actor from the session, never from the body', async () => {
    await post({ action: 'link', anchorOrderId: 'a', invoiceId: '1', syncToken: '3', requestId: 'r1', actor: 'Spoofed' })
    expect(svc.link).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1', anchorOrderId: 'a', invoiceId: '1', expectedSyncToken: '3', requestId: 'r1', actor: 'Darryl' }))
  })
  it('link without a chosen invoice → 400', async () => {
    expect((await post({ action: 'link' })).status).toBe(400)
  })
})
