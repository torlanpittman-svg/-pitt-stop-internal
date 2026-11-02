/**
 * The encryption is verified against the OFFICIAL RFC 8291 §5 / Appendix A test vector, not only
 * against itself: with the RFC's sender key and salt injected, our output must be byte-identical to
 * the body published in the RFC. That is what makes it safe to ship a hand-written Web Push
 * implementation instead of a third-party library.
 */
import { describe, expect, it, vi } from 'vitest'
import { createECDH } from 'node:crypto'
import {
  CURVE, MAX_ENDPOINT_LENGTH, MAX_PAYLOAD_BYTES, audienceOf, encryptPayload, generateVapidKeys,
  isAllowedPushEndpoint, looksLikeVapidKeys, parsePushEndpoint, pushConfig, sendPush,
  vapidAuthorization, vapidKeysMatch,
} from './web-push'

// RFC 8291, Section 5 "Push Message Encryption Example".
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

const senderEcdh = () => {
  const e = createECDH(CURVE)
  e.setPrivateKey(Buffer.from(RFC.asPrivate, 'base64url'))
  return e
}

describe('aes128gcm payload encryption (RFC 8291)', () => {
  it("reproduces the RFC's published ciphertext byte for byte", () => {
    const out = encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.authSecret }, {
      ephemeral: senderEcdh(), salt: Buffer.from(RFC.salt, 'base64url'),
    })
    expect(out.toString('base64url')).toBe(RFC.body)
  })

  it("derives the RFC's sender public key from its private key", () => {
    expect(senderEcdh().getPublicKey().toString('base64url')).toBe(RFC.asPublic)
  })

  it('uses a fresh salt and ephemeral key for every message', () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.authSecret }
    const a = encryptPayload('hello', keys)
    const b = encryptPayload('hello', keys)
    expect(a.equals(b)).toBe(false)
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false) // different salt
  })

  it('lays out the aes128gcm header the way RFC 8188 specifies', () => {
    const out = encryptPayload('x', { p256dh: RFC.uaPublic, auth: RFC.authSecret })
    expect(out.readUInt32BE(16)).toBe(4096) // record size
    expect(out.readUInt8(20)).toBe(65)      // key id length
    expect(out.readUInt8(21)).toBe(0x04)    // uncompressed point
    expect(out.length).toBe(16 + 5 + 65 + 1 + 1 + 16) // salt + header + key + "x" + delimiter + tag
  })

  it('refuses malformed subscription keys instead of sending garbage', () => {
    expect(() => encryptPayload('x', { p256dh: 'AAAA', auth: RFC.authSecret })).toThrow(/p256dh/)
    expect(() => encryptPayload('x', { p256dh: RFC.uaPublic, auth: 'AAAA' })).toThrow(/auth secret/)
  })

  it('refuses a payload that cannot fit one record', () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.authSecret }
    expect(() => encryptPayload('a'.repeat(MAX_PAYLOAD_BYTES + 1), keys)).toThrow(/too large/)
    expect(() => encryptPayload('a'.repeat(MAX_PAYLOAD_BYTES), keys)).not.toThrow()
  })
})

describe('VAPID (RFC 8292)', () => {
  const keys = generateVapidKeys()

  it('generates a matched, well-formed keypair', () => {
    expect(looksLikeVapidKeys(keys)).toBe(true)
    expect(vapidKeysMatch(keys)).toBe(true)
    expect(vapidKeysMatch({ ...keys, privateKey: generateVapidKeys().privateKey })).toBe(false)
  })

  it('signs an ES256 JWT scoped to the push service origin', () => {
    const header = vapidAuthorization({
      endpoint: 'https://web.push.apple.com/abc/def?x=1', subject: 'mailto:shop@example.com', keys,
      now: new Date('2026-11-02T12:00:00Z'),
    })
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=(.+)$/.exec(header)
    expect(m).not.toBeNull()
    const [, h, p, sig, k] = m!
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      aud: 'https://web.push.apple.com', // origin only — never the full endpoint
      exp: Math.floor(Date.UTC(2026, 10, 2, 12) / 1000) + 12 * 3600,
      sub: 'mailto:shop@example.com',
    })
    expect(Buffer.from(sig, 'base64url').length).toBe(64) // raw r||s, not DER
    expect(k).toBe(keys.publicKey)
  })

  it('reads the audience from the endpoint origin', () => {
    expect(audienceOf('https://fcm.googleapis.com/fcm/send/abc')).toBe('https://fcm.googleapis.com')
  })
})

describe('which URLs the server will POST to (SSRF surface)', () => {
  it('accepts the four real push services, including their per-provider subdomain shapes', () => {
    for (const endpoint of [
      'https://web.push.apple.com/QBxc8HnBoaQfRBNUsqBKNxLnCdGJC6dPSgTkZNuLGWGnGNNRrkAEjgQ',
      'https://push.apple.com/abc',
      'https://fcm.googleapis.com/fcm/send/abc:APA91b',
      'https://fcm.googleapis.com/wp/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://push.services.mozilla.com/wpush/v2/abc',
      'https://db5p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com:443/explicit-default-port',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true)
    }
  })

  it('refuses anything that is not a known push service — no arbitrary DNS name', () => {
    for (const endpoint of [
      'https://push.example.com/abc',          // somebody else's server
      'https://localhost/abc',
      'https://127.0.0.1/abc',
      'https://[::1]/abc',
      'https://169.254.169.254/latest/meta-data/',  // cloud metadata
      'https://10.0.0.5/abc',
      'https://push.local/abc',
      'https://push.internal/abc',
      'http://web.push.apple.com/abc',          // not https
      'ftp://web.push.apple.com/abc',
      'web.push.apple.com/abc',                 // not a URL
      '',
      '   ',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false)
    }
  })

  it('refuses hosts that merely LOOK like a push service (suffix spoofing)', () => {
    for (const endpoint of [
      'https://evilpush.apple.com/abc',                  // endsWith('push.apple.com') but not a subdomain
      'https://web.push.apple.com.evil.example/abc',     // allowed host as a prefix
      'https://notfcm.googleapis.com/abc',
      'https://fcm.googleapis.com.evil.example/abc',
      'https://evil.example/web.push.apple.com',         // allowed host only in the path
      'https://sub.fcm.googleapis.com/abc',              // Google is exact-host only
      'https://web.push.apple.com./abc',                 // trailing-dot FQDN form
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false)
    }
  })

  it('refuses userinfo, a non-default port and a fragment', () => {
    // The userinfo trick: everything before the LAST @ is credentials, so the real host is evil.example.
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com@evil.example/abc')).toBe(false)
    expect(isAllowedPushEndpoint('https://user:pw@fcm.googleapis.com/abc')).toBe(false)
    expect(isAllowedPushEndpoint('https://web.push.apple.com:8443/abc')).toBe(false)
    expect(isAllowedPushEndpoint('https://web.push.apple.com:22/abc')).toBe(false)
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc#fragment')).toBe(false)
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc#')).toBe(false)
  })

  it('refuses an absurdly long endpoint and non-strings', () => {
    expect(isAllowedPushEndpoint(`https://web.push.apple.com/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`)).toBe(false)
    expect(isAllowedPushEndpoint(null)).toBe(false)
    expect(isAllowedPushEndpoint(undefined)).toBe(false)
    expect(isAllowedPushEndpoint({ endpoint: 'https://web.push.apple.com/abc' })).toBe(false)
  })

  it('returns the parsed URL for an allowed endpoint, so callers need not re-parse', () => {
    expect(parsePushEndpoint(' https://web.push.apple.com/abc ')?.hostname).toBe('web.push.apple.com')
    expect(parsePushEndpoint('https://evil.example/abc')).toBeNull()
  })
})

describe('pushConfig', () => {
  const keys = generateVapidKeys()
  const good = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:shop@example.com' } as unknown as NodeJS.ProcessEnv

  it('is configured only when both keys and a contact subject are present and well-formed', () => {
    expect(pushConfig(good)).toEqual({ vapid: keys, subject: 'mailto:shop@example.com' })
    expect(pushConfig({ ...good, VAPID_PRIVATE_KEY: '' })).toBeNull()
    expect(pushConfig({ ...good, VAPID_PUBLIC_KEY: 'nope' })).toBeNull()
    expect(pushConfig({ ...good, VAPID_SUBJECT: 'Pitt Stop' })).toBeNull()
    expect(pushConfig({} as unknown as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('sendPush outcome mapping', () => {
  const keys = generateVapidKeys()
  const base = {
    endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret },
    payload: '{"t":"x"}', vapid: keys, subject: 'mailto:shop@example.com',
  }
  const reply = (status: number, body = '') => vi.fn(async () => new Response(body, { status }))

  it('posts an encrypted aes128gcm body with the VAPID header, and never follows a redirect', async () => {
    const fetchImpl = reply(201)
    const out = await sendPush({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, topic: 'appt-1' })
    expect(out).toEqual({ status: 'sent', httpStatus: 201 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(base.endpoint)
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.Authorization.startsWith('vapid t=')).toBe(true)
    expect(headers.Topic).toBe('appt-1')
    expect((init.body as Uint8Array).byteLength).toBeGreaterThan(80)
    // Without this, a 302 from a push service could walk the request onto an internal address.
    expect(init.redirect).toBe('error')
  })

  it.each([[301], [302], [307]])('treats a %i redirect as a permanent fault, never a hop to follow', async (status) => {
    const out = await sendPush({ ...base, fetchImpl: reply(status) as unknown as typeof fetch })
    expect(out.status).toBe('failed')
  })

  it('refuses to send to a host that is not a known push service, without any request', async () => {
    const fetchImpl = reply(201)
    for (const endpoint of [
      'https://evil.example/abc',
      'https://169.254.169.254/latest/meta-data/',
      'https://web.push.apple.com.evil.example/abc',
      'http://web.push.apple.com/abc',
    ]) {
      const out = await sendPush({ ...base, endpoint, fetchImpl: fetchImpl as unknown as typeof fetch })
      // 'failed', not 'retry': such an endpoint will never become sendable, so it must not be requeued.
      expect(out, endpoint).toEqual({ status: 'failed', httpStatus: null, error: 'Endpoint is not a recognised push service.' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([[404], [410]])('treats %i as a dead subscription (never retried)', async (status) => {
    const out = await sendPush({ ...base, fetchImpl: reply(status) as unknown as typeof fetch })
    expect(out.status).toBe('expired')
  })

  it.each([[408], [429], [500], [503]])('treats %i as temporary', async (status) => {
    const out = await sendPush({ ...base, fetchImpl: reply(status) as unknown as typeof fetch })
    expect(out.status).toBe('retry')
  })

  it.each([[400], [401], [403], [413]])('treats %i as a permanent fault', async (status) => {
    const out = await sendPush({ ...base, fetchImpl: reply(status) as unknown as typeof fetch })
    expect(out.status).toBe('failed')
  })

  it('treats a network failure as temporary', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('socket hang up') })
    const out = await sendPush({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(out).toMatchObject({ status: 'retry', httpStatus: null })
  })

  it('fails without calling the push service when the subscription keys are unusable', async () => {
    const fetchImpl = reply(201)
    const out = await sendPush({ ...base, keys: { p256dh: 'bad', auth: 'bad' }, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(out.status).toBe('failed')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
