import { describe, it, expect, vi, beforeEach } from 'vitest'

// Behavioral tests for the FAST-SAVE upload route (AI moved to the separate extract step). Deps are mocked;
// validateReceiptUpload + validateDecodedMeta stay REAL, decodeImageMeta (sharp) is mocked. Exercises: auth
// fail-closed, rate limit before work, evidence preservation (storage failure = failure), signature/decode
// rejection, capture_id RESUME (retry after lost response → same receipt), identical-bytes duplicate, and
// that NO AI runs in this route.
vi.mock('@/apps/expenses/authz', () => ({ receiptUploaderFromRequest: vi.fn() }))
vi.mock('@/platform/blob', () => ({ uploadPrivatePhoto: vi.fn(async () => 'business-receipts/abc.jpg') }))
vi.mock('@/apps/expenses/ai', () => ({ extractExpense: vi.fn() })) // must NOT be called by the save route
vi.mock('@/apps/expenses/db', () => ({
  createPendingReceipt: vi.fn(async () => ({ id: 'rec-1', duplicate: false })),
  findReceiptByCaptureId: vi.fn(async () => null),
  findActiveReceiptByHash: vi.fn(async () => null),
  storedPathnameForHash: vi.fn(async () => null),
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
  RATE_LIMITS: { upload: { limit: 60, windowMs: 600000 } },
}))
vi.mock('@/apps/expenses/image-decode', async () => {
  const actual = await vi.importActual<typeof import('@/apps/expenses/image-decode')>('@/apps/expenses/image-decode')
  return { ...actual, decodeImageMeta: vi.fn(async () => ({ format: 'jpeg', width: 800, height: 600 })) }
})

import { createHash } from 'node:crypto'
import { POST } from './route'
import { receiptUploaderFromRequest } from '@/apps/expenses/authz'
import { uploadPrivatePhoto } from '@/platform/blob'
import { extractExpense } from '@/apps/expenses/ai'
import * as db from '@/apps/expenses/db'
import { decodeImageMeta } from '@/apps/expenses/image-decode'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const HTML = Buffer.from('<!DOCTYPE html><script>1</script>')

function uploadReq(bytes: Buffer, { type = 'image/jpeg', captureId }: { type?: string; captureId?: string } = {}): Request {
  const fd = new FormData()
  fd.set('receipt', new File([new Uint8Array(bytes)], 'r.jpg', { type }))
  if (captureId) fd.set('captureId', captureId)
  return new Request('http://x/api/expenses/receipt', { method: 'POST', body: fd })
}

beforeEach(() => {
  vi.clearAllMocks()
  asMock(receiptUploaderFromRequest).mockResolvedValue({ actor: null, name: 'Shop device' })
  asMock(decodeImageMeta).mockResolvedValue({ format: 'jpeg', width: 800, height: 600 })
  asMock(db.findReceiptByCaptureId).mockResolvedValue(null)
  asMock(db.findActiveReceiptByHash).mockResolvedValue(null)
  asMock(db.storedPathnameForHash).mockResolvedValue(null)
  asMock(db.createPendingReceipt).mockResolvedValue({ id: 'rec-1', duplicate: false })
  asMock(db.consumeRateLimit).mockResolvedValue({ ok: true })
  asMock(uploadPrivatePhoto).mockResolvedValue('business-receipts/abc.jpg')
})

describe('fast-save upload route', () => {
  it('rejects anonymous (fail-closed) with 401 and no work', async () => {
    asMock(receiptUploaderFromRequest).mockResolvedValue(null)
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(401)
    expect(asMock(db.consumeRateLimit)).not.toHaveBeenCalled()
    expect(asMock(uploadPrivatePhoto)).not.toHaveBeenCalled()
    expect(asMock(db.createPendingReceipt)).not.toHaveBeenCalled()
  })

  it('rate-limited (429, Retry-After) BEFORE any Blob work', async () => {
    asMock(db.consumeRateLimit).mockResolvedValue({ ok: false, retryAfterSec: 42 })
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(asMock(uploadPrivatePhoto)).not.toHaveBeenCalled()
    expect(asMock(db.createPendingReceipt)).not.toHaveBeenCalled()
  })

  it('saves fast: stores privately, creates a PENDING row, returns id + token, runs NO AI, leaks no pathname', async () => {
    const res = await POST(uploadReq(JPEG, { captureId: 'cap-1' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.receiptId).toBe('rec-1')
    expect(typeof j.fileToken).toBe('string')
    expect(j.aiStatus).toBe('pending') // saved, not yet read
    expect(j.proposal).toBeNull()
    expect(asMock(extractExpense)).not.toHaveBeenCalled() // the read is a SEPARATE step
    expect(JSON.stringify(j)).not.toContain('business-receipts')
    const [args] = asMock(db.createPendingReceipt).mock.calls[0]
    expect(args.storageRef).toBe('business-receipts/abc.jpg')
    expect(args.captureId).toBe('cap-1')
    expect(args.uploadedBy).toBe('Shop device')
  })

  it('EVIDENCE: stores + hashes the ORIGINAL bytes byte-for-byte', async () => {
    const original = Buffer.concat([JPEG, Buffer.from('ORIGINAL-BYTES-EVIDENCE')])
    const res = await POST(uploadReq(original))
    expect(res.status).toBe(200)
    const storedBytes = asMock(uploadPrivatePhoto).mock.calls[0][1] as Buffer
    expect(Buffer.compare(storedBytes, original)).toBe(0)
    const [args] = asMock(db.createPendingReceipt).mock.calls[0]
    expect(args.imageHash).toBe(createHash('sha256').update(original).digest('hex'))
    expect(args.byteSize).toBe(original.length)
  })

  it('STORAGE FAILURE returns 502 and does NOT create a receipt (no phantom "saved")', async () => {
    asMock(uploadPrivatePhoto).mockRejectedValue(new Error('blob down'))
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(502)
    expect(asMock(db.createPendingReceipt)).not.toHaveBeenCalled()
    expect((await res.json()).ok).toBe(false)
  })

  it('rejects a non-image by signature (HTML) with 415', async () => {
    const res = await POST(uploadReq(HTML, { type: 'image/jpeg' }))
    expect(res.status).toBe(415)
    expect(asMock(uploadPrivatePhoto)).not.toHaveBeenCalled()
  })

  it('rejects a magic-valid but UNDECODABLE image with 415', async () => {
    asMock(decodeImageMeta).mockResolvedValue(null)
    const res = await POST(uploadReq(JPEG))
    expect(res.status).toBe(415)
    expect(asMock(uploadPrivatePhoto)).not.toHaveBeenCalled()
  })

  it('RESUME: a retry with the same captureId returns the SAME receipt (no second purchase), never re-stores', async () => {
    asMock(db.findReceiptByCaptureId).mockResolvedValue({ id: 'rec-1', uploadedByKey: null, aiStatus: 'extracted', vendor: 'V', receiptDate: '2026-09-14', totalCents: 500, category: 'other', confidence: { vendor: true } })
    const res = await POST(uploadReq(JPEG, { captureId: 'cap-1' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.receiptId).toBe('rec-1')
    expect(j.resumed).toBe(true)
    expect(j.proposal?.totalCents).toBe(500) // resumes with the already-read proposal
    expect(asMock(uploadPrivatePhoto)).not.toHaveBeenCalled() // never re-store on resume
    expect(asMock(db.createPendingReceipt)).not.toHaveBeenCalled()
  })

  it('IDENTICAL bytes from a DIFFERENT capture → already captured (no id/token handed out)', async () => {
    asMock(db.findActiveReceiptByHash).mockResolvedValue({ id: 'other-7', captureId: 'someone-else' })
    const res = await POST(uploadReq(JPEG, { captureId: 'mine' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.alreadyCaptured).toBe(true)
    expect(j.receiptId).toBeUndefined()
    expect(j.fileToken).toBeUndefined()
    expect(asMock(db.createPendingReceipt)).not.toHaveBeenCalled()
  })
})
