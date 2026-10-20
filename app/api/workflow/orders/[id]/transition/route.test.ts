/**
 * Finish Job (→ ready) server gate: one confirmation, a separate QC pass only when required, the WORK
 * services (parts excluded) must exist, only validated answers are stored, and a repeat submit on an
 * already-Ready Job is not re-validated or re-recorded (transitionOrder answers it idempotently).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getOrder = vi.fn()
const transition = vi.fn()
vi.mock('@/apps/workflow/db', () => ({
  getOrderWithContext: (id: string) => getOrder(id),
  transitionOrder: (p: unknown) => transition(p),
  startAssignment: vi.fn(),
}))
vi.mock('@/apps/auth/employee-guard', () => ({ authenticatedActorFromRequest: async () => ({ name: 'Tony', role: 'employee' }) }))

import { POST } from './route'

const req = (body: unknown) => new Request('http://x/api/workflow/orders/o1/transition', { method: 'POST', body: JSON.stringify(body) })
const call = (body: unknown) => POST(req(body), { params: Promise.resolve({ id: 'o1' }) })
const job = (over: Record<string, unknown> = {}) => ({
  id: 'o1', status: 'in_progress', qcRequired: false, services: ['Interior detail', 'Cabin Air filter'],
  items: { services: ['Interior detail'], partLabels: ['Cabin Air filter'], activePartLabels: ['Cabin Air filter'], parts: { total: 1, waiting: 0 } }, ...over,
})

beforeEach(() => {
  process.env.COMPLETION_FLOW_ENABLED = 'true'
  getOrder.mockReset(); transition.mockReset()
  transition.mockResolvedValue({ ok: true, order: { id: 'o1', status: 'ready' } })
})

describe('POST transition → ready (Finish Job)', () => {
  it('completes with the single confirmation and stores only validated answers + who', async () => {
    getOrder.mockResolvedValue(job())
    const r = await call({ newStatus: 'ready', completion: { allWorkComplete: true, servicesAck: ['junk'], qcPassed: true } })
    expect(r.status).toBe(200)
    const rec = transition.mock.calls[0][0].completionChecklist
    expect(rec).toMatchObject({ allWorkComplete: true, by: 'Tony' })
    expect(rec).not.toHaveProperty('servicesAck')
    expect(rec).not.toHaveProperty('qcPassed')   // QC not required → not recorded as passed
    expect(transition.mock.calls[0][0].completedBy).toBe('Tony')
  })

  it('refuses without the confirmation (server-side, not just a hidden control)', async () => {
    getOrder.mockResolvedValue(job())
    for (const completion of [undefined, {}, { allWorkComplete: false }, { servicesAck: ['Interior detail'], noRemaining: true, finalTouches: true }]) {
      const r = await call({ newStatus: 'ready', completion })
      expect(r.status).toBe(422)
    }
    expect(transition).not.toHaveBeenCalled()
  })

  it('requires an explicit QC pass when the Job requires QC', async () => {
    getOrder.mockResolvedValue(job({ qcRequired: true }))
    const r = await call({ newStatus: 'ready', completion: { allWorkComplete: true } })
    expect(r.status).toBe(422)
    expect((await r.json()).reason).toBe('qc_required')
    const ok = await call({ newStatus: 'ready', completion: { allWorkComplete: true, qcPassed: true } })
    expect(ok.status).toBe(200)
    expect(transition.mock.calls[0][0].completionChecklist).toMatchObject({ allWorkComplete: true, qcPassed: true })
  })

  it('counts WORK only — a Job whose list is all parts cannot be finished as work', async () => {
    getOrder.mockResolvedValue(job({ services: ['Cabin Air filter'], items: { services: [], partLabels: ['Cabin Air filter'], activePartLabels: ['Cabin Air filter'], parts: { total: 1, waiting: 0 } } }))
    const r = await call({ newStatus: 'ready', completion: { allWorkComplete: true } })
    expect((await r.json()).reason).toBe('no_services')
  })

  it('a repeat submit for an already-Ready Job is passed through without a new completion record', async () => {
    getOrder.mockResolvedValue(job({ status: 'ready' }))
    const r = await call({ newStatus: 'ready', completion: { allWorkComplete: true } })
    expect(r.status).toBe(200)
    expect(transition.mock.calls[0][0].completionChecklist).toBeNull()
  })
})
