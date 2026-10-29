/**
 * Batch route authorization + request hygiene (no DB/network). EQUAL PERMISSIONS: any authorized shop user
 * sees full money and may review/apply/cancel. The route still enforces wrong-job read scoping, an explicit
 * revision, and strict malformed/oversized rejection. (Unauthenticated / flag-off denial lives in the gate's
 * own test, since the gate is mocked here.)
 */
import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ read: vi.fn(), getView: vi.fn(), getBatch: vi.fn(), review: vi.fn(), apply: vi.fn(), cancel: vi.fn() }))
vi.mock('@/apps/parts/import-read', () => ({ readBatch: m.read }))
vi.mock('@/apps/parts/import-db', () => ({ getBatchView: m.getView, getBatch: m.getBatch, saveBatchReview: m.review, applyImport: m.apply, cancelBatch: m.cancel }))
vi.mock('@/apps/expenses/db', () => ({ consumeRateLimit: vi.fn(async () => ({ ok: true })), RATE_LIMITS: { extractActor: { limit: 5, windowMs: 1000 }, extractReceipt: { limit: 5, windowMs: 1000 } } }))
vi.mock('@/platform/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/app/api/workflow/orders/[id]/parts/imports/_gate', () => ({
  importGate: async () => ({ actorName: 'Sample', actorKey: 'sample' }),
  isUuid: (s: string) => /^[a-f0-9-]{36}$/.test(s),
  sameOrigin: () => true,
}))

import { GET, POST } from '@/app/api/workflow/orders/[id]/parts/imports/[batchId]/route'
const id = '11111111-1111-4111-8111-111111111111', batchId = '22222222-2222-4222-8222-222222222222'
const params = { params: Promise.resolve({ id, batchId }) }
const req = (body: object) => new Request(`http://localhost/api/workflow/orders/${id}/parts/imports/${batchId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  m.read.mockResolvedValue({ ok: true, status: 'proposed' })
  m.review.mockResolvedValue({ ok: true }); m.apply.mockResolvedValue({ ok: true }); m.cancel.mockResolvedValue({ ok: true })
  const full = { id: batchId, serviceOrderId: id, status: 'proposed', revision: 1, documentKind: 'purchase', supplier: 'NAPA', orderReference: 'R', taxCents: 100, shippingCents: null, coreCents: null, markOrdered: false, duplicateConfirmed: false, aiStatus: 'extracted', images: [], warnings: {}, canMarkOrdered: true, existingParts: [{ id: 'p', description: 'x', partNumber: null, supplier: null, status: 'needed', billed: false, quantity: 1, supplierOrderNumber: null, unitCostCents: 500 }], rows: [{ id: 'r', unitCostCents: 999, listPriceCents: 888, lineTotalCents: 1000 }] }
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

it('any authorized shop user may review with a valid revision', async () => {
  const res = await POST(req({ action: 'review', expectedRevision: 1, rows: [] }), params)
  expect(res.status).toBe(200)
  expect(m.review).toHaveBeenCalledTimes(1)
})

it('any authorized shop user may apply with a valid revision', async () => {
  const res = await POST(req({ action: 'apply', expectedRevision: 1 }), params)
  expect(res.status).toBe(200)
  expect(m.apply).toHaveBeenCalledTimes(1)
})

it('any authorized shop user may cancel with a valid revision', async () => {
  const res = await POST(req({ action: 'cancel', expectedRevision: 1 }), params)
  expect(res.status).toBe(200)
  expect(m.cancel).toHaveBeenCalledTimes(1)
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
])('a malformed row is rejected rather than coerced: %j', async (patch) => {
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

it('GET returns full money + originals to any authorized user (no redaction)', async () => {
  const res = await GET(new Request('http://localhost/x'), params)
  const body = await res.json()
  expect(body.canReview).toBe(true)
  expect(body.batch.taxCents).toBe(100)
  expect(body.batch.rows[0].unitCostCents).toBe(999)
  expect(body.batch.existingParts).toHaveLength(1)
})
