/**
 * SMS / A2P 10DLC compliance. Central, versioned source for:
 *   • the opt-in disclosure wording a customer agrees to (stored with each consent event),
 *   • compliant outbound composition (sender ID + STOP opt-out language),
 *   • inbound keyword classification (STOP / START / HELP) per carrier requirements.
 *
 * URLs (privacy/terms) are configurable and must be REAL public pages — never invented here.
 */
import type { MarketingConfig } from '@/apps/settings/db'

/** Bump when the disclosure wording materially changes; stored on each consent event for audit. */
export const SMS_OPT_IN_VERSION = 'v2-2026-10-06'

/** Approved program constants (truthful, conservative). */
export const SMS_MAX_PER_MONTH = 3
export const SMS_FREQUENCY_TEXT = `Up to ${SMS_MAX_PER_MONTH} marketing messages per month.`
export const SMS_PROGRAM_NAME = 'Pitt Stop Detail & Auto Sales SMS Marketing'
export const SMS_CAMPAIGN_DESCRIPTION =
  'Pitt Stop Detail & Auto Sales sends recurring promotional SMS messages to customers who affirmatively opt in. ' +
  'Messages include detailing service information, ceramic-coating and paint-correction offers, appointment opportunities, ' +
  'and Pitt Stop promotions. Messages are sent only to customers who have explicitly consented.'

export interface A2pProfile {
  brandName: string          // short SMS sender identification
  legalName: string          // legal/DBA name for registration
  campaignDescription: string
  messageFrequency: string
  helpText: string
  supportContact: string
  website: string
  publicBaseUrl: string
  privacyUrl: string
  termsUrl: string
  optInUrl: string
}

function joinUrl(base: string, path: string): string {
  return base ? `${base.replace(/\/$/, '')}${path}` : ''
}

/** Resolve the A2P profile from marketing settings. Customer-facing URLs derive from the PUBLIC base
 *  URL unless an explicit URL is set. Everything blank-safe — never invents a domain. */
export function a2pProfile(cfg: Partial<MarketingConfig> = {}): A2pProfile {
  const base = cfg.publicBaseUrl || ''
  return {
    brandName: cfg.smsBrandName || 'Pitt Stop Detail',
    legalName: cfg.legalName || 'Pitt Stop Detail & Auto Sales',
    campaignDescription: SMS_CAMPAIGN_DESCRIPTION,
    messageFrequency: cfg.smsFrequency || SMS_FREQUENCY_TEXT,
    helpText: cfg.smsHelpText || 'Reply HELP for help. Msg & data rates may apply.',
    supportContact: cfg.supportContact || '',
    website: cfg.businessWebsite || base,
    publicBaseUrl: base,
    privacyUrl: cfg.privacyUrl || joinUrl(base, '/privacy'),
    termsUrl: cfg.termsUrl || joinUrl(base, '/terms'),
    optInUrl: joinUrl(base, '/sms-opt-in'),
  }
}

/** Recommended Twilio Advanced Opt-Out START (opt-in) confirmation. Includes program terms + URLs. */
export function optInConfirmation(p: A2pProfile): string {
  const links = [p.termsUrl ? `Terms: ${p.termsUrl}` : '', p.privacyUrl ? `Privacy: ${p.privacyUrl}` : ''].filter(Boolean).join(' ')
  return [`${p.legalName}: You're subscribed to recurring promotional texts.`, p.messageFrequency,
    'Msg & data rates may apply. Reply HELP for help or STOP to opt out.', links].filter(Boolean).join(' ')
}

/** Recommended STOP (opt-out) confirmation. */
export function stopConfirmation(p: A2pProfile): string {
  return `${p.legalName}: You're unsubscribed and will receive no more marketing texts. Reply START to resubscribe.`
}

/** The approved affirmative opt-in checkbox label (shown immediately next to the unchecked box). */
export function optInCheckboxLabel(p: A2pProfile): string {
  return `Yes, I agree to receive recurring promotional text messages, including messages sent by automated technology, from ${p.legalName} about services, appointment opportunities and offers. ${p.messageFrequency} Msg & data rates may apply. Reply STOP to unsubscribe or HELP for help. Consent is not a condition of purchase.`
}

/** The exact disclosure a customer agrees to at opt-in (also stored as consent_text). */
export function smsDisclosureText(p: A2pProfile): string {
  const links = [p.privacyUrl ? `Privacy: ${p.privacyUrl}` : '', p.termsUrl ? `Terms: ${p.termsUrl}` : ''].filter(Boolean).join('  ')
  return [
    optInCheckboxLabel(p),
    links,
  ].filter(Boolean).join(' ')
}

const BRAND_PREFIX_RE = (brand: string) => new RegExp('^' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
// Detect an opt-out INSTRUCTION specifically — not the word "stop" (the brand "Pitt Stop" contains it).
const HAS_OPT_OUT_RE = /\b(reply|text)\s+stop\b|\bstop\s+to\s+(opt|unsub|cancel|end|quit)/i

/**
 * Make an outbound marketing SMS compliant: identify the sender (brand) and include opt-out language,
 * without double-adding either. Keeps the message natural — does not turn it into legal spam.
 */
export function composeSmsBody(body: string, p: A2pProfile): string {
  let out = (body ?? '').trim()
  const needsOptOut = !HAS_OPT_OUT_RE.test(out)
  if (!BRAND_PREFIX_RE(p.brandName).test(out)) out = `${p.brandName}: ${out}`
  if (needsOptOut) out = `${out.replace(/\s+$/, '')} Reply STOP to opt out.`
  return out
}

export type InboundKeyword = 'stop' | 'start' | 'help' | null

// Carrier-standard keywords. Matched on the first word, case-insensitive, punctuation-tolerant.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke'])
const START_WORDS = new Set(['start', 'unstop', 'yes', 'optin', 'subscribe'])
const HELP_WORDS = new Set(['help', 'info'])

/** Classify an inbound SMS as a control keyword (STOP/START/HELP) or null (a normal reply). */
export function classifyInboundKeyword(message: string | null | undefined): InboundKeyword {
  const first = (message ?? '').trim().toLowerCase().replace(/[^a-z]/g, ' ').split(/\s+/)[0] ?? ''
  if (!first) return null
  if (STOP_WORDS.has(first)) return 'stop'
  if (START_WORDS.has(first)) return 'start'
  if (HELP_WORDS.has(first)) return 'help'
  return null
}

/** The HELP auto-reply body (carrier requirement). Twilio Advanced Opt-Out can also handle this. */
export function helpReply(p: A2pProfile): string {
  const support = p.supportContact ? ` ${p.supportContact}.` : ''
  return `${p.brandName}: ${p.helpText}${support} Reply STOP to unsubscribe.`
}

/** Realistic registration sample messages (brand-identified, STOP language, no fake offers). */
export function sampleMessages(p: A2pProfile): string[] {
  const b = p.brandName
  return [
    `${b}: Protect your vehicle's finish with ceramic coating — longer-lasting gloss and easier washing. Reply for details or an inspection. Reply STOP to opt out.`,
    `${b}: If your paint has picked up swirls or lost gloss, we have paint-correction appointments available. Reply for an estimate. Reply STOP to opt out.`,
    `${b}: Treat your interior to a premium detail — stains, odor, and wear addressed. Reply to book a time. Reply STOP to opt out.`,
    `${b}: We haven't seen your vehicle in a while. If it's due for a reset, we have detail openings coming up. Reply to schedule. Reply STOP to opt out.`,
  ]
}
