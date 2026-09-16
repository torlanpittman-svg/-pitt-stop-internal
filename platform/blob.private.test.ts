import { describe, it, expect, vi, beforeEach } from 'vitest'

// Deterministic conflict handling for immutable private upload. Mock the SDK primitives; assert we reuse
// the pathname ONLY when head() confirms the object exists (status-based) — never by matching a message.
vi.mock('@vercel/blob', () => ({ put: vi.fn(), get: vi.fn(), head: vi.fn(), del: vi.fn() }))

import { put, head } from '@vercel/blob'
import { uploadPrivatePhoto, getPrivateBlob } from './blob'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const KEY = 'business-receipts/abc.jpg'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.RECEIPTS_BLOB_READ_WRITE_TOKEN = 'test-token'
})

describe('uploadPrivatePhoto — immutable create + deterministic conflict', () => {
  it('returns the pathname on a clean create', async () => {
    asMock(put).mockResolvedValue({ pathname: KEY })
    expect(await uploadPrivatePhoto(KEY, Buffer.from([1]), 'image/jpeg')).toBe(KEY)
    expect(asMock(put).mock.calls[0][2]).toMatchObject({ access: 'private', allowOverwrite: false, addRandomSuffix: false })
  })

  it('on a write CONFLICT, reuses the pathname only after head() confirms the exact object exists', async () => {
    asMock(put).mockRejectedValue(new Error('boom')) // generic error, NOT "already exists"
    asMock(head).mockResolvedValue({ pathname: KEY })
    expect(await uploadPrivatePhoto(KEY, Buffer.from([1]), 'image/jpeg')).toBe(KEY)
    expect(asMock(head)).toHaveBeenCalledWith(KEY, { token: 'test-token' })
  })

  it('rethrows the original error when head() cannot confirm the object (real failure)', async () => {
    const boom = new Error('service unavailable')
    asMock(put).mockRejectedValue(boom)
    asMock(head).mockRejectedValue(new Error('BlobNotFoundError'))
    await expect(uploadPrivatePhoto(KEY, Buffer.from([1]), 'image/jpeg')).rejects.toThrow('service unavailable')
  })

  it('throws a config error (no public fallback) when the private token is unset', async () => {
    delete process.env.RECEIPTS_BLOB_READ_WRITE_TOKEN
    await expect(uploadPrivatePhoto(KEY, Buffer.from([1]), 'image/jpeg')).rejects.toThrow(/RECEIPTS_BLOB_READ_WRITE_TOKEN/)
  })
})

describe('getPrivateBlob — namespace restriction', () => {
  it('refuses a pathname outside the receipt namespace (no fetch)', async () => {
    const { get } = await import('@vercel/blob')
    expect(await getPrivateBlob('other-store/secret.jpg')).toBeNull()
    expect(asMock(get)).not.toHaveBeenCalled()
  })
})
