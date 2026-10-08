/**
 * Campaign recipient building + preview. Two guarantees matter most here:
 *   1. Consent is enforced at build time — ineligible / unsubscribed / unreachable customers become
 *      `excluded` rows (with a reason) and are NEVER sent to.
 *   2. There is NO send path in V1. SMS and email are deferred, so the only runtime operation is a
 *      NON-DESTRUCTIVE preview (`previewCampaign`) that writes nothing — it never contacts a provider,
 *      never marks a recipient, and never marks a campaign `sent`. The provider abstraction is kept for
 *      a future activation pass but is not invoked from here.
 */
import { contactAggregates } from './contacts'
import { applySegment, resolveSegmentCriteria } from './segments'
import {
  getCampaign, insertRecipients, listRecipients, refreshCampaignCounts,
  type Campaign, type RecipientSeed,
} from './db'
import { logEvent } from './events'
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

export interface PreviewSummary {
  dryRun: true
  total: number        // pending recipients
  wouldSend: number    // within the per-run cap
  capped: number       // held back by the cap
  excluded: number
  samples: Array<{ channel: string; address: string | null; body: string }>
}

/**
 * NON-DESTRUCTIVE preview of what a send WOULD do. Writes nothing: it does not transition the
 * campaign and does not touch recipient rows (they stay `pending`). This is the only path the UI/cron
 * use in V1 (via dispatchCampaign), because SMS/email are deferred and a preview must never mutate state.
 */
export async function previewCampaign(campaignId: string, opts: { cap?: number; composeSms?: (body: string) => string; sampleSize?: number } = {}): Promise<PreviewSummary> {
  const campaign = await getCampaign(campaignId)
  if (!campaign) throw new Error('Campaign not found')
  const pending = await listRecipients(campaignId, 'pending')
  const excluded = (await listRecipients(campaignId, 'excluded')).length
  const cap = opts.cap != null && opts.cap >= 0 ? opts.cap : pending.length
  const wouldSend = Math.min(pending.length, cap)
  const samples = pending.slice(0, opts.sampleSize ?? 3).map((r) => {
    let body = r.renderedBody ?? ''
    if (r.channel === 'sms' && opts.composeSms) body = opts.composeSms(body)
    return { channel: r.channel, address: r.addressSnapshot, body }
  })
  return { dryRun: true, total: pending.length, wouldSend, capped: pending.length - wouldSend, excluded, samples }
}
