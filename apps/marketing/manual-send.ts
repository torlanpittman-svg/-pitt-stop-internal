/**
 * MANUAL, manager-initiated sending — the explicit "Send email" / "Publish Facebook" vertical slice.
 *
 * Reuses the existing publishing providers (MailerLitePublisher / FacebookPublisher) and the
 * marketing_automation_jobs table as a durable claim ledger, with a `manual-<channel>-<id>` slot key.
 * The claim uses the allowed `publishing` status (never a `planned`/`ready` due row), so the autopilot
 * worker never picks up or expires a manual item. This path is independent of autopilot:
 *   • It does NOT require autopilot enabled, a cron secret, a launch date, or the emailLive/facebookLive
 *     auto-publish switches — a manager is explicitly in the loop for each item.
 *   • It is LIVE by explicit intent, never a silent dry-run conversion: if the channel isn't connected,
 *     it refuses with a readable blocker instead of pretending.
 *   • Email sends to the authoritative MailerLite GROUP audience (surfaced transparently) — never the
 *     campaign's DB recipient rows. Unsubscribe / local exclusions are rechecked (assertAudienceAllowed).
 *   • Confirmation is bound to the EXACT previewed subject/body + audience fingerprint: an edit, a pause,
 *     or an audience change since preview rejects the send. Approval + audience are rechecked after the
 *     durable claim and again immediately before the provider call.
 *   • An uncertain network outcome is NEVER retried automatically: the claim moves to `needs_review`
 *     (or stays `publishing` on a hard crash) and a manager must inspect the provider.
 */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingAutomationJobs as jobs, marketingCampaigns, marketingSocialPosts } from './schema'
import { getAutopilotConfig } from './autopilot-config'
import { assertAudienceAllowed } from './autopilot'
import { localDate } from './autopilot-plan'
import { MailerLitePublisher, FacebookPublisher, PublishingError, type Subscriber } from './providers/publishing'
import { logEvent } from './events'

/** Minimal provider shapes so tests can inject mocks; real publishers satisfy them structurally. */
export interface EmailSender {
  audience(): Promise<Subscriber[]>
  createDraft(key: string, subject: string, body: string): Promise<{ id: string }>
  send(id: string): Promise<void>
}
export interface FacebookSender { publish(copy: string, key: string): Promise<string> }
export interface FacebookVerifier { verify(): Promise<string> }
export interface Expected { contentHash?: string; audienceHash?: string }
export interface ConfirmEmailOptions { email?: EmailSender; expected?: Expected }
export interface ConfirmFacebookOptions { facebook?: FacebookSender; expected?: Expected }

type ManualJob = typeof jobs.$inferSelect

export interface ManualJobView { status: string; externalRef: string | null; error: string | null }
export interface EmailReadiness {
  found: boolean
  subject: string
  body: string
  status: string
  blockers: string[]
  contentIssues: string[]
  audience: { count: number | null; ok: boolean; error: string | null } | null
  contentHash: string
  audienceHash: string | null
  job: ManualJobView | null
  canSend: boolean
}
export interface FacebookReadiness {
  found: boolean
  copy: string
  status: string
  linkPreview: string
  blockers: string[]
  contentIssues: string[]
  contentHash: string
  job: ManualJobView | null
  canPublish: boolean
}
export interface ManualSendResult { status: 'accepted'; externalRef: string; audienceCount?: number; alreadySent?: boolean }

const SENDABLE_EMAIL = new Set(['ready', 'scheduled'])
const PUBLISHABLE_POST = new Set(['approved', 'scheduled'])

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
/** Exact-content fingerprint the preview binds to; a later edit changes it and rejects the stale send. */
export function contentFingerprint(subject: string, body: string): string { return sha(`${subject}\n${body}`) }
/** Order-independent fingerprint of the authoritative provider audience (deduped lowercased emails). */
export function audienceFingerprint(list: Subscriber[]): string {
  return sha([...new Set(list.map((s) => s.email.trim().toLowerCase()))].sort().join('\n'))
}

/** Manual email connection/review checks — NO cron secret, launch date, or autopilot switches. */
export function manualEmailBlockers(cfg: { audienceReviewed: boolean }, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = []
  if (!env.MAILERLITE_API_TOKEN || !env.MAILERLITE_GROUP_ID || !env.MARKETING_EMAIL_FROM) out.push('Connect MailerLite and a verified sender (server credentials).')
  if (!cfg.audienceReviewed) out.push('Review the email audience and previous opt-outs on the Launch page first.')
  return out
}
export function manualFacebookBlockers(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = []
  if (!env.FACEBOOK_PAGE_ID || !env.FACEBOOK_PAGE_ACCESS_TOKEN || !env.FACEBOOK_GRAPH_VERSION) out.push('Connect the Pitt Stop Facebook Page (server credentials).')
  return out
}

function jobView(job: ManualJob | undefined, slotKey: string): ManualJobView | null {
  if (!job || job.slotKey !== slotKey) return null
  return { status: job.status, externalRef: job.externalRef ?? null, error: job.error ?? null }
}
function jobIssue(job: ManualJobView, noun: string): string {
  if (job.status === 'accepted') return `Already ${noun} via the provider${job.externalRef ? ` (ref ${job.externalRef})` : ''}.`
  if (job.status === 'needs_review') return 'A previous attempt needs review — inspect the provider before trying again.'
  return 'A send is in progress or its outcome is unknown — inspect the provider.'
}
const emailSlot = (id: string) => `manual-email-${id}`
const facebookSlot = (id: string) => `manual-facebook-${id}`

async function readJob(id: string): Promise<ManualJob | undefined> {
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, id))
  return job
}

/**
 * Durable claim: atomically insert the manual job row with the allowed `publishing` status. Winner
 * proceeds; a loser inspects the existing row and NEVER auto-retries.
 */
async function claimManual(id: string, channel: 'email' | 'facebook', slotKey: string, now: Date): Promise<{ claimed: true } | { claimed: false; existing: ManualJob }> {
  const inserted = await getDb().insert(jobs)
    .values({ id, slotKey, channel, scheduledDate: localDate(now), status: 'publishing', policyVersion: 'manual' })
    .onConflictDoNothing().returning({ id: jobs.id })
  if (inserted.length === 1) return { claimed: true }
  const existing = await readJob(id)
  if (!existing || existing.slotKey !== slotKey) throw new PublishingError('manual_send_conflict')
  return { claimed: false, existing }
}

/** A loser's view of an existing claim: no-op if already accepted, else refuse (never auto-retry). */
function resolveExisting(existing: ManualJob): ManualSendResult {
  if (existing.status === 'accepted' && existing.externalRef) return { status: 'accepted', externalRef: existing.externalRef, alreadySent: true }
  if (existing.status === 'needs_review') throw new PublishingError(existing.error || 'manual_send_needs_review')
  throw new PublishingError('manual_send_in_progress') // publishing (in-flight/unknown) or an unexpected state
}

async function blockManual(id: string, error: unknown, actor: string | null): Promise<PublishingError> {
  const err = error instanceof PublishingError ? error : new PublishingError('manual_send_failed_review_provider')
  await getDb().update(jobs).set({ status: 'needs_review', error: err.code, updatedAt: new Date() }).where(eq(jobs.id, id))
  await logEvent('manual_send_blocked', { entityType: 'automation', entityId: id, actor, meta: { reason: err.code } })
  return err
}

// ── Email ──────────────────────────────────────────────────────────────────────

export async function emailSendReadiness(campaignId: string, deps: { email?: EmailSender } = {}): Promise<EmailReadiness> {
  const [c] = await getDb().select().from(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId))
  const empty: EmailReadiness = { found: false, subject: '', body: '', status: '', blockers: [], contentIssues: [], audience: null, contentHash: '', audienceHash: null, job: null, canSend: false }
  if (!c) return empty
  const subject = (c.emailSubject ?? '').trim(), body = (c.emailBody ?? '').trim()
  const cfg = await getAutopilotConfig()
  const blockers = manualEmailBlockers(cfg)
  const contentIssues: string[] = []
  if (c.channel !== 'email' && c.channel !== 'both') contentIssues.push('This campaign is not an email campaign.')
  if (!subject || !body) contentIssues.push('Email subject and body are both required.')
  if (c.status === 'sending' || c.status === 'sent') contentIssues.push('This campaign has already been sent.')
  else if (!SENDABLE_EMAIL.has(c.status)) contentIssues.push('Approve the copy (mark Ready) before sending.')
  const job = jobView(await readJob(campaignId), emailSlot(campaignId))
  if (job) contentIssues.push(jobIssue(job, 'sent'))

  let audience: EmailReadiness['audience'] = null
  let audienceHash: string | null = null
  if (!blockers.length) {
    try {
      const provider = deps.email ?? new MailerLitePublisher(process.env.MAILERLITE_API_TOKEN ?? '', process.env.MARKETING_EMAIL_FROM ?? '', process.env.MAILERLITE_GROUP_ID ?? '')
      const list = await provider.audience()
      await assertAudienceAllowed(list)
      audience = { count: list.length, ok: true, error: null }
      audienceHash = audienceFingerprint(list)
    } catch (e) {
      audience = { count: null, ok: false, error: e instanceof PublishingError ? e.code : 'email_audience_unavailable' }
    }
  }
  const canSend = !blockers.length && !contentIssues.length && !!audience?.ok && !job
  return { found: true, subject, body, status: c.status, blockers, contentIssues, audience, contentHash: contentFingerprint(subject, body), audienceHash, job, canSend }
}

export async function confirmSendEmail(campaignId: string, actor: string, opts: ConfirmEmailOptions = {}, now = new Date()): Promise<ManualSendResult> {
  const db = getDb()
  const [c] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId))
  if (!c) throw new PublishingError('campaign_not_found')
  if (c.channel !== 'email' && c.channel !== 'both') throw new PublishingError('not_an_email_campaign')
  const subject = (c.emailSubject ?? '').trim(), body = (c.emailBody ?? '').trim()
  if (!subject || !body) throw new PublishingError('email_content_empty')
  const contentHash = contentFingerprint(subject, body)
  // Bind to the EXACT previewed content: an edit since preview rejects the stale approval.
  if (opts.expected?.contentHash && opts.expected.contentHash !== contentHash) throw new PublishingError('content_changed_since_preview')

  // A prior manual claim settles the outcome first: accepted = idempotent no-op; needs_review /
  // in-progress surfaces for review and never auto-retries.
  const prior = await readJob(campaignId)
  if (prior && prior.slotKey === emailSlot(campaignId)) return resolveExisting(prior)

  if (!SENDABLE_EMAIL.has(c.status)) throw new PublishingError('approve_before_sending')
  if (manualEmailBlockers(await getAutopilotConfig()).length) throw new PublishingError('email_not_connected_or_reviewed')

  const claim = await claimManual(campaignId, 'email', emailSlot(campaignId), now)
  if (!claim.claimed) return resolveExisting(claim.existing)

  try {
    // Recheck approval AFTER the durable claim: a pause/edit between preview and now must not publish.
    const [fresh] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId))
    if (!fresh || !SENDABLE_EMAIL.has(fresh.status) || contentFingerprint((fresh.emailSubject ?? '').trim(), (fresh.emailBody ?? '').trim()) !== contentHash) throw new PublishingError('approval_changed_after_claim')

    const provider = opts.email ?? new MailerLitePublisher(process.env.MAILERLITE_API_TOKEN ?? '', process.env.MARKETING_EMAIL_FROM ?? '', process.env.MAILERLITE_GROUP_ID ?? '')
    const before = await provider.audience()
    const audienceHash = audienceFingerprint(before)
    if (opts.expected?.audienceHash && opts.expected.audienceHash !== audienceHash) throw new PublishingError('audience_changed_since_preview')
    await assertAudienceAllowed(before)
    const draft = await provider.createDraft(emailSlot(campaignId), subject, body)
    const ref = draft.id
    // Persist the provider id BEFORE requesting delivery so a timeout can be reconciled, not resent.
    await db.update(jobs).set({ externalRef: ref, updatedAt: new Date() }).where(eq(jobs.id, campaignId))
    // Re-read the audience immediately before delivery; reject any change and recheck local opt-outs.
    const atSend = await provider.audience()
    if (audienceFingerprint(atSend) !== audienceHash) throw new PublishingError('audience_changed_before_send')
    await assertAudienceAllowed(atSend)
    const [fresh2] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId))
    if (!fresh2 || !SENDABLE_EMAIL.has(fresh2.status)) throw new PublishingError('approval_changed_after_claim')
    await provider.send(ref)
    await db.update(marketingCampaigns).set({ status: 'sending', dryRun: false, recipientCount: atSend.length, sentAt: new Date(), approvedBy: c.approvedBy ?? actor, updatedAt: new Date() }).where(eq(marketingCampaigns.id, campaignId))
    await db.update(jobs).set({ status: 'accepted', externalRef: ref, error: null, updatedAt: new Date() }).where(eq(jobs.id, campaignId))
    await logEvent('manual_email_sent', { entityType: 'campaign', entityId: campaignId, actor, meta: { providerRef: ref, audience: atSend.length } })
    return { status: 'accepted', externalRef: ref, audienceCount: atSend.length }
  } catch (error) {
    throw await blockManual(campaignId, error, actor)
  }
}

// ── Facebook ─────────────────────────────────────────────────────────────────

/** Read-only Page identity check for the preview. Truthful connection — never inferred from env presence. */
export async function facebookConnection(deps: { facebook?: FacebookVerifier } = {}): Promise<{ connected: boolean; pageName: string | null; pageId: string | null; error: string | null }> {
  const pageId = process.env.FACEBOOK_PAGE_ID ?? null
  if (manualFacebookBlockers().length) return { connected: false, pageName: null, pageId, error: 'facebook_not_connected' }
  try {
    const provider = deps.facebook ?? new FacebookPublisher(process.env.FACEBOOK_PAGE_ID ?? '', process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? '', process.env.FACEBOOK_GRAPH_VERSION ?? '')
    const name = await provider.verify()
    return { connected: true, pageName: name, pageId, error: null }
  } catch (e) {
    return { connected: false, pageName: null, pageId, error: e instanceof PublishingError ? e.code : 'facebook_verify_failed' }
  }
}

export async function facebookPublishReadiness(postId: string): Promise<FacebookReadiness> {
  const [p] = await getDb().select().from(marketingSocialPosts).where(eq(marketingSocialPosts.id, postId))
  const empty: FacebookReadiness = { found: false, copy: '', status: '', linkPreview: '', blockers: [], contentIssues: [], contentHash: '', job: null, canPublish: false }
  if (!p) return empty
  const copy = (p.copy ?? '').trim()
  const blockers = manualFacebookBlockers()
  const contentIssues: string[] = []
  if (!copy) contentIssues.push('Write the post copy first.')
  if (!PUBLISHABLE_POST.has(p.status)) contentIssues.push('Approve the post before publishing.')
  if (p.externalPostRef) contentIssues.push('This post already has a published reference.')
  if (p.beforePhotoId || p.afterPhotoId) contentIssues.push('Photo posts can’t be published here — post the image on Facebook directly, then record the link.')
  const job = jobView(await readJob(postId), facebookSlot(postId))
  if (job) contentIssues.push(jobIssue(job, 'published'))
  const canPublish = !blockers.length && !contentIssues.length && !job
  return { found: true, copy, status: p.status, linkPreview: 'A tracked link to pittstopdetailandautosales.com is appended automatically.', blockers, contentIssues, contentHash: contentFingerprint('', copy), job, canPublish }
}

export async function confirmPublishFacebook(postId: string, actor: string, opts: ConfirmFacebookOptions = {}, now = new Date()): Promise<ManualSendResult> {
  const db = getDb()
  const [p] = await db.select().from(marketingSocialPosts).where(eq(marketingSocialPosts.id, postId))
  if (!p) throw new PublishingError('post_not_found')
  const copy = (p.copy ?? '').trim()
  // Terminal states first so a re-submit of an already-published post reports the true reason.
  if (p.externalPostRef) throw new PublishingError('post_already_published')
  if (p.beforePhotoId || p.afterPhotoId) throw new PublishingError('photo_post_requires_manual_facebook')
  if (!copy) throw new PublishingError('post_content_empty')
  if (!PUBLISHABLE_POST.has(p.status)) throw new PublishingError('approve_before_publishing')
  const contentHash = contentFingerprint('', copy)
  if (opts.expected?.contentHash && opts.expected.contentHash !== contentHash) throw new PublishingError('content_changed_since_preview')
  if (manualFacebookBlockers().length) throw new PublishingError('facebook_not_connected')

  const claim = await claimManual(postId, 'facebook', facebookSlot(postId), now)
  if (!claim.claimed) return resolveExisting(claim.existing)

  try {
    // Recheck the exact approved copy/status after the durable claim.
    const [fresh] = await db.select().from(marketingSocialPosts).where(eq(marketingSocialPosts.id, postId))
    if (!fresh || !PUBLISHABLE_POST.has(fresh.status) || fresh.externalPostRef || contentFingerprint('', (fresh.copy ?? '').trim()) !== contentHash) throw new PublishingError('approval_changed_after_claim')
    const provider = opts.facebook ?? new FacebookPublisher(process.env.FACEBOOK_PAGE_ID ?? '', process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? '', process.env.FACEBOOK_GRAPH_VERSION ?? '')
    const ref = await provider.publish(copy, facebookSlot(postId))
    await db.update(marketingSocialPosts).set({ status: 'posted', externalPostRef: ref, approvedBy: p.approvedBy ?? actor, updatedAt: new Date() }).where(eq(marketingSocialPosts.id, postId))
    await db.update(jobs).set({ status: 'accepted', externalRef: ref, error: null, updatedAt: new Date() }).where(eq(jobs.id, postId))
    await logEvent('manual_facebook_published', { entityType: 'post', entityId: postId, actor, meta: { providerRef: ref } })
    return { status: 'accepted', externalRef: ref }
  } catch (error) {
    throw await blockManual(postId, error, actor)
  }
}

/** Human-readable text for a sanitized PublishingError/blocker code shown in the manager flash. */
export function manualErrorMessage(code: string): string {
  const map: Record<string, string> = {
    manual_send_in_progress: 'A send is already in progress or its outcome is unknown — inspect the provider before trying again. It will not retry automatically.',
    manual_send_needs_review: 'The last attempt needs review in the provider before it can be sent again.',
    manual_send_conflict: 'This item is managed elsewhere and cannot be sent manually.',
    email_not_connected_or_reviewed: 'Connect MailerLite and review the audience on the Launch page before sending.',
    approve_before_sending: 'Approve the email copy (mark Ready) before sending.',
    email_content_empty: 'The email needs a subject and body before sending.',
    content_changed_since_preview: 'The approved content changed since you previewed it. Re-open the preview and confirm the current version.',
    approval_changed_after_claim: 'The approval or content changed after you confirmed. Nothing was sent — re-open the preview and try again.',
    audience_changed_since_preview: 'The MailerLite audience changed since you previewed it. Re-open the preview to see the current audience before sending.',
    audience_changed_before_send: 'The MailerLite audience changed during sending, so delivery was stopped. Re-open the preview before trying again.',
    facebook_not_connected: 'Connect the Facebook Page before publishing.',
    approve_before_publishing: 'Approve the post before publishing.',
    post_already_published: 'This post already has a published reference.',
    photo_post_requires_manual_facebook: 'Photo posts must be published on Facebook directly, then record the link here.',
    email_http_422: 'MailerLite rejected the campaign. Check the verified sender, required content, audience, and plan access to API-created HTML email. MailerLite API documentation calls the required tier Advanced; current billing uses Power.',
    email_network_outcome_unknown: 'The email request timed out with an unknown outcome — check MailerLite before any retry. It will not retry automatically.',
    facebook_network_outcome_unknown: 'The Facebook request timed out with an unknown outcome — check the Page before any retry. It will not retry automatically.',
    email_audience_requires_local_review: 'A subscriber in the MailerLite group is not eligible locally (unsubscribed or inactive). Review the audience before sending.',
  }
  return map[code] ?? 'This action needs review before it can be completed. Check the provider; nothing was retried automatically.'
}
