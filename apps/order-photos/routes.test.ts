import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createHash } from 'node:crypto'

vi.mock('@/apps/auth/employee-guard', () => ({ authenticatedActorFromRequest: vi.fn(), isManagerRole: (role: string) => ['manager', 'admin'].includes(role) }))
vi.mock('./db', () => ({ photoOrderExists: vi.fn(), listOrderPhotos: vi.fn(), saveOrderPhoto: vi.fn(), getOrderPhoto: vi.fn(), updateOrderPhoto: vi.fn() }))
vi.mock('./storage', () => ({ readPhotoBytes: vi.fn(), storePhotoBytes: vi.fn() }))
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { photoOrderExists, listOrderPhotos, saveOrderPhoto, getOrderPhoto, updateOrderPhoto } from './db'
import { readPhotoBytes, storePhotoBytes } from './storage'
import { GET as list, POST as upload } from '@/app/api/workflow/orders/[id]/photos/route'
import { GET as image, PATCH as edit, DELETE as remove } from '@/app/api/workflow/orders/[id]/photos/[photoId]/route'
import { MAX_PHOTO_BYTES } from './types'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const photoId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const context = { params: Promise.resolve({ id, photoId }) }
const url = `http://localhost/api/workflow/orders/${id}/photos`
let jpeg: Buffer
beforeAll(async () => { jpeg = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#999999' } }).jpeg().toBuffer() })
function request(bytes: Buffer = jpeg, type = 'image/jpeg') {
  const form = new FormData()
  form.append('photo', new File([new Uint8Array(bytes)], 'damage.jpg', { type }))
  return new Request(url, { method: 'POST', body: form })
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(authenticatedActorFromRequest).mockResolvedValue({ name: 'Manager', key: 'mgr', role: 'manager' })
  vi.mocked(photoOrderExists).mockResolvedValue(true)
  vi.mocked(listOrderPhotos).mockResolvedValue([])
  vi.mocked(saveOrderPhoto).mockResolvedValue({ id: photoId } as Awaited<ReturnType<typeof saveOrderPhoto>>)
  vi.mocked(storePhotoBytes).mockImplementation(async (path) => path)
  vi.mocked(getOrderPhoto).mockResolvedValue({ id: photoId, storagePath: 'private', filename: 'door.jpg', contentType: 'image/jpeg' } as Awaited<ReturnType<typeof getOrderPhoto>>)
  vi.mocked(readPhotoBytes).mockResolvedValue(jpeg)
  vi.mocked(updateOrderPhoto).mockResolvedValue({ id: photoId } as Awaited<ReturnType<typeof updateOrderPhoto>>)
})

describe('photo access and uploads', () => {
  it.each([null, { name: 'Employee', key: 'emp', role: 'employee' as const }])('denies all photo endpoints to a non-manager (%s)', async (actor) => {
    vi.mocked(authenticatedActorFromRequest).mockResolvedValue(actor)
    for (const handler of [list, upload, image, edit, remove]) expect((await handler(new Request(url), context)).status).toBe(403)
    expect(photoOrderExists).not.toHaveBeenCalled()
    expect(storePhotoBytes).not.toHaveBeenCalled()
    expect(readPhotoBytes).not.toHaveBeenCalled()
  })
  it('checks parent existence before parsing or storing a file', async () => {
    vi.mocked(photoOrderExists).mockResolvedValue(false)
    expect((await upload(request(), context)).status).toBe(404)
    expect(storePhotoBytes).not.toHaveBeenCalled()
  })
  it('preserves submitted bytes, hashes them, stores privately, and uses verified attribution', async () => {
    expect((await upload(request(), context)).status).toBe(200)
    expect(storePhotoBytes).toHaveBeenCalledWith(`order-photos/${id}/${createHash('sha256').update(jpeg).digest('hex')}.jpg`, jpeg, 'image/jpeg')
    expect(saveOrderPhoto).toHaveBeenCalledWith(expect.objectContaining({ serviceOrderId: id, uploadedBy: 'Manager', byteSize: jpeg.length, resized: false }))
  })
  it('accepts signature-verified images when the browser omits MIME type', async () => {
    expect((await upload(request(jpeg, ''), context)).status).toBe(200)
  })
  it.each([
    ['HTML with a spoofed image MIME', Buffer.from('<html>unsafe</html>'), 'image/jpeg'],
    ['mismatched MIME', null, 'image/png'],
    ['truncated JPEG', Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'],
  ])('rejects %s before storage', async (_label, bytes, type) => {
    expect((await upload(request(bytes ?? jpeg, type), context)).status).toBe(415)
    expect(storePhotoBytes).not.toHaveBeenCalled()
  })
  it('rejects empty and oversized uploads', async () => {
    expect((await upload(request(Buffer.alloc(0)), context)).status).toBe(400)
    expect((await upload(request(Buffer.alloc(MAX_PHOTO_BYTES + 1)), context)).status).toBe(413)
    expect(storePhotoBytes).not.toHaveBeenCalled()
  })
  it('does not create a photo record when storage fails', async () => {
    vi.mocked(storePhotoBytes).mockRejectedValue(new Error('private storage down'))
    expect((await upload(request(), context)).status).toBe(502)
    expect(saveOrderPhoto).not.toHaveBeenCalled()
  })
  it('returns an error when database persistence fails, so the UI can retry', async () => {
    vi.mocked(saveOrderPhoto).mockRejectedValue(new Error('db down'))
    expect((await upload(request(), context)).status).toBe(500)
  })
  it('validates ids before querying the database', async () => {
    expect((await list(new Request(url), { params: Promise.resolve({ id: 'invalid' }) })).status).toBe(404)
    expect(photoOrderExists).not.toHaveBeenCalled()
  })
})

describe('photo reads and changes', () => {
  it('serves a private, non-cacheable download with no external URL', async () => {
    const response = await image(new Request(`${url}/${photoId}?download=1`), context)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="door.jpg"')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg)
    expect(getOrderPhoto).toHaveBeenCalledWith(id, photoId)
  })
  it('never fetches bytes for an absent/removed/cross-order photo', async () => {
    vi.mocked(getOrderPhoto).mockResolvedValue(null)
    expect((await image(new Request(url), context)).status).toBe(404)
    expect(readPhotoBytes).not.toHaveBeenCalled()
  })
  it('only updates caption and inclusion fields, never a supplied storage path', async () => {
    const req = new Request(url, { method: 'PATCH', body: JSON.stringify({ caption: ' Before repair ', included: false, storagePath: 'other' }) })
    expect((await edit(req, context)).status).toBe(200)
    expect(updateOrderPhoto).toHaveBeenCalledWith(id, photoId, { caption: 'Before repair', included: false })
  })
  it.each([{ caption: 'a'.repeat(501) }, { included: 'true' }, {}, { caption: 10 }])('rejects invalid metadata (%s)', async (body) => {
    expect((await edit(new Request(url, { method: 'PATCH', body: JSON.stringify(body) }), context)).status).toBe(400)
    expect(updateOrderPhoto).not.toHaveBeenCalled()
  })
  it('returns missing for a cross-order edit or removal', async () => {
    vi.mocked(updateOrderPhoto).mockResolvedValue(null)
    expect((await edit(new Request(url, { method: 'PATCH', body: JSON.stringify({ caption: 'X' }) }), context)).status).toBe(404)
    expect((await remove(new Request(url, { method: 'DELETE' }), context)).status).toBe(404)
  })
})
