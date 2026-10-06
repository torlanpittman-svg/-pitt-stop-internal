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
export const SMS_OPT_IN_VERSION = 'v1-2026-10'

export interface A2pProfile {
  brandName: string
  campaignDescription: string
  messageFrequency: string
  helpText: string
  privacyUrl: string
  termsUrl: string
}

/** Resolve the A2P profile from marketing settings (falls back to safe non-URL defaults). */
export function a2pProfile(cfg: Partial<MarketingConfig> & {
  smsBrandName?: string; smsHelpText?: string; smsFrequency?: string; privacyUrl?: string; termsUrl?: string
} = {}): A2pProfile {
  return {
    brandName: cfg.smsBrandName || 'Pitt Stop Detail',
    campaignDescription: 'Promotional and reactivation messages about detailing, paint correction, and ceramic coating services for customers who opt in.',
    messageFrequency: cfg.smsFrequency || 'Msg frequency varies (about 1–2/month).',
    helpText: cfg.smsHelpText || 'Reply HELP for help. Msg & data rates may apply.',
    privacyUrl: cfg.privacyUrl || '',
    termsUrl: cfg.termsUrl || '',
  }
}

/** The exact disclosure a customer agrees to at opt-in (also stored as consent_text). */
export function smsDisclosureText(p: A2pProfile): string {
  const links = [p.privacyUrl ? `Privacy: ${p.privacyUrl}` : '', p.termsUrl ? `Terms: ${p.termsUrl}` : ''].filter(Boolean).join('  ')
  return [
    `By checking this box you agree to receive promotional text messages from ${p.brandName} at the number provided, including messages sent by autodialer. Consent is not a condition of any purchase.`,
    p.messageFrequency,
    'Msg & data rates may apply. Reply STOP to opt out, HELP for help.',
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
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout'])
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
  return `${p.brandName}: ${p.helpText} Reply STOP to unsubscribe.`
}
