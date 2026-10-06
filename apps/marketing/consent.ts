/**
 * Marketing consent.
 *
 * EMAIL: eligible by the existing-customer relationship unless the customer unsubscribes.
 * SMS (A2P/TCPA): eligible ONLY with proven opt-in — `sms_consent_status = 'granted'`. A present phone
 *   number is NOT consent; the default status is 'unknown' (not eligible). Historical/imported numbers
 *   never silently qualify. Every grant/revoke is appended to marketing_consent_events (audit trail).
 */
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingPreferences, marketingConsentEvents } from './schema'
import { logEvent } from './events'
import { SMS_OPT_IN_VERSION } from './compliance'

export type Preferences = typeof marketingPreferences.$inferSelect
export type ConsentEvent = typeof marketingConsentEvents.$inferSelect
export type UnsubscribeScope = 'all' | 'sms' | 'email'
export type SmsConsentStatus = 'unknown' | 'granted' | 'revoked'

export type ConsentSource =
  | 'website_form' | 'in_store' | 'customer_portal' | 'imported' | 'sms_keyword' | 'manager' | 'lead_form'

export async function getPreferences(customerId: string): Promise<Preferences | null> {
  const [row] = await getDb().select().from(marketingPreferences).where(eq(marketingPreferences.customerId, customerId)).limit(1)
  return row ?? null
}

/** Ensure a preferences row exists (so there is an unsubscribe token to build a link with). */
export async function ensurePreferences(customerId: string): Promise<Preferences> {
  const existing = await getPreferences(customerId)
  if (existing) return existing
  const [row] = await getDb().insert(marketingPreferences)
    .values({ customerId })
    .onConflictDoUpdate({ target: marketingPreferences.customerId, set: { updatedAt: new Date() } })
    .returning()
  return row
}

/** Append a consent event to the audit trail (never updated/deleted). */
export async function recordConsentEvent(input: {
  customerId: string
  channel: 'sms' | 'email'
  event: 'opt_in' | 'opt_out' | 'import_verified' | 'help'
  source: ConsentSource
  wordingVersion?: string | null
  consentText?: string | null
  phone?: string | null
  actor?: string | null
  ip?: string | null
  userAgent?: string | null
  meta?: Record<string, unknown>
}): Promise<ConsentEvent> {
  const [row] = await getDb().insert(marketingConsentEvents).values({
    customerId: input.customerId,
    channel: input.channel,
    event: input.event,
    source: input.source,
    wordingVersion: input.wordingVersion ?? null,
    consentText: input.consentText ?? null,
    phone: input.phone ?? null,
    actor: input.actor ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    meta: input.meta ?? null,
  }).returning()
  return row
}

export async function listConsentEvents(customerId: string): Promise<ConsentEvent[]> {
  return getDb().select().from(marketingConsentEvents)
    .where(eq(marketingConsentEvents.customerId, customerId))
    .orderBy(desc(marketingConsentEvents.createdAt))
}

/**
 * Grant promotional-SMS consent (proven opt-in). Records the audit event AND sets the resolved status.
 * `source` must reflect a real acquisition mechanism — never manufacture historical consent.
 */
export async function grantSmsConsent(customerId: string, opts: {
  source: ConsentSource
  wordingVersion?: string
  consentText?: string | null
  phone?: string | null
  actor?: string | null
  ip?: string | null
  userAgent?: string | null
}): Promise<Preferences> {
  await recordConsentEvent({ customerId, channel: 'sms', event: 'opt_in', ...opts, wordingVersion: opts.wordingVersion ?? SMS_OPT_IN_VERSION })
  const now = new Date()
  const [row] = await getDb().insert(marketingPreferences)
    .values({ customerId, smsConsentStatus: 'granted', smsConsentSource: opts.source, smsConsentAt: now, smsConsentVersion: opts.wordingVersion ?? SMS_OPT_IN_VERSION })
    .onConflictDoUpdate({
      target: marketingPreferences.customerId,
      set: { smsConsentStatus: 'granted', smsConsentSource: opts.source, smsConsentAt: now, smsConsentVersion: opts.wordingVersion ?? SMS_OPT_IN_VERSION, updatedAt: now },
    }).returning()
  await logEvent('eligibility_changed', { entityType: 'customer', entityId: customerId, actor: opts.actor ?? null, meta: { smsConsent: 'granted', source: opts.source } })
  return row
}

/** Revoke promotional-SMS consent (STOP keyword, manager, etc.). Records the audit event. */
export async function revokeSmsConsent(customerId: string, opts: { source: ConsentSource; actor?: string | null; phone?: string | null; reason?: string | null } = { source: 'manager' }): Promise<void> {
  await recordConsentEvent({ customerId, channel: 'sms', event: 'opt_out', source: opts.source, phone: opts.phone ?? null, actor: opts.actor ?? null, meta: opts.reason ? { reason: opts.reason } : undefined })
  const now = new Date()
  await getDb().insert(marketingPreferences)
    .values({ customerId, smsConsentStatus: 'revoked' })
    .onConflictDoUpdate({ target: marketingPreferences.customerId, set: { smsConsentStatus: 'revoked', updatedAt: now } })
  await logEvent('eligibility_changed', { entityType: 'customer', entityId: customerId, actor: opts.actor ?? null, meta: { smsConsent: 'revoked', source: opts.source } })
}

/** True only when the customer has proven, current SMS consent. */
export function hasSmsConsent(pref: Pick<Preferences, 'smsConsentStatus' | 'smsEligible' | 'unsubscribedAt'> | null): boolean {
  if (!pref) return false
  return pref.smsConsentStatus === 'granted' && pref.smsEligible !== false && !pref.unsubscribedAt
}

/** Manager override of channel eligibility (hard block/unblock). Does NOT grant SMS consent. */
export async function setEligibility(customerId: string, patch: { smsEligible?: boolean; emailEligible?: boolean }, actor: string | null): Promise<Preferences> {
  const [row] = await getDb().insert(marketingPreferences)
    .values({ customerId, smsEligible: patch.smsEligible ?? true, emailEligible: patch.emailEligible ?? true })
    .onConflictDoUpdate({ target: marketingPreferences.customerId, set: { ...patch, updatedAt: new Date() } })
    .returning()
  await logEvent('eligibility_changed', { entityType: 'customer', entityId: customerId, actor, meta: patch })
  return row
}

/** Public unsubscribe via token (the link in a message). Idempotent. Revokes SMS consent in-scope. */
export async function unsubscribeByToken(token: string, opts: { reason?: string | null; scope?: UnsubscribeScope; source?: ConsentSource } = {}): Promise<{ ok: boolean; customerId?: string }> {
  const [row] = await getDb().select().from(marketingPreferences).where(eq(marketingPreferences.unsubscribeToken, token)).limit(1)
  if (!row) return { ok: false }
  const scope = opts.scope ?? 'all'
  const revokesSms = scope === 'all' || scope === 'sms'
  await getDb().update(marketingPreferences).set({
    unsubscribedAt: row.unsubscribedAt ?? new Date(),
    unsubscribeReason: opts.reason ?? row.unsubscribeReason ?? 'customer_request',
    unsubscribeScope: scope,
    smsEligible: scope === 'email' ? row.smsEligible : false,
    emailEligible: scope === 'sms' ? row.emailEligible : false,
    smsConsentStatus: revokesSms ? 'revoked' : row.smsConsentStatus,
    updatedAt: new Date(),
  }).where(eq(marketingPreferences.id, row.id))
  if (revokesSms) await recordConsentEvent({ customerId: row.customerId, channel: 'sms', event: 'opt_out', source: opts.source ?? 'customer_portal', meta: { viaToken: true, scope } })
  await logEvent('unsubscribe', { entityType: 'customer', entityId: row.customerId, meta: { scope, viaToken: true } })
  return { ok: true, customerId: row.customerId }
}

/** Manager resubscribe (e.g. re-captured verbal/written consent). Re-grants SMS consent explicitly. */
export async function resubscribe(customerId: string, actor: string | null, opts: { regrantSms?: boolean; source?: ConsentSource } = {}): Promise<void> {
  const now = new Date()
  await getDb().update(marketingPreferences).set({
    unsubscribedAt: null, unsubscribeReason: null, smsEligible: true, emailEligible: true,
    ...(opts.regrantSms ? { smsConsentStatus: 'granted', smsConsentSource: opts.source ?? 'manager', smsConsentAt: now } : {}),
    updatedAt: now,
  }).where(eq(marketingPreferences.customerId, customerId))
  if (opts.regrantSms) await recordConsentEvent({ customerId, channel: 'sms', event: 'opt_in', source: opts.source ?? 'manager', actor })
  await logEvent('eligibility_changed', { entityType: 'customer', entityId: customerId, actor, meta: { resubscribed: true, regrantSms: !!opts.regrantSms } })
}
