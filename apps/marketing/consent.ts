/**
 * Marketing consent. A customer is eligible by default (existing relationship) UNLESS they have
 * unsubscribed or we lack a contact method — but the moment anyone opts out it is recorded here and
 * the campaign builder (campaigns.ts) excludes them. Unsubscribe is idempotent and audited.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingPreferences } from './schema'
import { logEvent } from './events'

export type Preferences = typeof marketingPreferences.$inferSelect
export type UnsubscribeScope = 'all' | 'sms' | 'email'

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

/** Manager override of channel eligibility. Audited. */
export async function setEligibility(customerId: string, patch: { smsEligible?: boolean; emailEligible?: boolean }, actor: string | null): Promise<Preferences> {
  const [row] = await getDb().insert(marketingPreferences)
    .values({ customerId, smsEligible: patch.smsEligible ?? true, emailEligible: patch.emailEligible ?? true })
    .onConflictDoUpdate({ target: marketingPreferences.customerId, set: { ...patch, updatedAt: new Date() } })
    .returning()
  await logEvent('eligibility_changed', { entityType: 'customer', entityId: customerId, actor, meta: patch })
  return row
}

/** Public unsubscribe via token (the link in a message). Idempotent — repeated calls are safe. */
export async function unsubscribeByToken(token: string, opts: { reason?: string | null; scope?: UnsubscribeScope } = {}): Promise<{ ok: boolean; customerId?: string }> {
  const [row] = await getDb().select().from(marketingPreferences).where(eq(marketingPreferences.unsubscribeToken, token)).limit(1)
  if (!row) return { ok: false }
  const scope = opts.scope ?? 'all'
  await getDb().update(marketingPreferences).set({
    unsubscribedAt: row.unsubscribedAt ?? new Date(),
    unsubscribeReason: opts.reason ?? row.unsubscribeReason ?? 'customer_request',
    unsubscribeScope: scope,
    smsEligible: scope === 'email' ? row.smsEligible : false,
    emailEligible: scope === 'sms' ? row.emailEligible : false,
    updatedAt: new Date(),
  }).where(eq(marketingPreferences.id, row.id))
  await logEvent('unsubscribe', { entityType: 'customer', entityId: row.customerId, meta: { scope, viaToken: true } })
  return { ok: true, customerId: row.customerId }
}

/** Manager resubscribe (e.g. verbal consent re-captured). Audited. */
export async function resubscribe(customerId: string, actor: string | null): Promise<void> {
  await getDb().update(marketingPreferences).set({
    unsubscribedAt: null, unsubscribeReason: null, smsEligible: true, emailEligible: true, updatedAt: new Date(),
  }).where(eq(marketingPreferences.customerId, customerId))
  await logEvent('eligibility_changed', { entityType: 'customer', entityId: customerId, actor, meta: { resubscribed: true } })
}
