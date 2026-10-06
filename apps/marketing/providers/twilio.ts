/**
 * Real Twilio SMS provider behind the SmsProvider interface. Prefers a Messaging Service
 * (MessagingServiceSid) so Twilio handles number pool + Advanced Opt-Out (STOP/HELP) for us.
 * Credentials are read SERVER-SIDE only and never exposed to the browser. `fetchImpl` is injectable
 * so tests exercise request shaping + response/error handling without the network.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SmsProvider, SendResult } from './index'

export interface TwilioConfig {
  accountSid: string
  authToken: string
  messagingServiceSid?: string
  fromNumber?: string
  statusCallbackUrl?: string
  testRecipient?: string
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

/** Normalize a US number to E.164 (+1XXXXXXXXXX). Returns null if it isn't a 10-digit US number. */
export function toE164(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
  return d.length === 10 ? `+1${d}` : null
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio-sms'
  readonly live = true
  constructor(private cfg: TwilioConfig, private fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  async send(to: string, body: string): Promise<SendResult> {
    const e164 = toE164(to)
    if (!e164) return { status: 'failed', error: 'invalid_phone' }
    if (this.cfg.testRecipient && e164 !== toE164(this.cfg.testRecipient)) return { status: 'failed', error: 'test_recipient_only' }
    if (!this.cfg.messagingServiceSid && !this.cfg.fromNumber) return { status: 'failed', error: 'no_sender_configured' }

    const params = new URLSearchParams()
    params.set('To', e164)
    params.set('Body', body)
    if (this.cfg.messagingServiceSid) params.set('MessagingServiceSid', this.cfg.messagingServiceSid)
    else params.set('From', this.cfg.fromNumber!)
    if (this.cfg.statusCallbackUrl) params.set('StatusCallback', this.cfg.statusCallbackUrl)

    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64')
    try {
      const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number }
      if (res.ok && data.sid) return { status: 'sent', providerMessageId: data.sid }
      return { status: 'failed', error: (data.message ?? `twilio_http_${res.status}`).slice(0, 120) }
    } catch (e) {
      return { status: 'failed', error: (e instanceof Error ? e.message : 'network_error').slice(0, 120) }
    }
  }
}

/**
 * Validate an X-Twilio-Signature. Twilio signs `url` + each POST param (sorted by key, key then value
 * concatenated) with HMAC-SHA1 keyed by the auth token, base64-encoded. Constant-time compared.
 */
export function validateTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null | undefined): boolean {
  if (!signature) return false
  let data = url
  for (const key of Object.keys(params).sort()) data += key + params[key]
  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64')
  const a = Buffer.from(expected), b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Build a TwilioConfig from server env, or null when not fully configured. */
export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID
  const authToken = env.TWILIO_AUTH_TOKEN
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID
  const fromNumber = env.TWILIO_FROM_NUMBER
  if (!accountSid || !authToken || (!messagingServiceSid && !fromNumber)) return null
  const base = env.TWILIO_WEBHOOK_BASE_URL || ''
  return {
    accountSid, authToken, messagingServiceSid, fromNumber,
    testRecipient: env.MARKETING_SMS_TEST_TO,
    statusCallbackUrl: base ? `${base.replace(/\/$/, '')}/api/twilio/sms/status` : undefined,
  }
}
