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
import { classifyInboundKeyword, a2pProfile, helpReply, optInConfirmation, stopConfirmation } from './compliance'
import { normalizePhone } from './optin'
import { getMarketingConfig } from '@/apps/settings/db'

export interface InboundResult {
  action: 'stop' | 'start' | 'help' | 'reply'
  reply: string | null
  customerId: string | null
  /** True when Twilio Advanced Opt-Out already recognized the keyword and sent its own response. */
  twilioHandled: boolean
}

async function findCustomerByPhone(from: string): Promise<string | null> {
  const normalized = normalizePhone(from)
  if (normalized.length !== 10) return null
  const [row] = await getDb().select({ id: customers.id }).from(customers)
    .where(and(eq(customers.normalizedPhone, normalized), eq(customers.active, true))).limit(1)
  return row?.id ?? null
}

/**
 * Handle an inbound SMS. If Twilio Messaging Service Advanced Opt-Out handled the keyword it sends
 * `OptOutType` (STOP|START|HELP) AND its own confirmation — in that case we ONLY sync local state and
 * return a null reply (no competing/duplicate message). When OptOutType is absent, we classify the
 * body ourselves: keyword → sync + a fallback acknowledgement; otherwise it enters the conversation
 * queue through the assistant.
 */
export async function handleInboundSms(params: Record<string, string>): Promise<InboundResult> {
  const from = params.From ?? ''
  const body = params.Body ?? ''
  const messageSid = params.MessageSid ?? params.SmsSid ?? null
  const optOutType = (params.OptOutType ?? '').trim().toUpperCase() // STOP | START | HELP | ''
  const twilioHandled = optOutType === 'STOP' || optOutType === 'START' || optOutType === 'HELP'
  const keyword = twilioHandled ? (optOutType.toLowerCase() as 'stop' | 'start' | 'help') : classifyInboundKeyword(body)
  const customerId = await findCustomerByPhone(from)

  // Only build our own reply when Twilio did NOT already respond.
  let profile: ReturnType<typeof a2pProfile> | null = null
  const getProfile = async () => (profile ??= a2pProfile((await getMarketingConfig().catch(() => ({}))) as never))

  if (keyword === 'stop') {
    if (customerId) await revokeSmsConsent(customerId, { source: 'sms_keyword', phone: from, reason: optOutType || 'STOP' })
    else await recordConsentEvent({ customerId: null, channel: 'sms', event: 'opt_out', source: 'sms_keyword', phone: from, meta: { unmatched: true } })
    return { action: 'stop', reply: twilioHandled ? null : stopConfirmation(await getProfile()), customerId, twilioHandled }
  }

  if (keyword === 'start') {
    // Twilio keyword opt-in — consent source recorded as sms_keyword.
    if (customerId) await grantSmsConsent(customerId, { source: 'sms_keyword', phone: from })
    else await recordConsentEvent({ customerId: null, channel: 'sms', event: 'opt_in', source: 'sms_keyword', phone: from, meta: { unmatched: true } })
    return { action: 'start', reply: twilioHandled ? null : optInConfirmation(await getProfile()), customerId, twilioHandled }
  }

  if (keyword === 'help') {
    await recordConsentEvent({ customerId, channel: 'sms', event: 'help', source: 'sms_keyword', phone: from })
    return { action: 'help', reply: twilioHandled ? null : helpReply(await getProfile()), customerId, twilioHandled }
  }

  // A normal reply — route it into the conversation queue (never lost in logs), linked by MessageSid.
  await ingestComment({ platform: 'sms', authorName: from, message: body, externalRef: messageSid })
  return { action: 'reply', reply: null, customerId, twilioHandled: false }
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
