import { beforeEach, describe, expect, it, vi } from 'vitest'

const c = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn() }))
vi.mock('./connection', () => ({ getValidAccessToken: c.token }))
vi.mock('@/platform/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import { qbUploadAttachment } from './client'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const base = { metadata: { FileName: 'x.jpg' }, content: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]), contentType: 'image/jpeg', filename: 'x.jpg' }

beforeEach(() => {
  c.token.mockReset().mockResolvedValue({ accessToken: 'tok', realmId: '123', environment: 'production' })
  c.fetch.mockReset()
  vi.stubGlobal('fetch', c.fetch)
})

describe('qbUploadAttachment', () => {
  it('posts multipart/form-data with JSON metadata + raw binary content to /upload with the requestid', async () => {
    c.fetch.mockResolvedValue(ok({ AttachableResponse: [{ Attachable: { Id: '1' } }] }))
    const res = await qbUploadAttachment({ ...base, query: { requestid: 'a-1' } })
    expect(res).toEqual({ AttachableResponse: [{ Attachable: { Id: '1' } }] })

    const [url, init] = c.fetch.mock.calls[0]
    expect(String(url)).toContain('/v3/company/123/upload')
    expect(String(url)).toContain('requestid=a-1')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok')
    // fetch must set the multipart Content-Type (with boundary) itself — we never force one.
    expect(init.headers['Content-Type']).toBeUndefined()

    const form = init.body as FormData
    const metaPart = form.get('file_metadata_0') as Blob
    expect(metaPart.type).toBe('application/json')
    expect(JSON.parse(await metaPart.text())).toEqual({ FileName: 'x.jpg' })

    const filePart = form.get('file_content_0') as File
    expect(filePart.name).toBe('x.jpg')
    expect(filePart.type).toBe('image/jpeg')
    expect(Buffer.from(await filePart.arrayBuffer()).equals(base.content)).toBe(true)
  })

  it('refreshes the token and retries once on a 401', async () => {
    c.fetch.mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(ok({ AttachableResponse: [{ Attachable: { Id: '1' } }] }))
    await qbUploadAttachment(base)
    expect(c.fetch).toHaveBeenCalledTimes(2)
  })

  it('returns an HTTP 200 body unchanged so the caller can detect a QBO Fault', async () => {
    const fault = { AttachableResponse: [{ Fault: { Error: [{ Message: 'bad file' }] } }] }
    c.fetch.mockResolvedValue(ok(fault))
    await expect(qbUploadAttachment(base)).resolves.toEqual(fault)
  })

  it('throws on a non-2xx response', async () => {
    c.fetch.mockResolvedValue(new Response('nope', { status: 400 }))
    await expect(qbUploadAttachment(base)).rejects.toThrow(/\/upload failed \(400\)/)
  })
})
