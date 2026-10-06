/**
 * A2P 10DLC registration packet — everything a manager needs to register the Pitt Stop campaign in
 * Twilio/TCR. Pure/derived from settings; this module NEVER submits anything. Blank required fields
 * are surfaced in `missing` so the packet can't look complete when it isn't.
 */
import type { MarketingConfig } from '@/apps/settings/db'
import {
  a2pProfile, SMS_CAMPAIGN_DESCRIPTION, SMS_PROGRAM_NAME, sampleMessages,
  optInConfirmation, stopConfirmation, helpReply, type A2pProfile,
} from './compliance'

export const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']
export const OPT_IN_KEYWORDS = ['START', 'UNSTOP', 'YES']
export const HELP_KEYWORDS = ['HELP', 'INFO']

export interface A2pPacket {
  programName: string
  brand: { legalName: string; brandName: string; businessType: string; website: string; supportContact: string }
  campaign: { useCase: 'MARKETING'; description: string }
  messageFlow: string
  urls: { website: string; optIn: string; privacy: string; terms: string }
  sampleMessages: string[]
  optInKeywords: string[]
  optOutKeywords: string[]
  helpKeywords: string[]
  confirmations: { optIn: string; optOut: string; help: string }
  missing: string[]
}

function messageFlow(p: A2pProfile): string {
  const optIn = p.optInUrl || '[set public base URL]'
  return (
    `Customers opt in by visiting Pitt Stop's public SMS sign-up page (${optIn}), entering their mobile ` +
    `number, and checking an optional, unchecked SMS-marketing consent box that is not required to book or ` +
    `buy. The page displays links to the SMS Privacy Policy and Terms alongside the consent disclosure, ` +
    `including frequency, rates, STOP/HELP instructions, and that consent is not a condition of purchase. Consent is recorded with the exact disclosure wording, ` +
    `a timestamp, and the source. Customers can also text START to re-subscribe and STOP at any time to opt out.`
  )
}

export function buildA2pPacket(cfg: MarketingConfig): A2pPacket {
  const p = a2pProfile(cfg)
  const missing: string[] = []
  if (!p.publicBaseUrl) missing.push('Public base URL (drives opt-in/privacy/terms URLs)')
  if (!p.website) missing.push('Business website URL')
  if (!p.privacyUrl) missing.push('Privacy Policy URL')
  if (!p.termsUrl) missing.push('Terms URL')
  if (!p.supportContact) missing.push('Customer support contact')

  return {
    programName: SMS_PROGRAM_NAME,
    brand: {
      legalName: p.legalName,
      brandName: p.brandName,
      businessType: 'Automotive services — auto detailing & used-car sales',
      website: p.website,
      supportContact: p.supportContact,
    },
    campaign: { useCase: 'MARKETING', description: SMS_CAMPAIGN_DESCRIPTION },
    messageFlow: messageFlow(p),
    urls: { website: p.website, optIn: p.optInUrl, privacy: p.privacyUrl, terms: p.termsUrl },
    sampleMessages: sampleMessages(p),
    optInKeywords: OPT_IN_KEYWORDS,
    optOutKeywords: OPT_OUT_KEYWORDS,
    helpKeywords: HELP_KEYWORDS,
    confirmations: { optIn: optInConfirmation(p), optOut: stopConfirmation(p), help: helpReply(p) },
    missing,
  }
}

export { SMS_CAMPAIGN_DESCRIPTION }
