/**
 * Batch route authorization + request hygiene (no DB/network): wrong-job read never triggers extraction,
 * mutations require an explicit revision, employees cannot apply, malformed/oversized bodies are rejected,
 * and the employee GET view is money-redacted.
 */
import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ read: vi.fn(), getView: vi.fn(), getBatch: vi.fn(), review: vi.fn(), apply: vi.fn(), cancel: vi.fn(), manager: true }))
vi.mock('@/apps/parts/import-read', () => ({ readBatch: m.read }))
vi.mock('@/apps/parts/import-db', () => ({ getBatchView: m.getView, getBatch: m.getBatch, saveBatchReview: m.review, applyImport: m.apply, cancelBatch: m.cancel }))
vi.mock('@/apps/expenses/db', () => ({ consumeRateLimit: vi.fn(async () => ({ ok: true })), RATE_LIMITS: { extractActor: { limit: 5, windowMs: 1000 }, extractReceipt: { limit: 5, windowMs: 1000 } } }))
vi.mock('@/platform/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/app/api/workflow/orders/[id]/parts/imports/_gate', () => ({
  importGate: async () => ({ manager: m.manager, actorName: 'Sample', actorKey: 'sample' }),
  isUuid: (s: string) => /^[a-f0-9-]{36}$/.test(s),
  sameOrigin: () => true,
}))

import { GET, POST } from '@/app/api/workflow/orders/[id]/parts/imports/[batchId]/route'
const id = '11111111-1111-4111-8111-111111111111', batchId = '22222222-2222-4222-8222-222222222222'
const params = { params: Promise.resolve({ id, batchId }) }
const req = (body: object) => new Request(`http://localhost/api/workflow/orders/${id}/parts/imports/${batchId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks(); m.manager = true
  m.read.mockResolvedValue({ ok: true, status: 'proposed' })
  m.review.mockResolvedValue({ ok: true }); m.apply.mockResolvedValue({ ok: true }); m.cancel.mockResolvedValue({ ok: true })
  const full = { id: batchId, serviceOrderId: id, status: 'proposed', revision: 1, documentKind: 'purchase', supplier: 'NAPA', orderReference: 'R', taxCents: 100, shippingCents: null, coreCents: null, markOrdered: false, duplicateConfirmed: false, aiStatus: 'extracted', images: [], warnings: {}, canMarkOrdered: true, existingParts: [{ id: 'p', description: 'x', partNumber: null, supplier: null, status: 'needed', billed: false }], rows: [{ id: 'r', unitCostCents: 999, listPriceCents: 888, lineTotalCents: 1000 }] }
  m.getView.mockResolvedValue(full); m.getBatch.mockResolvedValue(full)
})

it('wrong-job read must never trigger extraction', async () => {
  m.getBatch.mockResolvedValue(null)
  const res = await POST(req({ action: 'read' }), params)
  expect(res.status).toBe(404)
  expect(m.read).not.toHaveBeenCalled()
})

it.each(['review', 'apply', 'cancel'])('%s requires an explicit revision', async (action) => {
  const res = await POST(req({ action }), params)
  expect(res.status).toBe(400)
  expect(m.review).not.toHaveBeenCalled(); expect(m.apply).not.toHaveBeenCalled(); expect(m.cancel).not.toHaveBeenCalled()
})

it('employee cannot apply parts', async () => {
  m.manager = false
  const res = await POST(req({ action: 'apply', expectedRevision: 1 }), params)
  expect(res.status).toBe(403)
  expect(m.apply).not.toHaveBeenCalled()
})

it('a malformed JSON body is rejected', async () => {
  const bad = new Request(`http://localhost/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
  const res = await POST(bad, params)
  expect(res.status).toBe(400)
})

it('an oversized row array is rejected (not silently sliced)', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `${i}` }))
  const res = await POST(req({ action: 'review', expectedRevision: 1, rows }), params)
  expect(res.status).toBe(400)
  expect(m.review).not.toHaveBeenCalled()
})

it.each([
  { quantity: true },
  { unitCostCents: -1 },
  { unitCostCents: 1.25 },
  { description: { unexpected: 'object' } },
  { linkDecision: 'invented' },
  { linkDecision: ['new'] },            // an array must NOT coerce through String() past the enum check
  { matchedPartId: 'not-a-uuid' },
  { description: 'x'.repeat(5000) },    // oversized string is rejected, never truncated to a different value
])('a malformed manager row is rejected rather than coerced: %j', async (patch) => {
  const res = await POST(req({ action: 'review', expectedRevision: 1, rows: [{ id: '33333333-3333-4333-8333-333333333333', ...patch }] }), params)
  expect(res.status).toBe(400)
  expect(m.review).not.toHaveBeenCalled()
})

it.each([
  { documentKind: ['purchase'] },
  { supplier: 'x'.repeat(200) },
])('a malformed document field is rejected rather than coerced: %j', async (patch) => {
  const res = await POST(req({ action: 'review', expectedRevision: 1, ...patch }), params)
  expect(res.status).toBe(400)
  expect(m.review).not.toHaveBeenCalled()
})

it('a non-integer revision is rejected', async () => {
  const res = await POST(req({ action: 'apply', expectedRevision: 1.5 }), params)
  expect(res.status).toBe(400)
  expect(m.apply).not.toHaveBeenCalled()
})

it('employee GET view is money-redacted', async () => {
  m.manager = false
  const res = await GET(new Request('http://localhost/x'), params)
  const body = await res.json()
  expect(body.batch.taxCents).toBeNull()
  expect(body.batch.rows[0].unitCostCents).toBeNull()
  expect(body.batch.existingParts).toEqual([])
})
