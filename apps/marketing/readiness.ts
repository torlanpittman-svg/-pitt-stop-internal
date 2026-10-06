/**
 * SMS launch readiness model. PURE + deterministic so the preflight card can't lie and is testable.
 *
 * Hard rule: having Twilio credentials does NOT make Pitt Stop "ready" to send. A2P brand + campaign
 * approval, Advanced Opt-Out configuration, and published public policies are SEPARATE, explicitly
 * confirmed states. `canGoLive` is true only when every required item is READY.
 */
import type { MarketingConfig } from '@/apps/settings/db'

export type ReadinessStatus = 'ready' | 'not_ready' | 'external'
export interface ReadinessItem {
  key: string
  label: string
  status: ReadinessStatus
  detail: string
  /** Whether this item must be READY for a live send. */
  required: boolean
}

export interface ReadinessInputs {
  cfg: MarketingConfig
  /** Twilio SMS provider is configured (account sid + token + messaging service/from). */
  providerLive: boolean
  /** A public webhook base URL is configured (TWILIO_WEBHOOK_BASE_URL or public base URL). */
  webhookBaseConfigured: boolean
  /** Number of customers with proven SMS consent. */
  subscriberCount: number
}

export interface ReadinessReport {
  items: ReadinessItem[]
  canGoLive: boolean
  blockers: ReadinessItem[]
}

export function smsLaunchReadiness(input: ReadinessInputs): ReadinessReport {
  const { cfg, providerLive, webhookBaseConfigured, subscriberCount } = input
  const yn = (ok: boolean, ext = false): ReadinessStatus => (ok ? 'ready' : ext ? 'external' : 'not_ready')

  const items: ReadinessItem[] = [
    { key: 'db', label: 'Marketing database ready', status: 'ready', required: true, detail: 'Migrations 0046–0048 define all marketing + consent + delivery tables.' },
    { key: 'consent_model', label: 'Consent model ready', status: 'ready', required: true, detail: 'Proven-opt-in SMS consent with append-only audit trail.' },
    { key: 'opt_in_live', label: 'Public opt-in published', status: yn(!!cfg.publicBaseUrl, true), required: true, detail: cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/sms-opt-in` : 'Set the public base URL and publish /sms-opt-in on the customer-facing domain.' },
    { key: 'privacy', label: 'Privacy Policy compliant + published', status: yn(cfg.privacyPublished, true), required: true, detail: cfg.privacyPublished ? 'Confirmed published with the SMS section.' : 'Publish the SMS privacy section on the public domain, then confirm.' },
    { key: 'terms', label: 'SMS Terms compliant + published', status: yn(cfg.termsPublished, true), required: true, detail: cfg.termsPublished ? 'Confirmed published with the SMS program section.' : 'Publish the SMS program terms on the public domain, then confirm.' },
    { key: 'twilio_creds', label: 'Twilio account + Messaging Service configured', status: yn(providerLive, true), required: true, detail: providerLive ? 'Account SID, auth token, and Messaging Service SID present.' : 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID.' },
    { key: 'advanced_optout', label: 'Twilio Advanced Opt-Out configured', status: yn(cfg.advancedOptOutConfigured, true), required: true, detail: cfg.advancedOptOutConfigured ? 'Confirmed STOP/START/HELP keyword handling in Twilio.' : 'Enable Advanced Opt-Out (STOP/UNSUBSCRIBE, START/UNSTOP, HELP) on the Messaging Service, then confirm.' },
    { key: 'a2p_brand', label: 'A2P Brand approved', status: yn(cfg.a2pBrandApproved, true), required: true, detail: cfg.a2pBrandApproved ? 'TCR brand approved.' : 'Register + get the A2P brand approved in Twilio/TCR, then confirm.' },
    { key: 'a2p_campaign', label: 'A2P Campaign approved', status: yn(cfg.a2pCampaignApproved, true), required: true, detail: cfg.a2pCampaignApproved ? 'TCR campaign approved.' : 'Register + get the A2P campaign approved, then confirm.' },
    { key: 'webhook_base', label: 'Webhook base URL configured', status: yn(webhookBaseConfigured, true), required: true, detail: webhookBaseConfigured ? 'Inbound/status callbacks will resolve to a public URL.' : 'Set TWILIO_WEBHOOK_BASE_URL (or the public base URL) so Twilio callbacks reach /api/twilio/sms/*.' },
    { key: 'webhook_reachable', label: 'Inbound + status webhooks reachable', status: webhookBaseConfigured ? 'external' : 'external', required: true, detail: 'Deploy, then confirm Twilio reaches /api/twilio/sms/inbound and /status (signature-validated).' },
    { key: 'test_opt_in', label: 'At least one test opt-in exists', status: yn(subscriberCount > 0), required: true, detail: subscriberCount > 0 ? `${subscriberCount} consented subscriber(s).` : 'Complete at least one real opt-in via /sms-opt-in.' },
    { key: 'live_flag', label: 'Live SMS flag enabled', status: yn(cfg.smsLive), required: true, detail: cfg.smsLive ? 'marketing_sms_live is ON.' : 'Leave OFF until everything else is READY; then flip to go live.' },
  ]

  const blockers = items.filter((i) => i.required && i.status !== 'ready')
  return { items, canGoLive: blockers.length === 0, blockers }
}
