/**
 * POST /invoice/payment — role gate, kill-switch, and the installment body reaching the service unchanged
 * (amount validation itself is server-side in retail-payment-service; covered there). No QuickBooks, no DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const auth = vi.hoisted(() => ({ role: 'manager' as string | null, enabled: true }))
const calls = vi.hoisted(() => ({ record: [] as unknown[], preview: 0 }))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => (auth.role ? { name: 'Mgr', role: auth.role } : null),
}))
vi.mock('@/apps/settings/db', () => ({ retailQbPaymentEnabled: async () => auth.enabled }))
vi.mock('@/apps/quickbooks/retail-payment-service', () => ({
  previewRetailPayment: async () => { calls.preview++; return { ok: true, status: 'partial' } },
  recordRetailPayment: async (p: unknown) => { calls.record.push(p); return { ok: true, status: 'recorded' } },
}))

import { POST } from './route'

const post = (body: unknown) => POST(new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'o1' }) })

beforeEach(() => { auth.role = 'manager'; auth.enabled = true; calls.record = []; calls.preview = 0 })

describe('POST /invoice/payment', () => {
  it('employees and signed-out requests are refused before anything runs', async () => {
    for (const role of ['employee', null]) {
      auth.role = role
      const res = await post({ action: 'record', method: 'cash', amountCents: 200000, balanceCents: 241100 })
      expect(res.status).toBe(403)
    }
    expect(calls.record).toHaveLength(0)
    expect(calls.preview).toBe(0)
  })

  it('kill-switch off → 503, nothing recorded', async () => {
    auth.enabled = false
    expect((await post({ action: 'record', method: 'cash', amountCents: 100 , balanceCents: 100 })).status).toBe(503)
    expect(calls.record).toHaveLength(0)
  })

  it('manager and admin: an installment body is passed through as amount + confirmed balance', async () => {
    for (const role of ['manager', 'admin']) {
      auth.role = role
      expect((await post({ action: 'record', method: 'card_terminal', amountCents: 200000, balanceCents: 241100 })).status).toBe(200)
    }
    expect(calls.record).toEqual([
      { orderId: 'o1', actor: 'Mgr', method: 'card_terminal', amountCents: 200000, balanceCents: 241100 },
      { orderId: 'o1', actor: 'Mgr', method: 'card_terminal', amountCents: 200000, balanceCents: 241100 },
    ])
  })

  it('an older client body keeps the full-payment contract', async () => {
    await post({ action: 'record', method: 'cash', confirmedAmountCents: 21218 })
    expect(calls.record).toEqual([{ orderId: 'o1', actor: 'Mgr', method: 'cash', confirmedAmountCents: 21218 }])
  })

  it('a malformed amount still goes to the service, which refuses it (never coerced here)', async () => {
    await post({ action: 'record', method: 'cash', amountCents: '2000', balanceCents: 241100, confirmationId: 'k1', intent: 'partial' })
    expect(calls.record).toEqual([{ orderId: 'o1', actor: 'Mgr', method: 'cash', amountCents: '2000', balanceCents: 241100, confirmationId: 'k1', intent: 'partial' }])
  })
})
