import { describe, it, expect, vi, beforeEach } from 'vitest'

// A tiny chainable stand-in for the drizzle query builder so we can exercise removeVehicleExpense's
// branching (guards, idempotency, the append shape) without a live Postgres. select() results are queued
// in call order; insert() values are captured. eq/and/ne run for real against the real columns (harmless).
const h = vi.hoisted(() => ({ selects: [] as unknown[][], inserts: [] as Record<string, unknown>[] }))
vi.mock('@/platform/db', () => ({
  getDb: () => {
    let i = 0
    const builder = () => {
      const b: Record<string, unknown> = {}
      b.from = () => b; b.where = () => b
      b.limit = () => Promise.resolve(h.selects[i++] ?? [])
      return b
    }
    return { select: () => builder(), insert: () => ({ values: (v: Record<string, unknown>) => { h.inserts.push(v); return Promise.resolve() } }) }
  },
}))

import { removeVehicleExpense } from './db'

const orig = (o: Record<string, unknown> = {}) => ({
  id: 'exp-1', inventoryVehicleId: 'veh-9', economicCategory: 'part', amountCents: 25_000, eventDate: '2026-03-02',
  vendor: 'O’Reilly', memo: 'brake pads', status: 'verified', finTransactionId: null, documentId: 'doc-7', ...o,
})

beforeEach(() => { h.selects = []; h.inserts = [] })

describe('removeVehicleExpense — mistaken-attachment correction (append-only, guarded, idempotent)', () => {
  it('appends a reversing adjustment with an attributed audit; preserves the original + receipt', async () => {
    h.selects = [[orig()], []]                       // 1) the expense  2) no existing reversal
    const r = await removeVehicleExpense({ eventId: 'exp-1', actor: 'Darryl' })
    expect(r).toEqual({ ok: true })
    expect(h.inserts).toHaveLength(1)
    const ins = h.inserts[0]
    expect(ins.economicCategory).toBe('adjustment')     // NOT a return/refund
    expect(ins.cashflowCategory).toBe('non_cash')        // no money movement
    expect(ins.reversesEventId).toBe('exp-1')            // nets the original out of cost/profit
    expect(ins.amountCents).toBe(25_000)
    expect(ins.inventoryVehicleId).toBe('veh-9')
    const removal = (ins.evidence as { removal: Record<string, unknown> }).removal
    expect(removal.removedBy).toBe('Darryl')
    expect(removal.formerVehicleId).toBe('veh-9')
    expect(removal.originalEventId).toBe('exp-1')
    expect(removal.originalCategory).toBe('part')
    expect(removal.originalAmountCents).toBe(25_000)
    expect(removal.documentId).toBe('doc-7')            // receipt reference preserved
    expect(typeof removal.removedAt).toBe('string')
  })

  it('is idempotent — a second request with an existing reversal makes NO new adjustment', async () => {
    h.selects = [[orig()], [{ id: 'rev-1' }]]            // an adjustment already reverses this expense
    const r = await removeVehicleExpense({ eventId: 'exp-1', actor: 'Darryl' })
    expect(r).toEqual({ ok: true, alreadyRemoved: true })
    expect(h.inserts).toHaveLength(0)
  })

  it('refuses a non-expense (acquisition/sale/return) — those are corrected elsewhere', async () => {
    h.selects = [[orig({ economicCategory: 'acquisition' })]]
    const r = await removeVehicleExpense({ eventId: 'exp-1', actor: 'Darryl' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Acquisition|removed here/i)
    expect(h.inserts).toHaveLength(0)
  })

  it('refuses a reconciled / accounting-linked expense with a clear explanation (no QuickBooks touched)', async () => {
    h.selects = [[orig({ status: 'reconciled' })]]
    const r1 = await removeVehicleExpense({ eventId: 'exp-1', actor: 'Darryl' })
    expect(r1.ok).toBe(false)
    expect(r1.error).toMatch(/accountant|unlink|linked/i)

    h.selects = [[orig({ finTransactionId: 'fin-123' })]]
    const r2 = await removeVehicleExpense({ eventId: 'exp-1', actor: 'Darryl' })
    expect(r2.ok).toBe(false)
    expect(h.inserts).toHaveLength(0)
  })

  it('safe no-ops on an already-void entry and on a missing expense', async () => {
    h.selects = [[orig({ status: 'void' })]]
    expect((await removeVehicleExpense({ eventId: 'exp-1', actor: 'x' })).ok).toBe(false)
    h.selects = [[]]
    expect((await removeVehicleExpense({ eventId: 'nope', actor: 'x' })).ok).toBe(false)
    expect(h.inserts).toHaveLength(0)
  })
})
