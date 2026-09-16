import { describe, it, expect, vi, beforeEach } from 'vitest'

// Byte-verified conflict handling for immutable private upload. Mock the SDK primitives; assert the
// pathname is reused ONLY when the existing object's bytes match the incoming original (length + SHA-256),
// via supported SDK behavior (get with the receipt token) — never message matching, never overwrite/delete.
vi.mock('@vercel/blob', () => ({ put: vi.fn(), get: vi.fn(), head: vi.fn(), del: vi.fn() }))

import { put, get } from '@vercel/blob'
import { uploadPrivatePhoto, getPrivateBlob } from './blob'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const KEY = 'business-receipts/abc.jpg'
const ORIGINAL = Buffer.from('the-original-receipt-bytes')

// A synthetic get() result streaming the given bytes (statusCode 200), matching the SDK's shape.
function getResult(bytes: Buffer) {
  return {
    statusCode: 200 as const,
    blob: { size: bytes.length, contentType: 'image/jpeg', pathname: KEY },
    stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close() } }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.RECEIPTS_BLOB_READ_WRITE_TOKEN = 'test-token'
})

describe('uploadPrivatePhoto — immutable create + byte-verified conflict reuse', () => {
  it('ordinary successful creation returns the pathname (immutable write options)', async () => {
    asMock(put).mockResolvedValue({ pathname: KEY })
    expect(await uploadPrivatePhoto(KEY, ORIGINAL, 'image/jpeg')).toBe(KEY)
    expect(asMock(put).mock.calls[0][2]).toMatchObject({ access: 'private', allowOverwrite: false, addRandomSuffix: false })
    expect(asMock(get)).not.toHaveBeenCalled() // no fetch on the happy path
  })

  it('CONFLICT + MATCHING bytes → reuse the pathname', async () => {
    asMock(put).mockRejectedValue(new Error('conflict'))
    asMock(get).mockResolvedValue(getResult(ORIGINAL))
    expect(await uploadPrivatePhoto(KEY, ORIGINAL, 'image/jpeg')).toBe(KEY)
    expect(asMock(get)).toHaveBeenCalledWith(KEY, expect.objectContaining({ access: 'private', token: 'test-token' }))
  })

  it('CONFLICT + WRONG bytes (same length) → fail safe (rethrow, no reuse)', async () => {
    const wrong = Buffer.from(ORIGINAL); wrong[0] ^= 0xff // same length, one byte differs
    expect(wrong.length).toBe(ORIGINAL.length)
    asMock(put).mockRejectedValue(new Error('real-write-error'))
    asMock(get).mockResolvedValue(getResult(wrong))
    await expect(uploadPrivatePhoto(KEY, ORIGINAL, 'image/jpeg')).rejects.toThrow('real-write-error')
  })

  it('CONFLICT + WRONG length → fail safe (rethrow)', async () => {
    asMock(put).mockRejectedValue(new Error('real-write-error'))
    asMock(get).mockResolvedValue(getResult(Buffer.concat([ORIGINAL, Buffer.from('extra')])))
    await expect(uploadPrivatePhoto(KEY, ORIGINAL, 'image/jpeg')).rejects.toThrow('real-write-error')
  })

  it('CONFLICT + MISSING object (get returns null) → fail safe (rethrow)', async () => {
    asMock(put).mockRejectedValue(new Error('real-write-error'))
    asMock(get).mockResolvedValue(null)
    await expect(uploadPrivatePhoto(KEY, ORIGINAL, 'image/jpeg')).rejects.toThrow('real-write-error')
  })

  it('CONFLICT + RETRIEVAL failure (get throws) → fail safe (rethrow original)', async () => {
    asMock(put).mockRejectedValue(new Error('real-write-error'))
    asMock(get).mockRejectedValue(new Error('network'))
    await expect(uploadPrivatePhoto(KEY, ORIGINAL, 'image/jpeg')).rejects.toThrow('real-write-error')
  })

  it('MISSING config (no private token) → config error, no public fallback', async () => {
    delete process.env.RECEIPTS_BLOB_READ_WRITE_TOKEN
    await expect(uploadPrivatePhoto(KEY, ORIGINAL, 'image/jpeg')).rejects.toThrow(/RECEIPTS_BLOB_READ_WRITE_TOKEN/)
  })
})

describe('getPrivateBlob — namespace restriction', () => {
  it('refuses a pathname outside the receipt namespace (no fetch)', async () => {
    expect(await getPrivateBlob('other-store/secret.jpg')).toBeNull()
    expect(asMock(get)).not.toHaveBeenCalled()
  })
})
