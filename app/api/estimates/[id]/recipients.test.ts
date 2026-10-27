/**
 * The estimate action route forwards the explicit per-send recipient list to sendIntakeEstimate, bounds the
 * raw input, and stays manager-gated. The send helper itself is mocked here (its own normalization,
 * QuickBooks, and send-identity rules are covered in apps/estimates/quickbooks.test.ts) — this verifies the
 * route contract: validation, forwarding, and auth. No QuickBooks, DB, or network.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const ID = '11111111-1111-4111-8111-111111111111'
const REV = 'a'.repeat(64)
const h = vi.hoisted(() => ({
  manager: { name: 'Mgr' } as { name: string } | null,
  send: vi.fn(),
  saveNotes: vi.fn(),
  summary: {} as Record<string, unknown>,
}))
vi.mock('@/apps/checks/authz', () => ({ managerFromRequest: async () => h.manager }))
vi.mock('@/apps/estimates/db', () => ({
  withIntakeLock: async (_id: string, fn: () => Promise<unknown>) => fn(),
  moveIntakeToBoard: vi.fn(), cancelIntakeEstimate: vi.fn(),
}))
vi.mock('@/apps/estimates/quickbooks', () => ({
  intakeSummary: async () => h.summary, refreshIntake: async () => h.summary, sendIntakeEstimate: h.send,
}))
// The notes DB write is mocked; its own persistence/audit is covered in apps/estimates/notes-db.test.ts.
// The pure notes validation (@/apps/estimates/notes) is left REAL so normalization/bounds run for real here.
vi.mock('@/apps/estimates/notes-db', () => ({ saveCustomerNotes: h.saveNotes }))
vi.mock('@/apps/quick-entry/schema', () => ({ quickEntryJobs: {} }))
vi.mock('@/platform/db', () => ({ getDb: () => ({ update: () => ({ set: () => ({ where: async () => {} }) }) }) }))
vi.mock('@/apps/workflow/estimate', () => ({ estimateEnabled: () => true }))
vi.mock('@/apps/workflow/customer-name', () => ({ renameOrderCustomer: vi.fn(), CUSTOMER_NAME_MAX: 200 }))

import { POST } from './route'

const post = (body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: ID }) })

beforeEach(() => {
  h.manager = { name: 'Mgr' }
  h.send.mockReset().mockResolvedValue({ alreadySent: false })
  h.saveNotes.mockReset().mockResolvedValue(undefined)
  h.summary = {
    order: { status: 'estimate', customerName: 'Cust' }, revision: REV,
    draft: { priced: true, totalCents: 10000 }, contact: { customerEmail: 'c@x.com', customerPhone: '555' },
    intake: { qbEstimateNumber: '1001', sentAt: null }, full: { estimate: { id: 'est-1', convertedAt: null, customerNotes: null } },
  }
})

describe('POST /api/estimates/[id] — send recipients', () => {
  it('forwards an explicit recipient list to sendIntakeEstimate', async () => {
    const res = await post({ action: 'send', revision: REV, recipients: ['a@x.com', 'b@x.com'] })
    expect(res.status).toBe(200)
    expect(h.send).toHaveBeenCalledWith(ID, 'Mgr', REV, ['a@x.com', 'b@x.com'])
  })

  it('omits recipients → sendIntakeEstimate gets undefined (saved-contact fallback)', async () => {
    const res = await post({ action: 'send', revision: REV })
    expect(res.status).toBe(200)
    expect(h.send).toHaveBeenCalledWith(ID, 'Mgr', REV, undefined)
  })

  it('rejects a non-array recipients value before any work', async () => {
    const res = await post({ action: 'send', revision: REV, recipients: 'a@x.com' })
    expect(res.status).toBe(400)
    expect(h.send).not.toHaveBeenCalled()
  })

  it('rejects an over-bound raw recipient array', async () => {
    const res = await post({ action: 'send', revision: REV, recipients: Array.from({ length: 51 }, (_, i) => `u${i}@x.com`) })
    expect(res.status).toBe(400)
    expect(h.send).not.toHaveBeenCalled()
  })

  it('stays manager-gated — a non-manager cannot send', async () => {
    h.manager = null
    const res = await post({ action: 'send', revision: REV, recipients: ['a@x.com'] })
    expect(res.status).toBe(403)
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('POST /api/estimates/[id] — customer notes', () => {
  it('forwards NORMALIZED notes (CRLF/whitespace trimmed) to saveCustomerNotes with the estimate id + actor', async () => {
    const res = await post({ action: 'notes', revision: REV, notes: '  Claim number: #062404763  \r\n' })
    expect(res.status).toBe(200)
    expect(h.saveNotes).toHaveBeenCalledWith({ orderId: ID, estimateId: 'est-1', notes: 'Claim number: #062404763', actor: 'Mgr' })
  })

  it('rejects a stale revision before writing anything', async () => {
    const res = await post({ action: 'notes', revision: 'b'.repeat(64), notes: 'Claim: A' })
    expect(res.status).toBe(409)
    expect(h.saveNotes).not.toHaveBeenCalled()
  })

  it('rejects notes over the business bound (700) without writing', async () => {
    const res = await post({ action: 'notes', revision: REV, notes: 'x'.repeat(701) })
    expect(res.status).toBe(409)
    expect(h.saveNotes).not.toHaveBeenCalled()
  })

  it('rejects a raw payload past the schema cap before any handler work', async () => {
    const res = await post({ action: 'notes', revision: REV, notes: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
    expect(h.saveNotes).not.toHaveBeenCalled()
  })

  it('stays manager-gated — a non-manager cannot save notes', async () => {
    h.manager = null
    const res = await post({ action: 'notes', revision: REV, notes: 'Claim: A' })
    expect(res.status).toBe(403)
    expect(h.saveNotes).not.toHaveBeenCalled()
  })

  it('refuses to save notes on a cancelled estimate', async () => {
    ;(h.summary.order as { status: string }).status = 'cancelled'
    const res = await post({ action: 'notes', revision: REV, notes: 'Claim: A' })
    expect(res.status).toBe(409)
    expect(h.saveNotes).not.toHaveBeenCalled()
  })
})
