'use server'
/**
 * Marketing server actions. EVERY action re-checks managerActor() server-side (defense-in-depth —
 * never trust the hidden tile or the proxy alone) and audits through the module's own logEvent calls.
 * Sends go through sendCampaign, which stays dry-run until a live provider is configured.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { managerActor } from '@/apps/checks/authz'
import { updateSetting, SETTINGS } from '@/apps/settings/db'
import { createCampaign, updateCampaignCopy, transitionCampaign, getCampaign } from '@/apps/marketing/db'
import { buildCampaignRecipients, sendCampaign } from '@/apps/marketing/campaigns'
import { generateCampaignCopy } from '@/apps/marketing/ai/campaign-copy'
import { generateSocialPost } from '@/apps/marketing/ai/social-post'
import { createPost, updatePost, findContentCandidates } from '@/apps/marketing/content'
import { createLead, updateLead } from '@/apps/marketing/leads'
import { upsertAdMetric } from '@/apps/marketing/ads'
import { ingestComment, updateConversation } from '@/apps/marketing/comments'
import { validateCampaignCopy } from '@/apps/marketing/guardrails'
import type { Channel, CampaignType, ContentPillar, LeadStatus, PostStatus, ServiceCategory, AttributionSource } from '@/apps/marketing/types'

async function actorName(): Promise<string> {
  const actor = await managerActor()
  if (!actor) redirect('/auto-sales/login?next=/marketing')
  return actor.name
}

const str = (fd: FormData, k: string): string => String(fd.get(k) ?? '').trim()
const opt = (fd: FormData, k: string): string | null => { const v = str(fd, k); return v || null }
const dollarsToCents = (v: string): number => { const n = Math.round(parseFloat(v.replace(/[^0-9.]/g, '')) * 100); return Number.isFinite(n) ? n : 0 }

// ── Campaigns ────────────────────────────────────────────────────────────────

export async function createCampaignAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const c = await createCampaign({
    name: str(fd, 'name') || 'Untitled campaign',
    campaignType: (opt(fd, 'campaignType') as CampaignType) ?? 'reactivation',
    targetService: opt(fd, 'targetService'),
    segmentKey: opt(fd, 'segmentKey'),
    channel: (opt(fd, 'channel') as Channel) ?? 'both',
    offer: opt(fd, 'offer'),
  }, actor)
  revalidatePath('/marketing/campaigns')
  redirect(`/marketing/campaigns/${c.id}`)
}

export async function updateCampaignCopyAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  await updateCampaignCopy(id, {
    name: opt(fd, 'name') ?? undefined,
    smsCopy: opt(fd, 'smsCopy'),
    emailSubject: opt(fd, 'emailSubject'),
    emailBody: opt(fd, 'emailBody'),
    offer: opt(fd, 'offer'),
    channel: (opt(fd, 'channel') as Channel) ?? undefined,
  }, actor)
  revalidatePath(`/marketing/campaigns/${id}`)
}

export async function generateCopyAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
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
}

export async function buildRecipientsAction(fd: FormData): Promise<void> {
  await actorName()
  const id = str(fd, 'id')
  await buildCampaignRecipients(id, { actor: await managerActor().then((a) => a?.name ?? null) })
  revalidatePath(`/marketing/campaigns/${id}`)
}

export async function approveCampaignAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  const campaign = await getCampaign(id)
  if (!campaign) return
  // Guardrails must pass before a campaign can be approved/Ready.
  const guard = validateCampaignCopy({ smsCopy: campaign.smsCopy, emailSubject: campaign.emailSubject, emailBody: campaign.emailBody }, { offerApproved: !!campaign.offer })
  if (!guard.ok) { revalidatePath(`/marketing/campaigns/${id}`); return }
  await transitionCampaign(id, 'ready', actor)
  revalidatePath(`/marketing/campaigns/${id}`)
}

export async function sendCampaignAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  await sendCampaign(id, { actor })
  revalidatePath(`/marketing/campaigns/${id}`)
}

export async function cancelCampaignAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  await transitionCampaign(id, 'cancelled', actor)
  revalidatePath(`/marketing/campaigns/${id}`)
}

// ── Content ──────────────────────────────────────────────────────────────────

export async function createPostAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  await createPost({
    pillar: (str(fd, 'pillar') as ContentPillar) || 'educate',
    targetService: (opt(fd, 'targetService') as ServiceCategory) ?? null,
    copy: str(fd, 'copy'),
  }, actor)
  revalidatePath('/marketing/content')
}

export async function generatePostAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const pillar = (str(fd, 'pillar') as ContentPillar) || 'educate'
  const targetService = (opt(fd, 'targetService') as ServiceCategory) ?? 'general'
  const draft = await generateSocialPost({ pillar, targetService, vehicle: opt(fd, 'vehicle'), servicePerformed: opt(fd, 'servicePerformed') })
  await createPost({ pillar, targetService, copy: draft.post.copy, aiGenerated: draft.source === 'ai', createdSource: 'ai' }, actor)
  revalidatePath('/marketing/content')
}

export async function postFromCandidateAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const orderId = str(fd, 'orderId')
  const candidates = await findContentCandidates(50)
  const cand = candidates.find((c) => c.serviceOrderId === orderId)
  if (!cand) return
  const draft = await generateSocialPost({ pillar: 'proof', targetService: cand.category, vehicle: cand.vehicleLabel, servicePerformed: cand.category })
  await createPost({
    pillar: 'proof', targetService: cand.category, copy: draft.post.copy,
    serviceOrderId: cand.serviceOrderId, beforePhotoId: cand.beforePhotoId, afterPhotoId: cand.afterPhotoId,
    aiGenerated: draft.source === 'ai', createdSource: 'job_candidate',
  }, actor)
  revalidatePath('/marketing/content')
}

export async function updatePostAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  const status = opt(fd, 'status') as PostStatus | null
  await updatePost(id, {
    copy: opt(fd, 'copy') ?? undefined,
    status: status ?? undefined,
    approvedBy: status === 'approved' ? actor : undefined,
  }, actor)
  revalidatePath('/marketing/content')
}

// ── Leads ────────────────────────────────────────────────────────────────────

export async function createLeadAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  await createLead({
    name: opt(fd, 'name'), phone: opt(fd, 'phone'), email: opt(fd, 'email'),
    vehicle: opt(fd, 'vehicle'), requestedService: opt(fd, 'requestedService'),
    source: (opt(fd, 'source') as AttributionSource) ?? 'unknown',
  }, actor)
  revalidatePath('/marketing/leads')
}

export async function updateLeadAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  const id = str(fd, 'id')
  const revenue = str(fd, 'attributedRevenue')
  await updateLead(id, {
    status: (opt(fd, 'status') as LeadStatus) ?? undefined,
    attributedRevenueCents: revenue ? dollarsToCents(revenue) : undefined,
    notes: opt(fd, 'notes') ?? undefined,
  }, actor)
  revalidatePath('/marketing/leads')
}

// ── Google Ads (manual import) ────────────────────────────────────────────────

export async function importAdMetricAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  await upsertAdMetric({
    serviceCategory: str(fd, 'serviceCategory') || 'general',
    statDate: str(fd, 'statDate'),
    spendCents: dollarsToCents(str(fd, 'spend')),
    impressions: parseInt(str(fd, 'impressions') || '0', 10) || 0,
    clicks: parseInt(str(fd, 'clicks') || '0', 10) || 0,
    conversions: parseInt(str(fd, 'conversions') || '0', 10) || 0,
    revenueCents: dollarsToCents(str(fd, 'revenue')),
  }, actor)
  revalidatePath('/marketing/google-ads')
}

// ── Comment assistant ─────────────────────────────────────────────────────────

export async function ingestCommentAction(fd: FormData): Promise<void> {
  await actorName()
  await ingestComment({ authorName: opt(fd, 'authorName'), message: str(fd, 'message'), externalRef: opt(fd, 'externalRef') })
  revalidatePath('/marketing/content')
}

export async function resolveConversationAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  await updateConversation(str(fd, 'id'), { state: 'answered', handledBy: actor }, actor)
  revalidatePath('/marketing/content')
}

// ── Settings ──────────────────────────────────────────────────────────────────

const MARKETING_SETTING_KEYS = [
  'marketing_enabled', 'marketing_require_approval', 'marketing_send_daily_cap',
  'marketing_attribution_window_days', 'marketing_high_value_cents', 'marketing_default_offer',
  // A2P / SMS
  'marketing_sms_live', 'marketing_sms_brand_name', 'marketing_sms_help_text', 'marketing_sms_frequency',
  'marketing_privacy_url', 'marketing_terms_url', 'marketing_sms_quiet_start_hour',
  'marketing_sms_quiet_end_hour', 'marketing_sms_global_cap',
]

export async function updateMarketingSettingsAction(fd: FormData): Promise<void> {
  const actor = await actorName()
  // A form declares which keys it owns via a hidden `__keys` field, so multiple settings forms on the
  // page don't clobber each other's booleans (an unchecked box is absent from the POST).
  const scoped = String(fd.get('__keys') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const keys = scoped.length ? scoped.filter((k) => MARKETING_SETTING_KEYS.includes(k)) : MARKETING_SETTING_KEYS
  for (const key of keys) {
    const def = SETTINGS[key]
    if (!def) continue
    const raw = def.type === 'bool' ? fd.get(key) === 'on' : fd.get(key)
    if (raw === null && def.type !== 'bool') continue
    await updateSetting(key, raw, actor)
  }
  revalidatePath('/marketing/settings')
}
