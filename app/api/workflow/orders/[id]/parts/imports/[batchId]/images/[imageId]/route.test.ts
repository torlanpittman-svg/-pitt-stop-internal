/**
 * Original-screenshot route (no network/DB). EQUAL PERMISSIONS: it uses the SAME import gate as the rest of
 * the workflow (any authorized shop user), not a manager-only gate — while keeping private, job-/batch-/
 * image-scoped retrieval. A gate denial is returned as-is; wrong job or wrong image is 404.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const m = vi.hoisted(() => ({ gateDenied: false, getBatch: vi.fn(), listImages: vi.fn(), readBytes: vi.fn() }))
vi.mock('@/apps/parts/import-db', () => ({ getBatch: m.getBatch, listBatchImages: m.listImages }))
vi.mock('@/apps/parts/import-storage', () => ({ readImportImageBytes: m.readBytes }))
vi.mock('@/app/api/workflow/orders/[id]/parts/imports/_gate', () => ({
  importGate: async () => (m.gateDenied ? { response: NextResponse.json({ ok: false }, { status: 403 }) } : { actorName: 'Sample', actorKey: 'sample' }),
  isUuid: (s: string) => /^[a-f0-9-]{36}$/.test(s),
}))

import { GET } from '@/app/api/workflow/orders/[id]/parts/imports/[batchId]/images/[imageId]/route'
const id = '11111111-1111-4111-8111-111111111111', batchId = '22222222-2222-4222-8222-222222222222', imageId = '33333333-3333-4333-8333-333333333333'
const params = { params: Promise.resolve({ id, batchId, imageId }) }
const req = () => new Request('http://localhost/x')

beforeEach(() => {
  vi.clearAllMocks(); m.gateDenied = false
  m.getBatch.mockResolvedValue({ id: batchId, serviceOrderId: id })
  m.listImages.mockResolvedValue([{ id: imageId, storageRef: 'part-imports/x', contentType: 'image/png' }])
  m.readBytes.mockResolvedValue(Buffer.from('synthetic'))
})

it('a gate denial is returned as-is (no manager-only gate)', async () => {
  m.gateDenied = true
  const res = await GET(req(), params)
  expect(res.status).toBe(403)
  expect(m.getBatch).not.toHaveBeenCalled()
})

it('an authorized shop user may fetch the original (equal permission)', async () => {
  const res = await GET(req(), params)
  expect(res.status).toBe(200)
  expect(res.headers.get('Content-Type')).toBe('image/png')
})

it('a wrong-job batch is 404', async () => {
  m.getBatch.mockResolvedValue(null)
  const res = await GET(req(), params)
  expect(res.status).toBe(404)
  expect(m.readBytes).not.toHaveBeenCalled()
})

it('an image not on this batch is 404', async () => {
  m.listImages.mockResolvedValue([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', storageRef: 'x', contentType: 'image/png' }])
  const res = await GET(req(), params)
  expect(res.status).toBe(404)
  expect(m.readBytes).not.toHaveBeenCalled()
})
