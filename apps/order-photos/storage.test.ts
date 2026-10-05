import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
vi.mock('@vercel/blob', () => ({ get: vi.fn(), put: vi.fn() }))
import { get, put } from '@vercel/blob'
import { readPhotoBytes, storePhotoBytes } from './storage'
import { MAX_PHOTO_BYTES } from './types'
const bytes = Buffer.from('test image bytes')
const path = `order-photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${createHash('sha256').update(bytes).digest('hex')}.jpg`
afterEach(() => vi.unstubAllEnvs())

function blobResponse(data: Buffer, size = data.length) {
  return { statusCode: 200, blob: { size }, stream: new ReadableStream({ start(controller) { controller.enqueue(data); controller.close() } }) } as Awaited<ReturnType<typeof get>>
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ORDER_PHOTOS_BLOB_READ_WRITE_TOKEN', '')
  vi.stubEnv('RECEIPTS_BLOB_READ_WRITE_TOKEN', 'private-test-token')
  vi.mocked(get).mockResolvedValue(blobResponse(bytes))
  vi.mocked(put).mockResolvedValue({ pathname: path } as Awaited<ReturnType<typeof put>>)
})
it('uploads privately with immutable keys and never uses a public store token', async () => {
  expect(await storePhotoBytes(path, bytes, 'image/jpeg')).toBe(path)
  expect(put).toHaveBeenCalledWith(path, bytes, expect.objectContaining({ access: 'private', token: 'private-test-token', allowOverwrite: false, addRandomSuffix: false }))
})
it('recovers a duplicate storage write only when bytes are identical', async () => {
  vi.mocked(put).mockRejectedValue(new Error('exists'))
  expect(await storePhotoBytes(path, bytes, 'image/jpeg')).toBe(path)
  vi.mocked(get).mockResolvedValue(blobResponse(Buffer.from('different')))
  await expect(storePhotoBytes(path, bytes, 'image/jpeg')).rejects.toThrow('exists')
})
it('rejects other namespaces and full URLs before requesting storage', async () => {
  expect(await readPhotoBytes('business-receipts/test.jpg')).toBeNull()
  expect(await readPhotoBytes('https://example.com/photo.jpg')).toBeNull()
  expect(get).not.toHaveBeenCalled()
  await expect(storePhotoBytes('../other', bytes, 'image/jpeg')).rejects.toThrow()
  expect(put).not.toHaveBeenCalled()
})
it('does not silently fall back to public storage when private storage is unconfigured', async () => {
  vi.stubEnv('RECEIPTS_BLOB_READ_WRITE_TOKEN', '')
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'public-test-token')
  await expect(storePhotoBytes(path, bytes, 'image/jpeg')).rejects.toThrow('not configured')
  expect(put).not.toHaveBeenCalled()
})
it('bounds both advertised size and actual streamed bytes', async () => {
  vi.mocked(get).mockResolvedValue(blobResponse(bytes, MAX_PHOTO_BYTES + 1))
  expect(await readPhotoBytes(path)).toBeNull()
  vi.mocked(get).mockResolvedValue(blobResponse(Buffer.alloc(MAX_PHOTO_BYTES + 1), 100))
  expect(await readPhotoBytes(path)).toBeNull()
})
