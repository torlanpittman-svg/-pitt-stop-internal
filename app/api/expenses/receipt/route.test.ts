import { describe, it, expect, vi, beforeEach } from 'vitest'

// Behavioral tests for the upload route with external deps mocked. validateReceiptUpload + validateDecodedMeta
// stay REAL; decodeImageMeta (sharp) is mocked. This exercises auth fail-closed, evidence-preservation
// (storage failure = failure, not success), signature/decode rejection, idempotent create + no metadata leak.
vi.mock('@/apps/expenses/authz', () => ({ receiptUploaderFromRequest: vi.fn() }))
vi.mock('@/platform/blob', () => ({ uploadPrivatePhoto: vi.fn(async () => 'business-receipts/abc.jpg') }))
vi.mock('@/apps/expenses/ai', () => ({ extractExpense: vi.fn(async () => ({ status: 'extracted', model: 'gpt-4o', raw: { content: 'x' }, extraction: { vendor: 'V', date: '2026-09-14', subtotalCents: null, taxCents: null, totalCents: 500, categoryLabel: null, categoryKey: 'other', paymentMethod: null, paymentLast4: null, receiptNumber: null, present: {} } })) }))
vi.mock('@/apps/expenses/db', () => ({ createReceipt: vi.fn(async () => ({ id: 'rec-1', duplicate: false })), storedPathnameForHash: vi.fn(async () => null) }))
vi.mock('@/apps/expenses/image-decode', async () => {
  const actual = await vi.importActual<typeof import('@/apps/expenses/image-decode')>('@/apps/expenses/image-decode')
  return { ...actual, decodeImageMeta: vi.fn(async () => ({ format: 'jpeg', width: 800, height: 600 })) }
})

import { POST } from './route'
import { receiptUploaderFromRequest } from '@/apps/expenses/authz'
import { uploadPrivatePhoto } from '@/platform/blob'
import * as db from '@/apps/expenses/db'
import { decodeImageMeta } from '@/apps/expenses/image-decode'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const HTML = Buffer.from('<!DOCTYPE html><script>1</script>')

function uploadReq(bytes: Buffer, type = 'image/jpeg'): Request {
  const fd = new FormData()
  fd.set('receipt', new File([new Uint8Array(bytes)], 'r.jpg', { type }))
  return new Request('http://x/api/expenses/receipt', { method: 'POST', body: fd })
}

beforeEach(() => {
  vi.clearAllMocks()
  asMock(receiptUploaderFromRequest).mockResolvedValue({ actor: null, name: 'Shop device' })
  asMock(decodeImageMeta).mockResolvedValue({ format: 'jpeg', width: 800, height: 600 })
  asMock(db.storedPathnameForHash).mockResolvedValue(null)
  asMock(db.createReceipt).mockResolvedValue({ id: 'rec-1', duplicate: false })
  asMock(uploadPrivatePhoto).mockResolvedValue('business-receipts/abc.jpg')
})

describe('upload route', () => {
  it('rejects anonymous (fail-closed) with 401 and no work', async () => {
    asMock(receiptUploaderFromRequest).mockResolvedValue(null)
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(401)
    expect(asMock(uploadPrivatePhoto)).not.toHaveBeenCalled()
    expect(asMock(db.createReceipt)).not.toHaveBeenCalled()
  })

  it('stores privately then creates the row; response exposes no Blob reference', async () => {
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.receiptId).toBe('rec-1')
    expect(JSON.stringify(j)).not.toContain('business-receipts') // never leak the pathname
    const [args] = asMock(db.createReceipt).mock.calls[0]
    expect(args.storage).toBe('blob_private')
    expect(args.uploadedBy).toBe('Shop device') // server-verified attribution
  })

  it('STORAGE FAILURE returns 502 and does NOT create a receipt (no phantom success)', async () => {
    asMock(uploadPrivatePhoto).mockRejectedValue(new Error('blob down'))
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(502)
    expect(asMock(db.createReceipt)).not.toHaveBeenCalled()
    const j = await res.json()
    expect(j.ok).toBe(false)
  })

  it('rejects a non-image by signature (HTML) with 415', async () => {
    const res = await POST(uploadReq(HTML, 'image/jpeg'))
    expect(res.status).toBe(415)
    expect(asMock(uploadPrivatePhoto)).not.toHaveBeenCalled()
  })

  it('rejects a magic-valid but UNDECODABLE image with 415', async () => {
    asMock(decodeImageMeta).mockResolvedValue(null) // sharp could not decode
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(415)
    expect(asMock(uploadPrivatePhoto)).not.toHaveBeenCalled()
  })

  it('a duplicate upload returns duplicate:true and discloses no other receipt metadata', async () => {
    asMock(db.createReceipt).mockResolvedValue({ id: 'existing-9', duplicate: true })
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.duplicate).toBe(true)
    expect(j.receiptId).toBeUndefined() // do not hand back another receipt's id
  })
})
