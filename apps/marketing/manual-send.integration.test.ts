import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
vi.mock('./autopilot-config', async (importOriginal) => ({ ...await importOriginal<object>(), getAutopilotConfig: vi.fn() }))
vi.mock('./ai/client', () => ({ aiConfigured: () => false }))

import { getDb } from '@/platform/db'
import { getAutopilotConfig, type AutopilotConfig } from './autopilot-config'
import { AUTOPILOT_POLICY } from './autopilot-plan'
import {
  emailSendReadiness, confirmSendEmail, facebookPublishReadiness, confirmPublishFacebook, manualEmailBlockers,
  contentFingerprint, audienceFingerprint,
} from './manual-send'
import { previewCampaign } from './campaigns'
import { PublishingError } from './providers/publishing'

const pg = new PGlite()
const person = { id: '88', email: 'customer@example.com', status: 'active' }

beforeAll(async () => {
  await pg.exec('CREATE TABLE customers(id uuid PRIMARY KEY,email text,normalized_email text,active boolean DEFAULT true); CREATE TABLE service_orders(id uuid PRIMARY KEY);')
  for (const file of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0048_marketing_sms_delivery.sql', '0049_marketing_autopilot.sql']) await pg.exec(readFileSync(`drizzle/migrations/manual/${file}`, 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
  await pg.exec('TRUNCATE marketing_campaigns,marketing_social_posts,marketing_automation_jobs,marketing_events,marketing_preferences,customers CASCADE')
  const cfg: AutopilotConfig = { enabled: false, emailLive: false, facebookLive: false, policy: AUTOPILOT_POLICY, launchDate: '2026-10-07', audienceReviewed: true, emailTestVerified: false, facebookTestVerified: false }
  vi.mocked(getAutopilotConfig).mockImplementation(async () => ({ ...cfg }))
  // Manual sending must NOT require CRON_SECRET / autopilot — only the channel connection + review.
  for (const [k, v] of Object.entries({ MAILERLITE_API_TOKEN: 'secret', MAILERLITE_GROUP_ID: '42', MARKETING_EMAIL_FROM: 'shop@example.com', FACEBOOK_PAGE_ID: '123', FACEBOOK_PAGE_ACCESS_TOKEN: 'secret', FACEBOOK_GRAPH_VERSION: 'v25.0' })) vi.stubEnv(k, v)
})

async function emailCampaign(status = 'ready'): Promise<string> {
  const id = randomUUID()
  await pg.query("INSERT INTO marketing_campaigns(id,name,channel,status,email_subject,email_body,dry_run) VALUES($1,$2,'email',$3,$4,$5,true)",
    [id, 'Manual email', status, 'A fresh start for your vehicle', 'Reply with your year, make, and model for an estimate.'])
  return id
}
async function post(status = 'approved'): Promise<string> {
  const id = randomUUID()
  await pg.query("INSERT INTO marketing_social_posts(id,pillar,copy,status) VALUES($1,'educate',$2,$3)", [id, 'Ask us about a fall detail for your vehicle.', status])
  return id
}
async function customer(email = person.email): Promise<string> {
  const id = randomUUID(); await pg.query('INSERT INTO customers(id,email) VALUES($1,$2)', [id, email]); return id
}
function emailProvider() {
  return { audience: vi.fn().mockResolvedValue([person]), createDraft: vi.fn().mockResolvedValue({ id: '555' }), send: vi.fn().mockResolvedValue(undefined) }
}
const jobRow = async (id: string) => (await pg.query<{ status: string; external_ref: string | null; slot_key: string }>('SELECT status,external_ref,slot_key FROM marketing_automation_jobs WHERE id=$1', [id])).rows[0]
const campaignRow = async (id: string) => (await pg.query<{ status: string; dry_run: boolean; recipient_count: number }>('SELECT status,dry_run,recipient_count FROM marketing_campaigns WHERE id=$1', [id])).rows[0]

describe('manual email send', () => {
  it('readiness surfaces the authoritative MailerLite audience count + no blockers', async () => {
    const id = await emailCampaign(); await customer()
    const r = await emailSendReadiness(id, { email: emailProvider() })
    expect(r.found).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.contentIssues).toEqual([])
    expect(r.audience).toEqual({ count: 1, ok: true, error: null })
    expect(r.canSend).toBe(true)
  })

  it('connection blockers are visible and do not require cron/autopilot', () => {
    expect(manualEmailBlockers({ audienceReviewed: true }, {})).toContain('Connect MailerLite and a verified sender (server credentials).')
    expect(manualEmailBlockers({ audienceReviewed: false }, { MAILERLITE_API_TOKEN: 'x', MAILERLITE_GROUP_ID: '1', MARKETING_EMAIL_FROM: 'a@b.co' }))
      .toEqual(['Review the email audience and previous opt-outs on the Launch page first.'])
  })

  it('confirm sends once, marks the campaign live (not dry-run), and claims accepted', async () => {
    const id = await emailCampaign(); await customer(); const provider = emailProvider()
    const res = await confirmSendEmail(id, 'Manager Mia', { email: provider })
    expect(res).toMatchObject({ status: 'accepted', externalRef: '555', audienceCount: 1 })
    expect(provider.send).toHaveBeenCalledTimes(1)
    expect(await campaignRow(id)).toMatchObject({ status: 'sending', dry_run: false, recipient_count: 1 })
    expect(await jobRow(id)).toMatchObject({ status: 'accepted', external_ref: '555', slot_key: `manual-email-${id}` })
  })

  it('a duplicate confirm is an idempotent no-op — never a second provider send', async () => {
    const id = await emailCampaign(); await customer(); const provider = emailProvider()
    await confirmSendEmail(id, 'Mia', { email: provider })
    const again = await confirmSendEmail(id, 'Mia', { email: provider })
    expect(again).toMatchObject({ status: 'accepted', alreadySent: true })
    expect(provider.send).toHaveBeenCalledTimes(1)
  })

  it('an unknown network outcome blocks for review and never auto-retries', async () => {
    const id = await emailCampaign(); await customer()
    const provider = emailProvider(); provider.send.mockRejectedValue(new PublishingError('email_network_outcome_unknown'))
    await expect(confirmSendEmail(id, 'Mia', { email: provider })).rejects.toThrow('email_network_outcome_unknown')
    expect(await jobRow(id)).toMatchObject({ status: 'needs_review', external_ref: '555' }) // provider id persisted before send
    expect(await campaignRow(id)).toMatchObject({ status: 'ready', dry_run: true })            // not marked sent
    // A retry refuses (claim already needs_review) and does not touch the provider again.
    await expect(confirmSendEmail(id, 'Mia', { email: provider })).rejects.toThrow('email_network_outcome_unknown')
    expect(provider.send).toHaveBeenCalledTimes(1)
  })

  it('respects unsubscribe: an ineligible local record stops the send', async () => {
    const id = await emailCampaign(); const cid = await customer()
    await pg.query('INSERT INTO marketing_preferences(customer_id,email_eligible) VALUES($1,false)', [cid])
    const r = await emailSendReadiness(id, { email: emailProvider() })
    expect(r.audience?.ok).toBe(false)
    expect(r.canSend).toBe(false)
    await expect(confirmSendEmail(id, 'Mia', { email: emailProvider() })).rejects.toBeInstanceOf(PublishingError)
    expect(await jobRow(id)).toMatchObject({ status: 'needs_review' })
  })

  it('requires approved content — a draft cannot be sent', async () => {
    const id = await emailCampaign('draft'); await customer()
    await expect(confirmSendEmail(id, 'Mia', { email: emailProvider() })).rejects.toThrow('approve_before_sending')
    expect(await jobRow(id)).toBeUndefined() // no claim created for an unsendable item
  })
})

describe('preview binding — exact content + audience fingerprints', () => {
  it('rejects a content edit since preview (before any claim)', async () => {
    const id = await emailCampaign(); await customer()
    await expect(confirmSendEmail(id, 'Mia', { email: emailProvider(), expected: { contentHash: contentFingerprint('Stale subject', 'Stale body') } }))
      .rejects.toThrow('content_changed_since_preview')
    expect(await jobRow(id)).toBeUndefined() // never claimed
  })

  it('rejects an audience change since preview', async () => {
    const id = await emailCampaign(); await customer()
    const provider = emailProvider()
    await expect(confirmSendEmail(id, 'Mia', { email: provider, expected: { audienceHash: 'f'.repeat(64) } }))
      .rejects.toThrow('audience_changed_since_preview')
    expect(await jobRow(id)).toMatchObject({ status: 'needs_review' })
    expect(provider.send).not.toHaveBeenCalled()
  })

  it('rejects an audience change between draft creation and send', async () => {
    const id = await emailCampaign(); await customer()
    const other = { id: '99', email: 'other@example.com', status: 'active' }
    const provider = {
      audience: vi.fn().mockResolvedValueOnce([person]).mockResolvedValueOnce([person, other]),
      createDraft: vi.fn().mockResolvedValue({ id: '555' }), send: vi.fn().mockResolvedValue(undefined),
    }
    // Matches the first (preview-equivalent) audience, but the audience changes before the send.
    await expect(confirmSendEmail(id, 'Mia', { email: provider, expected: { audienceHash: audienceFingerprint([person]) } }))
      .rejects.toThrow('audience_changed_before_send')
    expect(provider.send).not.toHaveBeenCalled()
    expect(await jobRow(id)).toMatchObject({ status: 'needs_review', external_ref: '555' })
  })
})

describe('needs_review disables readiness (no clickable send/publish)', () => {
  it('email readiness is not sendable once a prior attempt needs review', async () => {
    const id = await emailCampaign(); await customer()
    const provider = emailProvider(); provider.send.mockRejectedValue(new PublishingError('email_network_outcome_unknown'))
    await expect(confirmSendEmail(id, 'Mia', { email: provider })).rejects.toThrow()
    const r = await emailSendReadiness(id, { email: emailProvider() })
    expect(r.job?.status).toBe('needs_review')
    expect(r.canSend).toBe(false)
    expect(r.contentIssues.join(' ')).toMatch(/review/i)
  })

  it('facebook readiness is not publishable once a prior attempt needs review', async () => {
    const id = await post()
    const provider = { publish: vi.fn().mockRejectedValue(new PublishingError('facebook_network_outcome_unknown')) }
    await expect(confirmPublishFacebook(id, 'Mia', { facebook: provider })).rejects.toThrow()
    const r = await facebookPublishReadiness(id)
    expect(r.job?.status).toBe('needs_review')
    expect(r.canPublish).toBe(false)
    expect(r.contentIssues.join(' ')).toMatch(/review/i)
  })
})

describe('the dry-run preview stays a dry-run and never touches the manual path', () => {
  it('previewCampaign writes nothing: no manual job, campaign stays dry_run', async () => {
    const id = await emailCampaign()
    const preview = await previewCampaign(id)
    expect(preview.dryRun).toBe(true)
    expect(await jobRow(id)).toBeUndefined()
    expect(await campaignRow(id)).toMatchObject({ dry_run: true })
  })
})

describe('manual Facebook publish', () => {
  it('publishes approved copy once and records the reference', async () => {
    const id = await post(); const provider = { publish: vi.fn().mockResolvedValue('123_456') }
    const r = await facebookPublishReadiness(id)
    expect(r.canPublish).toBe(true)
    const res = await confirmPublishFacebook(id, 'Mia', { facebook: provider })
    expect(res).toMatchObject({ status: 'accepted', externalRef: '123_456' })
    expect(provider.publish).toHaveBeenCalledTimes(1)
    const p = (await pg.query<{ status: string; external_post_ref: string }>('SELECT status,external_post_ref FROM marketing_social_posts WHERE id=$1', [id])).rows[0]
    expect(p).toMatchObject({ status: 'posted', external_post_ref: '123_456' })
    expect(await jobRow(id)).toMatchObject({ status: 'accepted', slot_key: `manual-facebook-${id}` })
  })

  it('does not double-publish an already-published post', async () => {
    const id = await post(); const provider = { publish: vi.fn().mockResolvedValue('123_456') }
    await confirmPublishFacebook(id, 'Mia', { facebook: provider })
    await expect(confirmPublishFacebook(id, 'Mia', { facebook: provider })).rejects.toThrow('post_already_published')
    expect(provider.publish).toHaveBeenCalledTimes(1)
  })

  it('an unknown outcome blocks for review with no automatic retry', async () => {
    const id = await post(); const provider = { publish: vi.fn().mockRejectedValue(new PublishingError('facebook_network_outcome_unknown')) }
    await expect(confirmPublishFacebook(id, 'Mia', { facebook: provider })).rejects.toThrow('facebook_network_outcome_unknown')
    expect(await jobRow(id)).toMatchObject({ status: 'needs_review' })
    await expect(confirmPublishFacebook(id, 'Mia', { facebook: provider })).rejects.toThrow('facebook_network_outcome_unknown')
    expect(provider.publish).toHaveBeenCalledTimes(1)
  })

  it('refuses photo posts (image upload is not supported on this text path)', async () => {
    const id = randomUUID()
    await pg.query("INSERT INTO marketing_social_posts(id,pillar,copy,status,before_photo_id) VALUES($1,'proof','Look at this',$2,$3)", [id, 'approved', randomUUID()])
    const r = await facebookPublishReadiness(id)
    expect(r.canPublish).toBe(false)
    await expect(confirmPublishFacebook(id, 'Mia', { facebook: { publish: vi.fn() } })).rejects.toThrow('photo_post_requires_manual_facebook')
  })
})
