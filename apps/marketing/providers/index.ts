/**
 * Provider abstraction layer. Marketing talks to SMS / Email / Facebook / Google Ads ONLY through
 * these interfaces, so a real provider can be dropped in later without touching the campaign engine.
 *
 * V1 reality (see docs/marketing-agent-v1.md):
 *   • SMS   — no Twilio/number exists in this repo → DryRun adapter (nothing sends).
 *   • Email — the only real email channel in Pitt Stop is QuickBooks' native send (CLAUDE.md); there
 *             is no ESP. Marketing email is DryRun until an ESP (or a QB bridge) is configured.
 *   • Facebook / Google Ads — no Meta/Google credentials → DryRun + manual-import.
 *
 * A DryRun send NEVER contacts an external service and is reported as status:'dry_run' (not 'sent'),
 * so the system never pretends a message went out. getProviders() inspects env for real credentials
 * and only returns a live adapter when they are present (none are, today).
 */

import { TwilioSmsProvider, twilioConfigFromEnv } from './twilio'

export type SendStatus = 'sent' | 'dry_run' | 'failed'
export interface SendResult { status: SendStatus; providerMessageId?: string; error?: string }

export interface SmsProvider {
  readonly name: string
  readonly live: boolean
  send(to: string, body: string): Promise<SendResult>
}

export interface EmailProvider {
  readonly name: string
  readonly live: boolean
  send(to: string, subject: string, body: string): Promise<SendResult>
}

export interface FacebookPublishResult { status: SendStatus; postRef?: string; error?: string }
export interface FacebookComment { externalRef: string; authorName: string; message: string }
export interface FacebookProvider {
  readonly name: string
  readonly live: boolean
  publishPost(copy: string, opts?: { imageUrls?: string[] }): Promise<FacebookPublishResult>
  fetchComments(): Promise<FacebookComment[]>
}

export interface GoogleAdsRow {
  serviceCategory: string
  statDate: string
  spendCents: number
  impressions: number
  clicks: number
  conversions: number
}
export interface GoogleAdsProvider {
  readonly name: string
  readonly live: boolean
  fetchMetrics(range: { from: string; to: string }): Promise<GoogleAdsRow[]>
}

// ── Dry-run adapters (never touch the network) ───────────────────────────────

// Dry-run impls take no args; a 0-arg method is assignable to the interface's wider signature, so
// these satisfy SmsProvider/EmailProvider/etc. while staying lint-clean. Call them via the interface
// type (getProviders()) — never contact the network.
export class DryRunSmsProvider implements SmsProvider {
  readonly name = 'dry-run-sms'
  readonly live = false
  async send(): Promise<SendResult> { return { status: 'dry_run' } }
}

export class DryRunEmailProvider implements EmailProvider {
  readonly name = 'dry-run-email'
  readonly live = false
  async send(): Promise<SendResult> { return { status: 'dry_run' } }
}

export class DryRunFacebookProvider implements FacebookProvider {
  readonly name = 'dry-run-facebook'
  readonly live = false
  async publishPost(): Promise<FacebookPublishResult> { return { status: 'dry_run' } }
  async fetchComments(): Promise<FacebookComment[]> { return [] }
}

export class DryRunGoogleAdsProvider implements GoogleAdsProvider {
  readonly name = 'dry-run-google-ads'
  readonly live = false
  async fetchMetrics(): Promise<GoogleAdsRow[]> { return [] }
}

export interface Providers {
  sms: SmsProvider
  email: EmailProvider
  facebook: FacebookProvider
  googleAds: GoogleAdsProvider
}

export interface ProviderStatus {
  sms: boolean
  email: boolean
  facebook: boolean
  googleAds: boolean
}

/**
 * Resolve the active providers. Today every branch is dry-run because no credentials exist in the
 * repo; the env checks document EXACTLY what turns each channel live. Adding a real provider means
 * implementing the interface and returning it here — nothing else in the module changes.
 */
export function getProviders(env: NodeJS.ProcessEnv = process.env): Providers {
  // Real Twilio SMS when a Messaging Service (or from-number) + credentials are present; else dry-run.
  const twilioCfg = twilioConfigFromEnv(env)
  const sms: SmsProvider = twilioCfg ? new TwilioSmsProvider(twilioCfg) : new DryRunSmsProvider()

  const email: EmailProvider = env.MARKETING_EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY
    ? new DryRunEmailProvider() // placeholder: real ResendEmailProvider slots in here once wired + reviewed
    : new DryRunEmailProvider()

  const facebook: FacebookProvider = env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_ACCESS_TOKEN
    ? new DryRunFacebookProvider()
    : new DryRunFacebookProvider()

  const googleAds: GoogleAdsProvider = env.GOOGLE_ADS_DEVELOPER_TOKEN && env.GOOGLE_ADS_CUSTOMER_ID
    ? new DryRunGoogleAdsProvider()
    : new DryRunGoogleAdsProvider()

  return { sms, email, facebook, googleAds }
}

export function providerStatus(p: Providers): ProviderStatus {
  return { sms: p.sms.live, email: p.email.live, facebook: p.facebook.live, googleAds: p.googleAds.live }
}

/** All-dry-run providers — used to FORCE a preview send even when live credentials exist. */
export function dryRunProviders(): Providers {
  return { sms: new DryRunSmsProvider(), email: new DryRunEmailProvider(), facebook: new DryRunFacebookProvider(), googleAds: new DryRunGoogleAdsProvider() }
}
