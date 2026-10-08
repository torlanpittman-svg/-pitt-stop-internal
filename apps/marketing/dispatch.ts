/**
 * Send-safety layer around the campaign engine. This is the ONLY path the UI/cron use.
 *
 * V1 DECISION (owner, 2026-10-08): outbound SMS is DEFERRED (no Twilio/A2P activation), and live email
 * is unconfigured (Pitt Stop's only real email is QuickBooks-native). So dispatch NEVER sends — and,
 * crucially, it is also **non-destructive**: it produces a read-only PREVIEW (previewCampaign) that does
 * not transition the campaign or touch recipient rows. A campaign can be drafted, approved, built and
 * previewed as many times as needed; nothing leaves the building and nothing is marked sent/suppressed.
 *
 * There is NO send mechanism in V1 — `campaigns.ts` exposes only `previewCampaign` (read-only), so there
 * is no live bypass beneath this layer to worry about. The Twilio provider, A2P compliance composer,
 * quiet-hours and cap logic are left intact (imported where useful) for a future activation pass.
 */
import { getMarketingConfig } from '@/apps/settings/db'
import { a2pProfile, composeSmsBody } from './compliance'
import { previewCampaign, type PreviewSummary } from './campaigns'
import { getCampaign } from './db'

/** Hard kill-switch for ALL live marketing sends in V1. Not env/settings-driven on purpose. */
export const SEND_DEFERRED = true

export interface DispatchResult {
  ok: boolean
  live: boolean
  /** True whenever the live path is intentionally skipped (V1 always true). */
  deferred?: boolean
  reason?: 'not_approved' | 'not_found'
  preview?: PreviewSummary
}

/** Current hour (0–23) in the shop's local timezone (Central). Preserved for the future live path. */
function localHour(now: Date, timeZone = 'America/Chicago'): number {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(now)
  const n = parseInt(h, 10)
  return n === 24 ? 0 : n
}

/** Quiet-hours predicate (TCPA-friendly). Preserved for the future live SMS path; unused while deferred. */
export function withinQuietHours(now: Date, startHour: number, endHour: number, timeZone?: string): boolean {
  const h = localHour(now, timeZone)
  return h >= startHour && h < endHour
}

/**
 * Dispatch = a NON-DESTRUCTIVE dry-run preview in V1. No provider is ever contacted, no recipient is
 * changed, and the campaign is not transitioned — even if Twilio/email credentials are present or
 * `marketing_sms_live` is on. Returns what a send WOULD do so the manager can review it.
 */
export async function dispatchCampaign(campaignId: string): Promise<DispatchResult> {
  const campaign = await getCampaign(campaignId)
  if (!campaign) return { ok: false, live: false, reason: 'not_found' }
  if (campaign.status !== 'ready' && campaign.status !== 'scheduled' && campaign.status !== 'sending') {
    return { ok: false, live: false, reason: 'not_approved' }
  }

  const cfg = await getMarketingConfig()
  const cap = Math.min(cfg.sendDailyCap, cfg.smsGlobalCap)
  const p = a2pProfile(cfg)

  const preview = await previewCampaign(campaignId, {
    cap,
    // Compose with brand + STOP language so the PREVIEW shows exactly what a future live SMS would say.
    composeSms: (body) => composeSmsBody(body, p),
  })
  return { ok: true, live: false, deferred: SEND_DEFERRED, preview }
}
