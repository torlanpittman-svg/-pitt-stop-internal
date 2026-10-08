'use server'
/**
 * Marketing server actions. EVERY action re-checks managerActor() server-side (defense-in-depth —
 * never trust the hidden tile or the proxy alone), validates its inputs (apps/marketing/validation)
 * and FAILS CLOSED on malformed enums/dates/amounts/ids. Expected validation errors are NOT thrown as
 * opaque 500s in prod: they redirect back with a readable `?err=` flash the page renders. Sends go
 * through dispatchCampaign, which is a NON-DESTRUCTIVE dry-run preview in V1 (SMS/email deferred).
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { managerActor } from '@/apps/checks/authz'
import { updateSetting, SETTINGS } from '@/apps/settings/db'
import { createCampaign, updateCampaignCopy, transitionCampaign, getCampaign } from '@/apps/marketing/db'
import { buildCampaignRecipients } from '@/apps/marketing/campaigns'
import { dispatchCampaign } from '@/apps/marketing/dispatch'
import { generateCampaignCopy } from '@/apps/marketing/ai/campaign-copy'
import { generateSocialPost } from '@/apps/marketing/ai/social-post'
import { createPost, updatePost, findContentCandidates, seedWeeklyPlan } from '@/apps/marketing/content'
import { createLead, updateLead } from '@/apps/marketing/leads'
import { linkLeadOutcome } from '@/apps/marketing/attribution'
import { upsertAdMetric, upsertSearchTerm } from '@/apps/marketing/ads'
import { ingestComment, updateConversation } from '@/apps/marketing/comments'
import { weekStart } from '@/apps/marketing/report'
import { confirmSendEmail, confirmPublishFacebook, manualErrorMessage } from '@/apps/marketing/manual-send'
import { PublishingError } from '@/apps/marketing/providers/publishing'
import { validateCampaignCopy } from '@/apps/marketing/guardrails'
import {
  enumValue, optionalEnumValue, requiredText, optionalText, optionalYmdDate, ymdDate,
  optionalCents, nonNegativeInt, uuidValue, MarketingInputError,
} from '@/apps/marketing/validation'
import {
  CAMPAIGN_TYPES, CHANNELS, SERVICE_CATEGORIES, LEAD_STATUSES, POST_STATUSES, CONTENT_PILLARS,
  ATTRIBUTION_SOURCES,
} from '@/apps/marketing/types'
import type { Channel, LeadStatus, PostStatus, ServiceCategory, AttributionSource } from '@/apps/marketing/types'

const CONVERSATION_ACTIONS = ['answered', 'archived'] as const

async function actorName(): Promise<string> {
  const actor = await managerActor()
  if (!actor) redirect('/auto-sales/login?next=/marketing')
  return actor.name
}

const str = (fd: FormData, k: string): string => String(fd.get(k) ?? '').trim()
const opt = (fd: FormData, k: string): string | null => { const v = str(fd, k); return v || null }

/** Surface an expected validation error as a readable flash on the originating page (never a 500). */
function fail(path: string, e: unknown): never {
  if (e instanceof MarketingInputError) redirect(`${path}?err=${encodeURIComponent(e.message)}`)
  throw e
}

// ── Campaigns ────────────────────────────────────────────────────────────────

export async function createCampaignAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    const c = await createCampaign({
      name: requiredText(str(fd, 'name'), 'Campaign name', 160),
      campaignType: optionalEnumValue(opt(fd, 'campaignType'), CAMPAIGN_TYPES, 'campaign type') ?? 'reactivation',
      targetService: optionalEnumValue(opt(fd, 'targetService'), SERVICE_CATEGORIES, 'target service'),
      segmentKey: optionalText(opt(fd, 'segmentKey'), 'segment', 60),
      channel: optionalEnumValue(opt(fd, 'channel'), CHANNELS, 'channel') ?? 'both',
      offer: optionalText(opt(fd, 'offer'), 'offer'),
    }, actor)
    revalidatePath('/marketing/campaigns')
    redirect(`/marketing/campaigns/${c.id}`)
  } catch (e) { fail('/marketing/campaigns/new', e) }
}

export async function updateCampaignCopyAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  try {
    uuidValue(id, 'campaign id')
    await updateCampaignCopy(id, {
      name: opt(fd, 'name') ? requiredText(str(fd, 'name'), 'Campaign name', 160) : undefined,
      smsCopy: optionalText(opt(fd, 'smsCopy'), 'SMS copy'),
      emailSubject: optionalText(opt(fd, 'emailSubject'), 'email subject'),
      emailBody: optionalText(opt(fd, 'emailBody'), 'email body'),
      offer: optionalText(opt(fd, 'offer'), 'offer'),
      channel: (optionalEnumValue(opt(fd, 'channel'), CHANNELS, 'channel') as Channel | null) ?? undefined,
    }, actor)
    revalidatePath(`/marketing/campaigns/${id}`)
  } catch (e) { fail(`/marketing/campaigns/${id}`, e) }
}

export async function generateCopyAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  try {
    uuidValue(id, 'campaign id')
    const campaign = await getCampaign(id)
    if (!campaign) return
    const draft = await generateCampaignCopy({
      targetService: (campaign.targetService as ServiceCategory) ?? 'general',
      segmentLabel: campaign.segmentKey ?? 'Pitt Stop customers',
      channel: campaign.channel as Channel,
      offer: campaign.offer,
    })
    await updateCampaignCopy(id, {
      smsCopy: draft.copy.smsCopy, emailSubject: draft.copy.emailSubject, emailBody: draft.copy.emailBody,
    }, actor)
    revalidatePath(`/marketing/campaigns/${id}`)
  } catch (e) { fail(`/marketing/campaigns/${id}`, e) }
}

export async function buildRecipientsAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  try {
    uuidValue(id, 'campaign id')
    await buildCampaignRecipients(id, { actor })
    revalidatePath(`/marketing/campaigns/${id}`)
  } catch (e) { fail(`/marketing/campaigns/${id}`, e) }
}

export async function approveCampaignAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  try {
    uuidValue(id, 'campaign id')
    const campaign = await getCampaign(id)
    if (!campaign) return
    const guard = validateCampaignCopy({ smsCopy: campaign.smsCopy, emailSubject: campaign.emailSubject, emailBody: campaign.emailBody }, { offerApproved: !!campaign.offer })
    if (!guard.ok) {
      const msgs = guard.findings.filter((f) => f.severity === 'error').map((f) => f.message)
      throw new MarketingInputError(`Cannot approve — fix the copy first: ${msgs.join('; ')}`)
    }
    await transitionCampaign(id, 'ready', actor)
    revalidatePath(`/marketing/campaigns/${id}`)
  } catch (e) { fail(`/marketing/campaigns/${id}`, e) }
}

export async function sendCampaignAction(fd: FormData): Promise<void> {
  await actorName() // manager-gate before any read
  const id = str(fd, 'id')
  try {
    uuidValue(id, 'campaign id')
    // NON-DESTRUCTIVE dry-run preview only (SMS/email deferred): nothing is sent, nothing is mutated.
    const res = await dispatchCampaign(id)
    const n = res.preview?.wouldSend ?? 0
    redirect(`/marketing/campaigns/${id}?msg=${encodeURIComponent(`Preview only — would send ${n} (dry-run). Nothing was sent and no recipient was changed.`)}`)
  } catch (e) { fail(`/marketing/campaigns/${id}`, e) }
}

export async function cancelCampaignAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  try {
    uuidValue(id, 'campaign id')
    await transitionCampaign(id, 'cancelled', actor)
    revalidatePath(`/marketing/campaigns/${id}`)
  } catch (e) { fail(`/marketing/campaigns/${id}`, e) }
}

// ── Content ──────────────────────────────────────────────────────────────────

export async function createPostAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    await createPost({
      pillar: enumValue(str(fd, 'pillar') || 'educate', CONTENT_PILLARS, 'pillar'),
      targetService: optionalEnumValue(opt(fd, 'targetService'), SERVICE_CATEGORIES, 'target service'),
      copy: optionalText(opt(fd, 'copy'), 'post copy') ?? '',
    }, actor)
    revalidatePath('/marketing/content')
  } catch (e) { fail('/marketing/content', e) }
}

export async function generatePostAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    const pillar = enumValue(str(fd, 'pillar') || 'educate', CONTENT_PILLARS, 'pillar')
    const targetService = (optionalEnumValue(opt(fd, 'targetService'), SERVICE_CATEGORIES, 'target service') ?? 'general') as ServiceCategory
    const draft = await generateSocialPost({ pillar, targetService, vehicle: optionalText(opt(fd, 'vehicle'), 'vehicle', 160), servicePerformed: optionalText(opt(fd, 'servicePerformed'), 'service performed', 160) })
    await createPost({ pillar, targetService, copy: draft.post.copy, aiGenerated: draft.source === 'ai', createdSource: 'ai' }, actor)
    revalidatePath('/marketing/content')
  } catch (e) { fail('/marketing/content', e) }
}

export async function postFromCandidateAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    const orderId = uuidValue(str(fd, 'orderId'), 'order id')
    const candidates = await findContentCandidates(50)
    const cand = candidates.find((c) => c.serviceOrderId === orderId)
    if (!cand) return
    const draft = await generateSocialPost({ pillar: 'proof', targetService: cand.category, vehicle: cand.vehicleLabel, servicePerformed: cand.category })
    // No before/after is attached automatically — a manager selects + verifies the actual shots.
    await createPost({
      pillar: 'proof', targetService: cand.category, copy: draft.post.copy,
      serviceOrderId: cand.serviceOrderId,
      aiGenerated: draft.source === 'ai', createdSource: 'job_candidate',
    }, actor)
    revalidatePath('/marketing/content')
  } catch (e) { fail('/marketing/content', e) }
}

export async function updatePostAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  try {
    uuidValue(id, 'post id')
    // The review/approval rules (non-empty copy, schedule date, posted link, approver) are enforced
    // authoritatively in updatePost(); we just parse + validate shapes here.
    await updatePost(id, {
      copy: optionalText(opt(fd, 'copy'), 'post copy') ?? undefined,
      status: (optionalEnumValue(opt(fd, 'status'), POST_STATUSES, 'post status') as PostStatus | null) ?? undefined,
      scheduledAt: optionalYmdDate(opt(fd, 'scheduledAt'), 'scheduled date') ?? undefined,
      externalPostRef: optionalText(opt(fd, 'externalPostRef'), 'published post link', 240) ?? undefined,
    }, actor)
    revalidatePath('/marketing/content')
  } catch (e) { fail('/marketing/content', e) }
}

export async function seedWeeklyPlanAction(): Promise<void> {
  const actor = await actorName()
  await seedWeeklyPlan(weekStart(new Date()), actor)  // idempotent — no duplicate seed spam
  revalidatePath('/marketing/content')
  revalidatePath('/marketing/calendar')
}

// ── Leads ────────────────────────────────────────────────────────────────────

export async function createLeadAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    await createLead({
      name: optionalText(opt(fd, 'name'), 'name', 200),
      phone: optionalText(opt(fd, 'phone'), 'phone', 40),
      email: optionalText(opt(fd, 'email'), 'email', 240),
      vehicle: optionalText(opt(fd, 'vehicle'), 'vehicle', 160),
      requestedService: optionalEnumValue(opt(fd, 'requestedService'), SERVICE_CATEGORIES, 'requested service'),
      source: (optionalEnumValue(opt(fd, 'source'), ATTRIBUTION_SOURCES, 'source') ?? 'unknown') as AttributionSource,
    }, actor)
    revalidatePath('/marketing/leads')
  } catch (e) { fail('/marketing/leads', e) }
}

export async function updateLeadAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  try {
    uuidValue(id, 'lead id')
    await updateLead(id, {
      status: (optionalEnumValue(opt(fd, 'status'), LEAD_STATUSES, 'status') as LeadStatus | null) ?? undefined,
      // Stored for reference only — it is NOT the report's revenue (that is canonical/QB-anchored).
      attributedRevenueCents: optionalCents(opt(fd, 'attributedRevenue'), 'attributed revenue') ?? undefined,
      notes: optionalText(opt(fd, 'notes'), 'notes') ?? undefined,
    }, actor)
    revalidatePath('/marketing/leads')
  } catch (e) { fail('/marketing/leads', e) }
}

/**
 * Link a lead to the real order it produced (chosen from the search list — no manual UUIDs, no manual
 * revenue). Allowed before completion; the report credits it dynamically once the order completes + is
 * invoiced. Re-linking supersedes the prior link (append-only).
 */
export async function linkLeadOrderAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    const leadId = uuidValue(str(fd, 'leadId'), 'lead id')
    const serviceOrderId = uuidValue(str(fd, 'serviceOrderId'), 'order id')
    await linkLeadOutcome(leadId, { serviceOrderId }, actor)
    redirect('/marketing/leads?msg=' + encodeURIComponent('Lead linked to order. Revenue will appear once the job completes + is invoiced.'))
  } catch (e) { fail('/marketing/leads', e) }
}

// ── Manual sending (explicit, manager-confirmed, LIVE) ─────────────────────────

/** Surface manual-send failures (provider blockers / unknown outcomes) as a readable flash. */
function manualFail(path: string, e: unknown): never {
  if (e instanceof MarketingInputError) redirect(`${path}?err=${encodeURIComponent(e.message)}`)
  if (e instanceof PublishingError) redirect(`${path}?err=${encodeURIComponent(manualErrorMessage(e.code))}`)
  throw e
}

/** Required preview fingerprint (sha-256 hex). The user-facing action CANNOT skip preview binding. */
function requireHex64(fd: FormData, key: string): string {
  const v = str(fd, key)
  if (!/^[0-9a-f]{64}$/i.test(v)) throw new MarketingInputError('Re-open the preview and confirm the current version before sending.')
  return v
}

/** Explicitly send an approved email campaign to the MailerLite group audience. Never a dry-run. */
export async function sendCampaignEmailAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  const path = `/marketing/campaigns/${id}`
  try {
    uuidValue(id, 'campaign id')
    if (str(fd, 'confirm') !== 'send-email') throw new MarketingInputError('Confirm the send to proceed.')
    // Bind the confirmation to exactly what was previewed; both fingerprints are REQUIRED here.
    const res = await confirmSendEmail(id, actor, { expected: { contentHash: requireHex64(fd, 'contentHash'), audienceHash: requireHex64(fd, 'audienceHash') } })
    const note = res.alreadySent
      ? 'Already sent — no duplicate was created.'
      : `Email handed to MailerLite for ${res.audienceCount} subscriber(s). Check MailerLite for delivery — accepted is not the same as delivered.`
    redirect(`${path}?msg=${encodeURIComponent(note)}`)
  } catch (e) { manualFail(path, e) }
}

/** Explicitly publish an approved post to the Pitt Stop Facebook Page. Never a dry-run. */
export async function publishPostFacebookAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  const path = '/marketing/content'
  try {
    uuidValue(id, 'post id')
    if (str(fd, 'confirm') !== 'publish-facebook') throw new MarketingInputError('Confirm the publish to proceed.')
    const res = await confirmPublishFacebook(id, actor, { expected: { contentHash: requireHex64(fd, 'contentHash') } })
    const note = res.alreadySent ? 'Already published — no duplicate was created.' : `Published to Facebook (reference ${res.externalRef}).`
    redirect(`${path}?msg=${encodeURIComponent(note)}`)
  } catch (e) { manualFail(path, e) }
}

// ── Google Ads (manual import) ────────────────────────────────────────────────

export async function importAdMetricAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    const statDate = str(fd, 'statDate')
    ymdDate(statDate, 'date') // validate YYYY-MM-DD; upsert stores the string form
    await upsertAdMetric({
      serviceCategory: enumValue(str(fd, 'serviceCategory') || 'general', SERVICE_CATEGORIES, 'service category'),
      statDate,
      spendCents: optionalCents(opt(fd, 'spend'), 'spend') ?? 0,
      impressions: nonNegativeInt(str(fd, 'impressions'), 'impressions'),
      clicks: nonNegativeInt(str(fd, 'clicks'), 'clicks'),
      conversions: nonNegativeInt(str(fd, 'conversions'), 'conversions'),
      revenueCents: optionalCents(opt(fd, 'revenue'), 'revenue') ?? 0,
    }, actor)
    revalidatePath('/marketing/google-ads')
  } catch (e) { fail('/marketing/google-ads', e) }
}

export async function importSearchTermAction(fd: FormData): Promise<void> {
  await actorName()
  try {
    await upsertSearchTerm({
      term: requiredText(str(fd, 'term'), 'search term', 200),
      serviceCategory: optionalEnumValue(opt(fd, 'serviceCategory'), SERVICE_CATEGORIES, 'service category'),
      spendCents: optionalCents(opt(fd, 'spend'), 'spend') ?? 0,
      clicks: nonNegativeInt(str(fd, 'clicks'), 'clicks'),
      conversions: nonNegativeInt(str(fd, 'conversions'), 'conversions'),
      revenueCents: optionalCents(opt(fd, 'revenue'), 'revenue') ?? 0,
      statPeriod: optionalText(opt(fd, 'statPeriod'), 'period', 20),
    })
    revalidatePath('/marketing/google-ads')
  } catch (e) { fail('/marketing/google-ads', e) }
}

// ── Comment assistant ─────────────────────────────────────────────────────────

export async function ingestCommentAction(fd: FormData): Promise<void> {
  await actorName()
  try {
    await ingestComment({
      authorName: optionalText(opt(fd, 'authorName'), 'author name', 200),
      message: requiredText(str(fd, 'message'), 'message', 4000),
      externalRef: optionalText(opt(fd, 'externalRef'), 'external reference', 160),
    })
    revalidatePath('/marketing/content')
  } catch (e) { fail('/marketing/content', e) }
}

export async function resolveConversationAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    const id = uuidValue(str(fd, 'id'), 'conversation id')
    const state = optionalEnumValue(opt(fd, 'state'), CONVERSATION_ACTIONS, 'action') ?? 'answered'
    await updateConversation(id, {
      state,
      suggestedReply: optionalText(opt(fd, 'suggestedReply'), 'reply') ?? undefined,
      handledBy: actor,
    }, actor)
    revalidatePath('/marketing/content')
  } catch (e) { fail('/marketing/content', e) }
}

// ── Settings ──────────────────────────────────────────────────────────────────

// NOTE: `marketing_sms_live` is intentionally OMITTED while SMS is deferred — it is not editable from
// the UI (dispatch ignores it regardless). The stored setting value is preserved, not deleted.
const MARKETING_SETTING_KEYS = [
  'marketing_enabled', 'marketing_require_approval', 'marketing_send_daily_cap',
  'marketing_attribution_window_days', 'marketing_high_value_cents', 'marketing_default_offer',
  'marketing_sms_brand_name', 'marketing_sms_help_text', 'marketing_sms_frequency',
  'marketing_privacy_url', 'marketing_terms_url', 'marketing_sms_quiet_start_hour',
  'marketing_sms_quiet_end_hour', 'marketing_sms_global_cap',
  'marketing_public_base_url', 'marketing_legal_name', 'marketing_business_website', 'marketing_support_contact',
  'marketing_a2p_brand_approved', 'marketing_a2p_campaign_approved', 'marketing_advanced_optout_configured',
  'marketing_privacy_published', 'marketing_terms_published', 'marketing_webhooks_verified', 'marketing_optin_published',
]

export async function updateMarketingSettingsAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  try {
    const scoped = String(fd.get('__keys') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const keys = scoped.length ? scoped.filter((k) => MARKETING_SETTING_KEYS.includes(k)) : MARKETING_SETTING_KEYS
    for (const key of keys) {
      const def = SETTINGS[key]
      if (!def) continue
      const raw = def.type === 'bool' ? fd.get(key) === 'on' : fd.get(key)
      if (raw === null && def.type !== 'bool') continue
      if (def.type === 'int' && raw !== null) nonNegativeInt(String(raw), def.key) // reject malformed, no silent 0
      await updateSetting(key, raw, actor)
    }
    revalidatePath('/marketing/settings')
  } catch (e) { fail('/marketing/settings', e) }
}
