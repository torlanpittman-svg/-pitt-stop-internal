import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { TwilioSmsProvider, validateTwilioSignature, toE164, twilioConfigFromEnv } from './providers/twilio'

const CFG = { accountSid: 'ACxxxx', authToken: 'tok-secret', messagingServiceSid: 'MGxxxx' }

function fakeFetch(response: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = []
  const fn = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, init })
    return { ok: response.ok, status: response.status, json: async () => response.body }
  }) as unknown as ConstructorParameters<typeof TwilioSmsProvider>[1]
  return { fn, calls }
}

describe('toE164', () => {
  it('normalizes US numbers and rejects invalid ones', () => {
    expect(toE164('(512) 555-0123')).toBe('+15125550123')
    expect(toE164('15125550123')).toBe('+15125550123')
    expect(toE164('555-0123')).toBeNull()
    expect(toE164('')).toBeNull()
  })
})

describe('TwilioSmsProvider.send', () => {
  it('posts to the Messaging Service and returns the provider message id', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 201, body: { sid: 'SM123' } })
    const res = await new TwilioSmsProvider(CFG, fn).send('5125550123', 'Pitt Stop Detail: hello. Reply STOP to opt out.')
    expect(res.status).toBe('sent')
    expect(res.providerMessageId).toBe('SM123')
    expect(calls[0].url).toContain('/Accounts/ACxxxx/Messages.json')
    expect(calls[0].init.body).toContain('MessagingServiceSid=MGxxxx')
    expect(calls[0].init.body).toContain('To=%2B15125550123')
    expect(calls[0].init.headers.Authorization).toMatch(/^Basic /)
  })
  it('reports a provider failure without throwing', async () => {
    const { fn } = fakeFetch({ ok: false, status: 400, body: { message: 'Invalid number', code: 21211 } })
    const res = await new TwilioSmsProvider(CFG, fn).send('5125550123', 'hi')
    expect(res.status).toBe('failed')
    expect(res.error).toContain('Invalid number')
  })
  it('rejects an invalid phone before calling Twilio', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 201, body: { sid: 'x' } })
    const res = await new TwilioSmsProvider(CFG, fn).send('123', 'hi')
    expect(res.status).toBe('failed')
    expect(res.error).toBe('invalid_phone')
    expect(calls).toHaveLength(0)
  })
  it('is live only when configured', () => {
    expect(new TwilioSmsProvider(CFG).live).toBe(true)
    expect(twilioConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull()
    expect(twilioConfigFromEnv({ TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_MESSAGING_SERVICE_SID: 'c' } as unknown as NodeJS.ProcessEnv)).not.toBeNull()
  })
})

describe('validateTwilioSignature', () => {
  const url = 'https://shop.example.com/api/twilio/sms/inbound'
  const params = { From: '+15125550123', Body: 'STOP', MessageSid: 'SM1' }
  function sign(token: string) {
    let data = url
    for (const k of Object.keys(params).sort()) data += k + (params as Record<string, string>)[k]
    return createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64')
  }
  it('accepts a correct signature', () => {
    expect(validateTwilioSignature('tok', url, params, sign('tok'))).toBe(true)
  })
  it('rejects a wrong/absent signature or wrong token', () => {
    expect(validateTwilioSignature('tok', url, params, sign('other'))).toBe(false)
    expect(validateTwilioSignature('tok', url, params, null)).toBe(false)
    expect(validateTwilioSignature('tok', url, { ...params, Body: 'START' }, sign('tok'))).toBe(false) // tampered param
  })
})
