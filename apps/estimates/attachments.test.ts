import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createHash } from 'node:crypto'

const q = vi.hoisted(() => ({ read: vi.fn(), api: vi.fn(), upload: vi.fn(), query: vi.fn() }))
vi.mock('@/apps/order-photos/storage', () => ({ readPhotoBytes: q.read }))
vi.mock('@/apps/quickbooks/client', () => ({ qbApiRequest: q.api, qbUploadAttachment: q.upload, queryQBO: q.query, qboEscape: (s: string) => s }))

import {
  prepareEstimateAttachments, reconcileEstimateAttachments, verifyEstimateAttachments, parseAttachmentMarker,
  attachmentSentIdentity, assertAttachmentCaps, MAX_ATTACHMENT_BYTES,
} from './attachments'
import type { PreparedAttachment } from './attachments'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const makeJpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer()
const makePng = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer()
const makeWebp = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 5, g: 90, b: 150 } } }).webp().toBuffer()
const meta = (id: string, bytes: Buffer, contentType: string, caption = '') =>
  ({ id, imageHash: sha(bytes), filename: `${id}.src`, contentType, byteSize: bytes.length, caption, storagePath: `order-photos/o/${id}` })

beforeEach(() => { q.read.mockReset(); q.api.mockReset().mockResolvedValue({}); q.upload.mockReset(); q.query.mockReset() })

describe('prepareEstimateAttachments — deterministic email copies', () => {
  it('converts a WebP photo to a JPEG email copy (mime + extension) and leaves the original bytes untouched', async () => {
    const src = await makeWebp(1200, 900)
    const before = Buffer.from(src)
    q.read.mockResolvedValue(src)
    const [p] = await prepareEstimateAttachments('order', [meta('p1', src, 'image/webp')])
    expect(p.contentType).toBe('image/jpeg')
    expect(p.filename).toBe('pittstop-estimate-p1.jpg')
    expect((await sharp(p.bytes).metadata()).format).toBe('jpeg')
    expect(src.equals(before)).toBe(true)
  })

  it('downscales a large JPEG inside 2000px without enlarging smaller sources', async () => {
    const big = await makeJpeg(3000, 2000)
    q.read.mockResolvedValue(big)
    const [p] = await prepareEstimateAttachments('order', [meta('big', big, 'image/jpeg')])
    const m = await sharp(p.bytes).metadata()
    expect(Math.max(m.width!, m.height!)).toBeLessThanOrEqual(2000)
    expect(p.byteSize).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES)
  })

  it('keeps a small PNG parts-quote page byte-for-byte and readable', async () => {
    const page = await makePng(700, 950)
    q.read.mockResolvedValue(page)
    const [p] = await prepareEstimateAttachments('order', [meta('quote', page, 'image/png')])
    expect(p.contentType).toBe('image/png')
    expect(p.filename).toBe('pittstop-estimate-quote.png')
    expect(p.bytes.equals(page)).toBe(true)
  })

  it('preserves selection order and binds a deterministic marker (order/photo/src/prep) with the caption', async () => {
    const a = await makeJpeg(100, 100); const b = await makePng(120, 120)
    q.read.mockImplementation(async (path: string) => (path.endsWith('a') ? a : b))
    const prepared = await prepareEstimateAttachments('order', [meta('a', a, 'image/jpeg', 'Front bumper [left]'), meta('b', b, 'image/png')])
    expect(prepared.map(p => p.photoId)).toEqual(['a', 'b'])
    const marker = parseAttachmentMarker(prepared[0].note)!
    expect(marker).toMatchObject({ version: 'v1', orderId: 'order', photoId: 'a', src: sha(a), prep: prepared[0].preparedHash })
    // Caption rides along after the marker with brackets stripped (marker stays parseable).
    expect(prepared[0].note).toContain('Front bumper left')
    expect(parseAttachmentMarker(prepared[0].note)!.prep).toBe(prepared[0].preparedHash)
  })

  it('fails closed on a missing, corrupt (hash mismatch) or unsupported photo BEFORE anything is prepared for email', async () => {
    const good = await makeJpeg(50, 50)
    q.read.mockResolvedValueOnce(null)
    await expect(prepareEstimateAttachments('order', [meta('gone', good, 'image/jpeg')])).rejects.toThrow(/could not be read/)
    q.read.mockResolvedValueOnce(good)
    await expect(prepareEstimateAttachments('order', [{ ...meta('tamper', good, 'image/jpeg'), imageHash: 'f'.repeat(64) }])).rejects.toThrow(/integrity check/)
    q.read.mockResolvedValueOnce(good)
    await expect(prepareEstimateAttachments('order', [meta('wrong', good, 'image/png')])).rejects.toThrow(/not a supported image/)
  })

  it('rejects a corrupt PNG via a full decode even when its bytes hash correctly (original never emailed)', async () => {
    const good = await makePng(300, 300)
    const corrupt = Buffer.from(good.subarray(0, Math.floor(good.length / 2))) // header intact, pixel data truncated
    q.read.mockResolvedValue(corrupt)
    await expect(prepareEstimateAttachments('order', [meta('bad', corrupt, 'image/png')])).rejects.toThrow(/could not be prepared/)
  })

  it('attachmentSentIdentity is stable for the same prepared set and changes when the set changes', async () => {
    const a = await makeJpeg(80, 80)
    q.read.mockResolvedValue(a)
    const one = await prepareEstimateAttachments('order', [meta('a', a, 'image/jpeg')])
    const again = await prepareEstimateAttachments('order', [meta('a', a, 'image/jpeg')])
    expect(attachmentSentIdentity(one)).toBe(attachmentSentIdentity(again))
    const two = await prepareEstimateAttachments('order', [meta('a', a, 'image/jpeg'), meta('b', a, 'image/jpeg')])
    expect(attachmentSentIdentity(two)).not.toBe(attachmentSentIdentity(one))
  })
})

describe('assertAttachmentCaps', () => {
  it('rejects an oversized individual file and an oversized total with actionable errors', () => {
    expect(() => assertAttachmentCaps([{ byteSize: MAX_ATTACHMENT_BYTES + 1, filename: 'big.jpg' }])).toThrow(/too large to attach/)
    expect(() => assertAttachmentCaps(Array.from({ length: 7 }, (_, i) => ({ byteSize: 3 * 1024 * 1024, filename: `p${i}.jpg` })))).toThrow(/too large to email together/)
  })
})

// ── Reconcile / verify (QuickBooks interaction is mocked) ────────────────────────────────────────────
const H = (s: string) => createHash('sha256').update(s).digest('hex')
function prep(id: string): PreparedAttachment {
  const bytes = Buffer.from(`prepared-${id}`)
  const sourceHash = H('src' + id), preparedHash = H('prep' + id)
  return { photoId: id, sourceHash, preparedHash, filename: `pittstop-estimate-${id}.jpg`, contentType: 'image/jpeg', bytes, byteSize: bytes.length,
    note: `[PSATT v1 order=order photo=${id} src=${sourceHash} prep=${preparedHash}]` }
}
type AttOpts = { id?: string; include?: boolean; size?: number; filename?: string; contentType?: string; note?: string; sync?: string }
function att(p: PreparedAttachment, o: AttOpts = {}) {
  return { Id: o.id ?? `A-${p.photoId}`, SyncToken: o.sync ?? '0', FileName: o.filename ?? p.filename, ContentType: o.contentType ?? p.contentType,
    Size: o.size ?? p.byteSize, Note: o.note ?? p.note, AttachableRef: [{ EntityRef: { type: 'Estimate', value: 'E1' }, IncludeOnSend: o.include ?? true }] }
}
const run = (prepared: PreparedAttachment[]) => reconcileEstimateAttachments({ orderId: 'order', qbEstimateId: 'E1', prepared })

// Attachable list queries and attachable writes both flow through qbApiRequest (bounded, not the untimed
// queryQBO). This routes `/query` reads from a per-call queue and lets `/attachable` writes be inspected.
type QbAtt = ReturnType<typeof att>
function queueQueries(...pages: QbAtt[][]) {
  const queue = [...pages]
  q.api.mockReset().mockImplementation(async (opts: { path: string }) => {
    if (opts.path === '/query') return { QueryResponse: { Attachable: queue.length > 1 ? queue.shift()! : (queue[0] ?? []) } }
    return {}
  })
}
const writes = () => q.api.mock.calls.map(c => c[0]).filter((o): o is { path: string; query: { requestid: string }; body: { Id?: string; AttachableRef: { IncludeOnSend?: boolean }[] } } => o.path === '/attachable')

describe('reconcileEstimateAttachments', () => {
  it('uploads a missing file to THIS estimate (metadata + raw bytes + IncludeOnSend) then verifies it', async () => {
    const p = prep('p1')
    queueQueries([], [att(p)])
    q.upload.mockResolvedValue({ AttachableResponse: [{ Attachable: { Id: 'A-p1' } }] })
    await run([p])
    expect(q.upload).toHaveBeenCalledOnce()
    const up = q.upload.mock.calls[0][0]
    expect(up.metadata.AttachableRef[0]).toMatchObject({ EntityRef: { type: 'Estimate', value: 'E1' }, IncludeOnSend: true })
    expect(up.metadata.FileName).toBe(p.filename)
    expect(up.content).toBe(p.bytes)
    expect(up.contentType).toBe('image/jpeg')
    expect(String(up.query.requestid)).toMatch(/^a-/)
  })

  it('adopts an already-present matching attachment without re-uploading or rewriting it', async () => {
    const p = prep('p1')
    queueQueries([att(p)])
    await run([p])
    expect(q.upload).not.toHaveBeenCalled()
    expect(writes()).toHaveLength(0)
  })

  it('does not re-upload after a timed-out upload: the retry reconciles to the now-present record', async () => {
    const p = prep('p1')
    queueQueries([])
    q.upload.mockRejectedValueOnce(new Error('timeout'))
    await expect(run([p])).rejects.toThrow('timeout')
    queueQueries([att(p)])
    await run([p])
    expect(q.upload).toHaveBeenCalledTimes(1)
  })

  it('treats an HTTP 200 Fault upload body as a failure (nothing emailed)', async () => {
    const p = prep('p1')
    queueQueries([])
    q.upload.mockResolvedValue({ AttachableResponse: [{ Fault: { Error: [{ Message: 'bad' }] } }] })
    await expect(run([p])).rejects.toThrow(/did not accept/)
  })

  it('treats a malformed or faulted LIST query as a hard failure — never as "no matches" (no duplicate reupload)', async () => {
    q.api.mockReset().mockResolvedValueOnce({ Fault: { Error: [{ Message: 'boom' }] } })
    q.upload.mockReset()
    await expect(run([prep('p1')])).rejects.toThrow(/could not list/)
    expect(q.upload).not.toHaveBeenCalled()
    q.api.mockReset().mockResolvedValueOnce({}) // no QueryResponse object at all
    await expect(run([prep('p1')])).rejects.toThrow(/could not list/)
    expect(q.upload).not.toHaveBeenCalled()
  })

  it('blocks a managed attachment whose metadata/size does not match the current quote', async () => {
    const p = prep('p1')
    queueQueries([att(p, { size: 999 })])
    await expect(run([p])).rejects.toThrow(/does not match/)
    expect(q.upload).not.toHaveBeenCalled()
  })

  it('repairs IncludeOnSend=false on a managed file before sending', async () => {
    const p = prep('p1')
    queueQueries([att(p, { include: false })], [att(p, { include: true })])
    await run([p])
    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].body.AttachableRef[0].IncludeOnSend).toBe(true)
  })

  it('uses a version-bound toggle request id, so repeated off→on→off toggles never replay a stale result', async () => {
    const p = prep('p1')
    const ids: string[] = []
    queueQueries([att(p, { include: true, sync: '0' })], [att(p, { include: false, sync: '1' })])
    await run([]); ids.push(writes()[0].query.requestid)                              // off, version 0
    queueQueries([att(p, { include: false, sync: '1' })], [att(p, { include: true, sync: '2' })])
    await run([p]); ids.push(writes()[0].query.requestid)                             // on, version 1
    queueQueries([att(p, { include: true, sync: '2' })], [att(p, { include: false, sync: '3' })])
    await run([]); ids.push(writes()[0].query.requestid)                              // off again, version 2
    expect(new Set(ids).size).toBe(3)
  })

  it('disables a deselected managed file and never touches an unrelated manual attachment', async () => {
    const p = prep('p1')
    const manual = { Id: 'M', SyncToken: '0', FileName: 'customer-receipt.pdf', ContentType: 'application/pdf', Size: 10,
      Note: 'added by customer', AttachableRef: [{ EntityRef: { type: 'Estimate', value: 'E1' }, IncludeOnSend: true }] }
    queueQueries([att(p, { include: true }), manual], [att(p, { include: false }), manual])
    await run([])
    const disable = writes().find(w => w.body.Id === 'A-p1')!
    expect(disable.body.AttachableRef[0].IncludeOnSend).toBe(false)
    expect(writes().every(w => w.body.Id !== 'M')).toBe(true)
  })

  it('blocks rather than guesses when it cannot dedup (two managed records for one photo)', async () => {
    const p = prep('p1')
    queueQueries([att(p, { id: 'A1' }), att(p, { id: 'A2' })])
    await expect(run([p])).rejects.toThrow(/ambiguous/)
  })
})

describe('verifyEstimateAttachments', () => {
  it('fails closed when a selected file is not verifiably attached with IncludeOnSend', async () => {
    const p = prep('p1')
    queueQueries([])
    await expect(verifyEstimateAttachments({ orderId: 'order', qbEstimateId: 'E1', prepared: [p] })).rejects.toThrow(/could not be verified/)
    queueQueries([att(p, { include: false })])
    await expect(verifyEstimateAttachments({ orderId: 'order', qbEstimateId: 'E1', prepared: [p] })).rejects.toThrow(/not marked to send/)
  })
})
