import { describe, expect, it } from 'vitest'
import { AllowlistEmailProvider, transactionalEmailProvider, brandedHtml, type TransactionalEmailProvider } from './notify'

describe('email provider selection + test safety', () => {
  it('no provider env → not configured (nothing can be sent)', () => {
    expect(transactionalEmailProvider({} as NodeJS.ProcessEnv).live).toBe(false)
  })
  it('test allowlist: only listed addresses / domains reach the provider', async () => {
    const seen: string[] = []
    const inner: TransactionalEmailProvider = { name: 'fake', live: true, async send(m) { seen.push(m.to); return { status: 'sent', providerMessageId: 'x' } } }
    const p = new AllowlistEmailProvider(inner, ['owner@example.com', '@pittstop.test'])
    expect((await p.send({ to: 'Owner@Example.com', subject: 's', text: 't' })).status).toBe('sent')
    expect((await p.send({ to: 'a@pittstop.test', subject: 's', text: 't' })).status).toBe('sent')
    expect(await p.send({ to: 'real.customer@gmail.com', subject: 's', text: 't' })).toMatchObject({ status: 'blocked' })
    expect(seen).toEqual(['Owner@Example.com', 'a@pittstop.test'])
  })
  it('env allowlist wraps the configured provider', () => {
    const p = transactionalEmailProvider({ APPOINTMENT_EMAIL_PROVIDER: 'postmark', POSTMARK_SERVER_TOKEN: 't', APPOINTMENT_EMAIL_FROM: 'a@b.c', APPOINTMENT_EMAIL_ALLOWLIST: 'me@x.com' } as unknown as NodeJS.ProcessEnv)
    expect(p).toBeInstanceOf(AllowlistEmailProvider)
  })
  it('branded HTML escapes customer-entered text', () => {
    const html = brandedHtml({ preheader: 'p', heading: 'h', intro: '<img src=x onerror=alert(1)>', cfg: { phone: '(979) 696-6640', address: '3112 Texas Ave S' } })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })
})

// ── Postmark result classification: definite rejection vs uncertain delivery ──
import { PostmarkEmailProvider } from './notify'

const MSG = { to: 'a@example.com', subject: 's', text: 't' }
const pm = (answer: () => Response | Promise<Response>) => {
  let calls = 0
  const p = new PostmarkEmailProvider('tok', 'shop@example.com', (async () => { calls++; return answer() }) as typeof fetch)
  return { p, calls: () => calls }
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const netErr = (code?: string, name = 'TypeError') => () => {
  const e = new Error('fetch failed', code ? { cause: Object.assign(new Error(code), { code }) } : undefined)
  e.name = name
  throw e
}

describe('Postmark: only a readable acceptance is "sent"; anything that might have been accepted is "uncertain"', () => {
  it('readable acceptance → sent', async () => {
    expect(await pm(json(200, { ErrorCode: 0, MessageID: 'pm-1' })).p.send(MSG)).toEqual({ status: 'sent', providerMessageId: 'pm-1' })
  })

  it('connection lost after the request went out (no cause / socket reset / timeout) → uncertain', async () => {
    for (const fail of [netErr(), netErr('UND_ERR_SOCKET'), netErr('ECONNRESET'), netErr('UND_ERR_HEADERS_TIMEOUT'), netErr(undefined, 'TimeoutError'), netErr(undefined, 'AbortError')]) {
      expect((await pm(fail).p.send(MSG)).status).toBe('uncertain')
    }
  })

  it('HTTP 200 with an unreadable or incomplete body → uncertain (Postmark answered 200: it may have accepted it)', async () => {
    expect((await pm(() => new Response('<html>proxy</html>', { status: 200 })).p.send(MSG)).status).toBe('uncertain')
    expect((await pm(json(200, { ErrorCode: 0 })).p.send(MSG)).status).toBe('uncertain')
    expect((await pm(json(200, { ErrorCode: 406, Message: '?' })).p.send(MSG)).status).toBe('uncertain')
  })

  it('a server error that is not "unavailable" → uncertain', async () => {
    expect((await pm(json(500, { ErrorCode: 500, Message: 'Internal' })).p.send(MSG)).status).toBe('uncertain')
  })

  it('definite rejections → failed; permanent ones are not retried automatically', async () => {
    expect(await pm(json(422, { ErrorCode: 406, Message: 'Inactive recipient' })).p.send(MSG)).toMatchObject({ status: 'failed', retryable: false })
    expect(await pm(() => new Response('nope', { status: 422 })).p.send(MSG)).toMatchObject({ status: 'failed', retryable: false })
    expect(await pm(json(401, { ErrorCode: 10, Message: 'Bad token' })).p.send(MSG)).toMatchObject({ status: 'failed', retryable: false })
  })

  it('definitely not accepted but temporary → failed, retryable', async () => {
    expect(await pm(json(429, { ErrorCode: 429, Message: 'Rate limit' })).p.send(MSG)).toMatchObject({ status: 'failed', retryable: true })
    expect(await pm(json(503, {})).p.send(MSG)).toMatchObject({ status: 'failed', retryable: true })
    // The connection never opened: the request cannot have reached Postmark.
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(await pm(netErr(code)).p.send(MSG)).toMatchObject({ status: 'failed', retryable: true })
    }
  })
})
