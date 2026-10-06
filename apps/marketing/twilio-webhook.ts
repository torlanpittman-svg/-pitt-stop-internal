/**
 * Twilio inbound + status webhook logic (pure of HTTP plumbing so it's unit-testable). The route
 * handlers validate the X-Twilio-Signature, then hand the parsed params here.
 *
 * Inbound: STOP revokes SMS consent immediately (no custom STOP reply — Twilio Advanced Opt-Out sends
 * the carrier-required acknowledgement, so we don't double-text). START re-grants. HELP replies with
 * the help text. A normal reply enters the Marketing conversation queue for manager follow-up.
 * Status: delivery callbacks update the matching recipient by provider message id.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { customers } from '@/apps/directory/schema'
import { grantSmsConsent, revokeSmsConsent, recordConsentEvent } from './consent'
import { updateDeliveryByProviderId } from './db'
import { ingestComment } from './comments'
import { classifyInboundKeyword, a2pProfile, helpReply } from './compliance'
import { normalizePhone } from './optin'
import { getMarketingConfig } from '@/apps/settings/db'

export interface InboundResult { action: 'stop' | 'start' | 'help' | 'reply'; reply: string | null; customerId: string | null }

async function findCustomerByPhone(from: string): Promise<string | null> {
  const normalized = normalizePhone(from)
  if (normalized.length !== 10) return null
  const [row] = await getDb().select({ id: customers.id }).from(customers)
    .where(and(eq(customers.normalizedPhone, normalized), eq(customers.active, true))).limit(1)
  return row?.id ?? null
}

/** Handle an inbound SMS (From, Body, MessageSid). */
export async function handleInboundSms(params: Record<string, string>): Promise<InboundResult> {
  const from = params.From ?? ''
  const body = params.Body ?? ''
  const messageSid = params.MessageSid ?? params.SmsSid ?? null
  const keyword = classifyInboundKeyword(body)
  const customerId = await findCustomerByPhone(from)

  if (keyword === 'stop') {
    if (customerId) await revokeSmsConsent(customerId, { source: 'sms_keyword', phone: from, reason: 'STOP' })
    else await recordConsentEvent({ customerId: null as unknown as string, channel: 'sms', event: 'opt_out', source: 'sms_keyword', phone: from, meta: { unmatched: true } })
    // No custom reply — Twilio Advanced Opt-Out sends the required STOP confirmation.
    return { action: 'stop', reply: null, customerId }
  }

  if (keyword === 'start') {
    if (customerId) await grantSmsConsent(customerId, { source: 'sms_keyword', phone: from })
    return { action: 'start', reply: null, customerId }
  }

  if (keyword === 'help') {
    const cfg = await getMarketingConfig().catch(() => null)
    await recordConsentEvent({ customerId: (customerId ?? null) as unknown as string, channel: 'sms', event: 'help', source: 'sms_keyword', phone: from })
    return { action: 'help', reply: helpReply(a2pProfile(cfg ?? {})), customerId }
  }

  // A normal reply — route it into the conversation queue (never lost in logs), linked by MessageSid.
  await ingestComment({ platform: 'sms', authorName: from, message: body, externalRef: messageSid })
  return { action: 'reply', reply: null, customerId }
}

export interface StatusResult { updated: boolean; recipientId: string | null }

/** Handle a Twilio status callback (MessageSid, MessageStatus, ErrorCode). */
export async function handleStatusCallback(params: Record<string, string>): Promise<StatusResult> {
  const sid = params.MessageSid ?? params.SmsSid ?? ''
  const status = params.MessageStatus ?? params.SmsStatus ?? ''
  const errorCode = params.ErrorCode || null
  if (!sid || !status) return { updated: false, recipientId: null }
  const recipientId = await updateDeliveryByProviderId(sid, status, errorCode)
  return { updated: !!recipientId, recipientId }
}

/** Render a minimal TwiML response (empty, or with one message). */
export function twiml(reply: string | null): string {
  if (!reply) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
  const escaped = reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`
}
