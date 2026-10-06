/**
 * Campaign recipient building + sending. Two guarantees matter most here:
 *   1. Consent is enforced at build time — ineligible / unsubscribed / unreachable customers become
 *      `excluded` rows (with a reason) and are NEVER sent to.
 *   2. Sending is idempotent and honest — only `pending` recipients are processed, a dry-run send
 *      marks the recipient `suppressed` (reason 'dry_run') and is reported as such; nothing is ever
 *      recorded as `sent` unless a LIVE provider actually accepted it.
 */
import { getPreferences, hasSmsConsent } from './consent'
import { getDb } from '@/platform/db'
import { marketingPreferences } from './schema'
import { contactAggregates } from './contacts'
import { applySegment, resolveSegmentCriteria } from './segments'
import {
  getCampaign, insertRecipients, listRecipients, markRecipient, refreshCampaignCounts,
  transitionCampaign, type Campaign, type RecipientSeed,
} from './db'
import { logEvent } from './events'
import { getProviders, type Providers } from './providers'
import type { ContactAggregate } from './segments'
import type { SendChannel } from './types'

const BUILDABLE = new Set(['draft', 'ready', 'scheduled', 'paused'])

/** Personalize a template. Only {{name}}/{{first_name}}/{{vehicle}} are supported, and only when known. */
export function renderCopy(template: string | null | undefined, vars: { name?: string | null; vehicle?: string | null }): string {
  if (!template) return ''
  const first = (vars.name ?? '').trim().split(/\s+/)[0] || 'there'
  return template
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, (vars.name ?? '').trim() || first)
    .replace(/\{\{\s*vehicle\s*\}\}/gi, (vars.vehicle ?? '').trim() || 'your vehicle')
}

function channelsFor(campaign: Campaign): SendChannel[] {
  return campaign.channel === 'both' ? ['sms', 'email'] : [campaign.channel as SendChannel]
}

/** Decide whether a contact is reachable on a channel, and why not. */
function reach(contact: ContactAggregate, channel: SendChannel): { ok: boolean; address: string | null; reason: string | null } {
  if (contact.unsubscribed) return { ok: false, address: null, reason: 'unsubscribed' }
  if (channel === 'sms') {
    if (!contact.phone) return { ok: false, address: null, reason: 'no_phone' }
    if (!contact.smsEligible) return { ok: false, address: contact.phone, reason: 'sms_ineligible' }
    // A present phone number is NOT consent — promotional SMS requires proven opt-in (0047).
    if (!contact.smsConsent) return { ok: false, address: contact.phone, reason: 'no_sms_consent' }
    return { ok: true, address: contact.phone, reason: null }
  }
  if (!contact.email) return { ok: false, address: null, reason: 'no_email' }
  if (!contact.emailEligible) return { ok: false, address: contact.email, reason: 'email_ineligible' }
  return { ok: true, address: contact.email, reason: null }
}

export interface BuildSummary { matched: number; pending: number; excluded: number; inserted: number }

/**
 * Build (or top up) the recipient list for a campaign from its segment. Deterministic: same segment
 * + same data ⇒ same recipients. Idempotent: re-running never duplicates or resets sent recipients.
 */
export async function buildCampaignRecipients(campaignId: string, opts: { actor?: string | null; now?: number } = {}): Promise<BuildSummary> {
  const campaign = await getCampaign(campaignId)
  if (!campaign) throw new Error('Campaign not found')
  if (!BUILDABLE.has(campaign.status)) throw new Error(`Cannot build recipients while campaign is ${campaign.status}`)

  const now = opts.now ?? Date.now()
  const criteria = resolveSegmentCriteria(campaign.segmentKey, campaign.segmentCriteria as never)
  const aggregates = await contactAggregates()
  const matched = applySegment(aggregates, criteria, now)
  const channels = channelsFor(campaign)

  const seeds: RecipientSeed[] = []
  for (const contact of matched) {
    for (const channel of channels) {
      const r = reach(contact, channel)
      const template = channel === 'sms' ? campaign.smsCopy : campaign.emailBody
      seeds.push({
        customerId: contact.customerId,
        channel,
        addressSnapshot: r.address,
        vehicleLabel: null,
        status: r.ok ? 'pending' : 'excluded',
        exclusionReason: r.reason,
        renderedBody: r.ok ? renderCopy(template, { name: contact.name, vehicle: null }) : null,
      })
    }
  }

  const inserted = await insertRecipients(campaignId, seeds)
  await refreshCampaignCounts(campaignId)

  const pending = seeds.filter((s) => s.status === 'pending').length
  const excluded = seeds.filter((s) => s.status === 'excluded').length
  await logEvent('recipients_built', {
    entityType: 'campaign', entityId: campaignId, actor: opts.actor ?? null,
    meta: { matched: matched.length, pending, excluded, inserted },
  })
  return { matched: matched.length, pending, excluded, inserted }
}

export interface SendSummary { dryRun: boolean; sent: number; suppressed: number; failed: number; total: number; capped?: number; alreadySent?: boolean }

/**
 * Send a campaign. Must be a manager-approved campaign (ready/scheduled) — the caller enforces role;
 * here we enforce the state machine. Processes only `pending` recipients. A dry-run (no live provider)
 * suppresses every recipient and reports dryRun:true — nothing external happens, nothing is faked.
 */
export async function sendCampaign(campaignId: string, opts: { actor?: string | null; providers?: Providers; now?: number; cap?: number; composeSms?: (body: string) => string } = {}): Promise<SendSummary> {
  const campaign = await getCampaign(campaignId)
  if (!campaign) throw new Error('Campaign not found')

  if (campaign.status === 'sent' || campaign.status === 'completed' || campaign.status === 'cancelled') {
    return { dryRun: campaign.dryRun, sent: campaign.sentCount, suppressed: 0, failed: 0, total: campaign.recipientCount, alreadySent: true }
  }
  if (campaign.status !== 'ready' && campaign.status !== 'scheduled' && campaign.status !== 'sending') {
    throw new Error(`Campaign must be approved (ready/scheduled) before sending; it is ${campaign.status}`)
  }

  const providers = opts.providers ?? getProviders()
  if (campaign.status !== 'sending') await transitionCampaign(campaignId, 'sending', opts.actor ?? null)

  const allPending = await listRecipients(campaignId, 'pending')
  // Send-safety cap: process at most `cap` recipients; the rest stay pending (re-runnable) and are logged.
  const cap = opts.cap != null && opts.cap >= 0 ? opts.cap : allPending.length
  const pending = allPending.slice(0, cap)
  const cappedOut = allPending.length - pending.length
  let sent = 0, suppressed = 0, failed = 0, anyLive = false

  for (const r of pending) {
    // Consent can change after recipient building. Re-read immediately before contacting anyone.
    const pref = r.customerId ? await getPreferences(r.customerId) : null
    const eligible = r.channel === 'sms' ? hasSmsConsent(pref) : !pref?.unsubscribedAt && pref?.emailEligible !== false
    if (!eligible) {
      await markRecipient(r.id, { status: 'suppressed', exclusionReason: 'consent_revoked_before_send' })
      suppressed++
      continue
    }
    let body = r.renderedBody ?? ''
    const address = r.addressSnapshot ?? ''
    let result
    if (r.channel === 'sms') {
      if (opts.composeSms) body = opts.composeSms(body)   // brand + STOP opt-out language
      result = await providers.sms.send(address, body)
    } else {
      result = await providers.email.send(address, campaign.emailSubject ?? '', body)
    }

    if (result.status === 'sent') {
      await markRecipient(r.id, { status: 'sent', sentAt: new Date(), providerMessageId: result.providerMessageId ?? null, deliveryStatus: 'sent', renderedBody: body })
      if (r.customerId) await touchLastContacted(r.customerId)
      sent++; anyLive = true
    } else if (result.status === 'failed') {
      await markRecipient(r.id, { status: 'failed', exclusionReason: (result.error ?? 'send_failed').slice(0, 60), errorCode: (result.error ?? '').slice(0, 20) })
      failed++
    } else {
      await markRecipient(r.id, { status: 'suppressed', exclusionReason: 'dry_run' })
      suppressed++
    }
  }

  await refreshCampaignCounts(campaignId)
  const dryRun = !anyLive
  // Only finalize to 'sent' when the whole list is processed; if capped, keep it 'sending' (resumable).
  if (cappedOut === 0) await transitionCampaign(campaignId, 'sent', opts.actor ?? null, { dryRun, sentCount: sent })
  await logEvent('campaign_sent', {
    entityType: 'campaign', entityId: campaignId, actor: opts.actor ?? null,
    meta: { dryRun, sent, suppressed, failed, total: pending.length, cappedOut },
  })
  return { dryRun, sent, suppressed, failed, total: pending.length, capped: cappedOut }
}

async function touchLastContacted(customerId: string): Promise<void> {
  // Only called on a genuine live send.
  await getDb().insert(marketingPreferences)
    .values({ customerId, lastContactedAt: new Date() })
    .onConflictDoUpdate({ target: marketingPreferences.customerId, set: { lastContactedAt: new Date(), updatedAt: new Date() } })
}
