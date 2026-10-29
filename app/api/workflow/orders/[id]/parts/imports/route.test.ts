/**
 * Upload route hygiene (no network/DB): fast durable ack without reading AI, validate-all-before-store,
 * storage-failure never reports saved, captureId must be text, the body stream is byte-capped even without a
 * Content-Length, and too-many/too-few/invalid members are rejected. Uses the in-repo synthetic sample PNG.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const m = vi.hoisted(() => ({ store: vi.fn(), create: vi.fn(), job: vi.fn() }))
vi.mock('@/apps/parts/import-db', () => ({ getImportJobContext: m.job, createBatchWithImages: m.create, listBatchesForOrder: vi.fn(async () => []) }))
vi.mock('@/apps/parts/import-storage', () => ({ importStorageKey: () => 'synthetic-private-key', storeImportImageBytes: m.store }))
vi.mock('@/apps/expenses/db', () => ({ consumeRateLimit: vi.fn(async () => ({ ok: true })), RATE_LIMITS: { upload: { limit: 5, windowMs: 1000 } } }))
vi.mock('@/platform/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/app/api/workflow/orders/[id]/parts/imports/_gate', () => ({ importGate: async () => ({ manager: true, actorName: 'Sample', actorKey: 'sample' }), isUuid: (s: string) => /^[a-f0-9-]{36}$/.test(s), sameOrigin: () => true }))

import { POST } from '@/app/api/workflow/orders/[id]/parts/imports/route'
const id = '11111111-1111-4111-8111-111111111111', batchId = '22222222-2222-4222-8222-222222222222'
const url = `http://localhost/api/workflow/orders/${id}/parts/imports`
const png = readFileSync(path.join(process.cwd(), 'scripts', 'parts-preview', 'assets', 'sample-order.png'))
const form = () => { const f = new FormData(); f.append('screenshots', new File([png], 'sample.png', { type: 'image/png' })); return f }
const request = (body: FormData) => new Request(url, { method: 'POST', body })

beforeEach(() => { vi.clearAllMocks(); m.store.mockResolvedValue('private-test'); m.create.mockResolvedValue({ batchId, duplicate: false }); m.job.mockResolvedValue({ orderId: id, orderNumber: 'SAMPLE' }) })

it('valid image is durably acknowledged without reading AI in the upload request', async () => {
  const res = await POST(request(form()), { params: Promise.resolve({ id }) })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ saved: true, batchId })
  expect(m.store).toHaveBeenCalledTimes(1); expect(m.create).toHaveBeenCalledTimes(1)
})

it('an invalid last screenshot rejects all before storing the valid first image', async () => {
  const f = form(); f.append('screenshots', new File(['garbage'], 'bad.png', { type: 'image/png' }))
  const res = await POST(request(f), { params: Promise.resolve({ id }) })
  expect(res.status).toBe(415); expect(m.store).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled()
})

it('storage failure never reports a saved batch', async () => {
  m.store.mockRejectedValue(new Error('synthetic unavailable'))
  const res = await POST(request(form()), { params: Promise.resolve({ id }) })
  expect(res.status).toBe(502); expect(m.create).not.toHaveBeenCalled(); expect(await res.json()).toMatchObject({ ok: false })
})

it('capture ID must be text, not an uploaded file', async () => {
  const f = form(); f.append('captureId', new File(['not an id'], 'id.txt', { type: 'text/plain' }))
  const res = await POST(request(f), { params: Promise.resolve({ id }) })
  expect(res.status).toBe(400); expect(m.store).not.toHaveBeenCalled()
})

it('actual stream bytes are capped even without Content-Length', async () => {
  let cancelled = false; let emitted = 0
  const body = new ReadableStream<Uint8Array>({ pull(controller) { emitted++; controller.enqueue(new Uint8Array(1024 * 1024)); if (emitted === 12) controller.close() }, cancel() { cancelled = true } })
  const req = new Request(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=sample' }, body, duplex: 'half' } as RequestInit)
  const res = await POST(req, { params: Promise.resolve({ id }) })
  expect(res.status).toBe(413); expect(cancelled).toBe(true); expect(emitted).toBeLessThan(12); expect(m.store).not.toHaveBeenCalled()
})

it('five screenshots are rejected before storing any', async () => {
  const f = form(); for (let i = 0; i < 4; i++) f.append('screenshots', new File([png], `sample${i}.png`, { type: 'image/png' }))
  const res = await POST(request(f), { params: Promise.resolve({ id }) })
  expect(res.status).toBe(400); expect(m.store).not.toHaveBeenCalled()
})
