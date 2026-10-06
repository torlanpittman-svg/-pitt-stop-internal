/**
 * Send-safety layer around sendCampaign. This is the ONLY path the UI/cron should use to send, because
 * it enforces the guardrails a bare sendCampaign does not:
 *   • Live vs dry-run: live SMS happens ONLY when marketing_sms_live is ON **and** Twilio is configured.
 *     Otherwise it forces dry-run — a campaign never silently goes live.
 *   • Quiet hours: live SMS is refused outside the configured local window (TCPA-friendly).
 *   • Caps: per-run processing is capped by min(campaign cap, global SMS cap).
 *   • Compliance: outbound SMS gets brand identification + STOP opt-out language.
 */
import { getMarketingConfig } from '@/apps/settings/db'
import { getProviders, dryRunProviders } from './providers'
import { a2pProfile, composeSmsBody } from './compliance'
import { sendCampaign, type SendSummary } from './campaigns'
import { getCampaign } from './db'

export interface DispatchResult {
  ok: boolean
  live: boolean
  reason?: 'sms_not_configured' | 'quiet_hours' | 'not_approved' | 'not_found' | 'launch_not_ready'
  summary?: SendSummary
}

/** Current hour (0–23) in the shop's local timezone (Central). */
function localHour(now: Date, timeZone = 'America/Chicago'): number {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(now)
  const n = parseInt(h, 10)
  return n === 24 ? 0 : n
}

export function withinQuietHours(now: Date, startHour: number, endHour: number, timeZone?: string): boolean {
  const h = localHour(now, timeZone)
  return h >= startHour && h < endHour
}

export async function dispatchCampaign(campaignId: string, opts: { actor?: string | null; now?: Date } = {}): Promise<DispatchResult> {
  const campaign = await getCampaign(campaignId)
  if (!campaign) return { ok: false, live: false, reason: 'not_found' }
  if (campaign.status !== 'ready' && campaign.status !== 'scheduled' && campaign.status !== 'sending') {
    return { ok: false, live: false, reason: 'not_approved' }
  }

  const cfg = await getMarketingConfig()
  const now = opts.now ?? new Date()
  const real = getProviders()
  const wantsSms = campaign.channel === 'sms' || campaign.channel === 'both'

  // Live SMS requires the flag ON and Twilio actually configured. Never silently live.
  const canLiveSms = cfg.smsLive && real.sms.live
  if (wantsSms && cfg.smsLive && !real.sms.live) {
    return { ok: false, live: false, reason: 'sms_not_configured' }
  }
  // Quiet-hours block applies only to a genuine live SMS send.
  if (wantsSms && canLiveSms && !withinQuietHours(now, cfg.smsQuietStartHour, cfg.smsQuietEndHour)) {
    return { ok: false, live: true, reason: 'quiet_hours' }
  }

  if (wantsSms && canLiveSms && (!cfg.enabled || !cfg.publicBaseUrl || !cfg.supportContact ||
    !cfg.optInPublished || !cfg.privacyPublished || !cfg.termsPublished || !cfg.advancedOptOutConfigured ||
    !cfg.a2pBrandApproved || !cfg.a2pCampaignApproved || !cfg.webhooksVerified ||
    !process.env.TWILIO_MESSAGING_SERVICE_SID || !process.env.TWILIO_WEBHOOK_BASE_URL)) {
    return { ok: false, live: false, reason: 'launch_not_ready' }
  }

  const live = canLiveSms
  const providers = live ? real : dryRunProviders()
  const cap = Math.min(cfg.sendDailyCap, cfg.smsGlobalCap)
  const p = a2pProfile(cfg)

  const summary = await sendCampaign(campaignId, {
    actor: opts.actor ?? null,
    providers,
    cap,
    composeSms: (body) => composeSmsBody(body, p),
    now: now.getTime(),
  })
  return { ok: true, live, summary }
}
