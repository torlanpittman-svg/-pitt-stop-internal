/**
 * Web Push transport — standard VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291),
 * implemented on node:crypto alone.
 *
 * WHY NO LIBRARY / NO SERVICE: Web Push talks directly to the browser vendor's own push service
 * (Apple, Google, Mozilla) using the endpoint URL the device itself hands us. There is no account,
 * no subscription, no Apple Developer membership and no third-party sender involved — only a VAPID
 * keypair we generate ourselves (scripts/generate-vapid-keys.ts). The PRIVATE key never leaves the
 * server: it is read from VAPID_PRIVATE_KEY and used only to sign the Authorization JWT here.
 *
 * The payload is encrypted end-to-end to the device's own keys, so the push service cannot read it.
 * Even so, keep message text free of customer details — a notification is rendered on a lock screen.
 *
 * Everything in this file is pure + injectable so it can be verified against the RFC 8291 §5 test
 * vector in web-push.test.ts rather than only against a live push service.
 */
import { createECDH, createHash, createPrivateKey, createSign, hkdfSync, createCipheriv, randomBytes, type ECDH } from 'node:crypto'

const b64url = (b: Buffer | ArrayBuffer): string => Buffer.from(b as Buffer).toString('base64url')
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url')

export const CURVE = 'prime256v1'
/** Single-record size we advertise; the payloads we send are a few hundred bytes. */
export const RECORD_SIZE = 4096
/** The aes128gcm header we emit: 16-byte salt + 4-byte rs + 1-byte key length + 65-byte key. */
export const HEADER_BYTES = 16 + 4 + 1 + 65
/**
 * Largest plaintext that still fits a RECORD_SIZE body: rs − header − 16-byte GCM tag − 1-byte
 * delimiter. RFC 8291 §4 requires rs to EXCEED the encrypted record, so the header is counted in.
 * Our payloads are a couple of hundred bytes, so this is a guard rail, not a constraint.
 */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - 16 - 1

export interface PushSubscriptionKeys {
  /** The device's P-256 public key, base64url, uncompressed point (65 bytes). */
  p256dh: string
  /** The device's 16-byte auth secret, base64url. */
  auth: string
}

export interface VapidKeys {
  /** base64url, uncompressed point (65 bytes) — safe to serve to the browser. */
  publicKey: string
  /** base64url, 32-byte scalar — SERVER ONLY. */
  privateKey: string
}

/** Generate a VAPID keypair. Used by scripts/generate-vapid-keys.ts; never at request time. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH(CURVE)
  ecdh.generateKeys()
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) }
}

/** Shape check only — never proves the pair matches. */
export function looksLikeVapidKeys(keys: Partial<VapidKeys> | null | undefined): keys is VapidKeys {
  if (!keys?.publicKey || !keys.privateKey) return false
  const pub = fromB64url(keys.publicKey)
  const priv = fromB64url(keys.privateKey)
  return pub.length === 65 && pub[0] === 0x04 && priv.length === 32
}

/** Does this private key actually belong to this public key? (cheap, no network) */
export function vapidKeysMatch(keys: VapidKeys): boolean {
  try {
    const ecdh = createECDH(CURVE)
    ecdh.setPrivateKey(fromB64url(keys.privateKey))
    return ecdh.getPublicKey().equals(fromB64url(keys.publicKey))
  } catch { return false }
}

// ── VAPID (RFC 8292) ──────────────────────────────────────────────────────────

/** `https://origin` of a push endpoint — the JWT audience. */
export function audienceOf(endpoint: string): string {
  return new URL(endpoint).origin
}

function ecPrivateKeyObject(privateKeyB64: string) {
  const ecdh = createECDH(CURVE)
  ecdh.setPrivateKey(fromB64url(privateKeyB64))
  const pub = ecdh.getPublicKey() // 0x04 || X(32) || Y(32)
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(ecdh.getPrivateKey()), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: 'jwk',
  })
}

/**
 * The `Authorization: vapid t=…, k=…` header proving to the push service that WE (holder of the
 * VAPID private key) sent this. `subject` must be a mailto: or https: contact URL.
 */
export function vapidAuthorization(opts: { endpoint: string; subject: string; keys: VapidKeys; now?: Date; ttlSeconds?: number }): string {
  const exp = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000) + (opts.ttlSeconds ?? 12 * 3600)
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64url(Buffer.from(JSON.stringify({ aud: audienceOf(opts.endpoint), exp, sub: opts.subject })))
  const signer = createSign('SHA256')
  signer.update(`${header}.${payload}`)
  // ieee-p1363 = the raw r||s pair JWS/ES256 requires (NOT the DER encoding node signs by default).
  const sig = signer.sign({ key: ecPrivateKeyObject(opts.keys.privateKey), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${payload}.${b64url(sig)}, k=${opts.keys.publicKey}`
}

// ── Payload encryption (RFC 8291, Content-Encoding: aes128gcm) ────────────────

const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0', 'ascii')
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'ascii')
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'ascii')

/**
 * Encrypt one push message for one device.
 *
 * `ephemeral` and `salt` exist only so the RFC test vector can be reproduced exactly; production
 * callers omit both and get a fresh random ephemeral key + salt per message (required — reusing
 * either would break the encryption's security).
 */
export function encryptPayload(
  plaintext: string | Buffer,
  keys: PushSubscriptionKeys,
  opts: { ephemeral?: ECDH; salt?: Buffer } = {},
): Buffer {
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8')
  if (body.length > MAX_PAYLOAD_BYTES) throw new Error(`Push payload too large (${body.length} > ${MAX_PAYLOAD_BYTES} bytes)`)

  const uaPublic = fromB64url(keys.p256dh)
  const authSecret = fromB64url(keys.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('Invalid subscription key (p256dh)')
  if (authSecret.length !== 16) throw new Error('Invalid subscription auth secret')

  const ecdh = opts.ephemeral ?? createECDH(CURVE)
  if (!opts.ephemeral) ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(uaPublic)
  const salt = opts.salt ?? randomBytes(16)

  // RFC 8291 §3.4: IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = "WebPush: info"\0 || ua || as)
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32))
  // RFC 8188: the content key + nonce come from the record salt.
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, CEK_INFO, 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, NONCE_INFO, 12))

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 = "this is the last record" delimiter (RFC 8188 §2); no further padding is needed.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([body, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(5)
  header.writeUInt32BE(RECORD_SIZE, 0)
  header.writeUInt8(asPublic.length, 4)
  return Buffer.concat([salt, header, asPublic, ciphertext])
}

// ── Delivery ──────────────────────────────────────────────────────────────────

export type PushOutcome =
  /** The push service accepted it for delivery (it is NOT proof the phone showed it). */
  | { status: 'sent'; httpStatus: number }
  /** This subscription is dead (unsubscribed / app removed). Stop using it — never retry. */
  | { status: 'expired'; httpStatus: number; error: string }
  /** Temporary: rate limit, outage, network. Try again later. */
  | { status: 'retry'; httpStatus: number | null; error: string }
  /** Permanently rejected (bad VAPID key, payload too large, bad request). Staff must fix something. */
  | { status: 'failed'; httpStatus: number | null; error: string }

const short = (s: string) => s.slice(0, 400)

export interface SendOptions {
  endpoint: string
  keys: PushSubscriptionKeys
  payload: string
  vapid: VapidKeys
  subject: string
  /** Seconds the push service may hold the message for an offline phone. */
  ttl?: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  /** Replaces an undelivered message with the same topic instead of stacking another one. */
  topic?: string
  fetchImpl?: typeof fetch
  now?: Date
  /** Kept short on purpose: the dispatcher sends serially inside a bounded serverless invocation. */
  timeoutMs?: number
}

/**
 * POST one encrypted message to one push endpoint.
 *
 * Outcome mapping is deliberate: 404/410 mean the subscription is gone (disable it); 429/5xx and
 * network failures are temporary (retry); everything else is a real fault we should surface rather
 * than retry forever. A push that is "sent" was only ACCEPTED by the push service.
 */
export async function sendPush(opts: SendOptions): Promise<PushOutcome> {
  let encrypted: Buffer
  let authorization: string
  try {
    encrypted = encryptPayload(opts.payload, opts.keys)
    authorization = vapidAuthorization({ endpoint: opts.endpoint, subject: opts.subject, keys: opts.vapid, now: opts.now })
  } catch (err) {
    return { status: 'failed', httpStatus: null, error: short(err instanceof Error ? err.message : String(err)) }
  }

  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttl ?? 6 * 3600),
        Urgency: opts.urgency ?? 'high',
        ...(opts.topic ? { Topic: opts.topic } : {}),
      },
      body: new Uint8Array(encrypted),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    })
  } catch (err) {
    return { status: 'retry', httpStatus: null, error: short(err instanceof Error ? `${err.name}: ${err.message}` : String(err)) }
  }

  if (res.status === 404 || res.status === 410) return { status: 'expired', httpStatus: res.status, error: 'Subscription no longer exists on this device.' }
  if (res.ok) return { status: 'sent', httpStatus: res.status }
  const text = await res.text().catch(() => '')
  if (res.status === 429 || res.status === 408 || res.status >= 500) return { status: 'retry', httpStatus: res.status, error: short(`${res.status} ${text || 'push service unavailable'}`) }
  return { status: 'failed', httpStatus: res.status, error: short(`${res.status} ${text || 'push service rejected the message'}`) }
}

/** Stable, non-reversible id for an endpoint — safe to log / put in an index. */
export const endpointHash = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex')

// ── Server configuration ──────────────────────────────────────────────────────

export interface PushConfig { vapid: VapidKeys; subject: string }

/**
 * Reads the server's push configuration, or null when it has not been set up. Null is a normal
 * state: alerts are still recorded durably, they simply report "push is not configured" instead of
 * pretending to have been delivered.
 */
export function pushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig | null {
  const keys = { publicKey: (env.VAPID_PUBLIC_KEY ?? '').trim(), privateKey: (env.VAPID_PRIVATE_KEY ?? '').trim() }
  if (!looksLikeVapidKeys(keys)) return null
  const subject = (env.VAPID_SUBJECT ?? '').trim()
  // RFC 8292 requires an absolute mailto:/https: contact the push service can reach us at.
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) return null
  return { vapid: keys, subject }
}
