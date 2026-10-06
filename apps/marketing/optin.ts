/**
 * Public SMS opt-in capture. Turns a real, affirmative opt-in (an unchecked-by-default checkbox the
 * customer ticks) into PROVEN consent: it matches or creates a directory customer and records a
 * grantSmsConsent event with the exact disclosure wording/version, source, and request metadata.
 *
 * This is the acquisition mechanism an A2P 10DLC campaign points at. It never grants consent unless
 * the caller passes agreed=true, and it never manufactures consent for anyone who didn't opt in.
 */
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { customers } from '@/apps/directory/schema'
import { grantSmsConsent, type ConsentSource } from './consent'

/** Directory-compatible phone normalization: digits only, drop US leading 1 → 10-digit key. */
export function normalizePhone(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
}

export class InvalidPhoneError extends Error { constructor() { super('A valid 10-digit US phone number is required.') } }
export class ConsentNotGivenError extends Error { constructor() { super('The opt-in box must be checked to subscribe.') } }

export interface OptInInput {
  agreed: boolean
  phone: string
  name?: string | null
  consentText: string
  wordingVersion: string
  source?: ConsentSource
  ip?: string | null
  userAgent?: string | null
}

export interface OptInResult { customerId: string; matchedExisting: boolean; normalizedPhone: string }

export async function recordPublicOptIn(input: OptInInput): Promise<OptInResult> {
  if (!input.agreed) throw new ConsentNotGivenError()
  const normalized = normalizePhone(input.phone)
  if (normalized.length !== 10) throw new InvalidPhoneError()

  const db = getDb()
  // Match an existing active customer by normalized phone (never by name).
  const [existing] = await db.select({ id: customers.id }).from(customers)
    .where(and(eq(customers.normalizedPhone, normalized), eq(customers.active, true))).limit(1)

  let customerId: string
  let matchedExisting = false
  if (existing) {
    customerId = existing.id
    matchedExisting = true
  } else {
    // Create a prospect. sourceKey dedupes repeat opt-ins from the same number.
    const [created] = await db.insert(customers).values({
      displayName: (input.name ?? '').trim() || `SMS opt-in ${normalized.slice(-4)}`,
      phone: input.phone.trim(),
      normalizedPhone: normalized,
      customerType: 'prospect',
      source: 'manual',
      sourceKey: `sms-optin:${normalized}`,
    }).onConflictDoNothing().returning({ id: customers.id })
    if (created) {
      customerId = created.id
    } else {
      // Race / prior opt-in with same sourceKey — fetch it.
      const [again] = await db.select({ id: customers.id }).from(customers)
        .where(eq(customers.sourceKey, `sms-optin:${normalized}`)).limit(1)
      customerId = again?.id ?? (await db.select({ id: customers.id }).from(customers)
        .where(eq(customers.normalizedPhone, normalized)).limit(1))[0].id
    }
  }

  await grantSmsConsent(customerId, {
    source: input.source ?? 'website_form',
    wordingVersion: input.wordingVersion,
    consentText: input.consentText,
    phone: input.phone.trim(),
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  })

  return { customerId, matchedExisting, normalizedPhone: normalized }
}

/** Count of customers with proven promotional-SMS consent (for the A2P readiness panel). */
export async function smsSubscriberCount(): Promise<number> {
  const { marketingPreferences } = await import('./schema')
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(marketingPreferences)
    .where(and(eq(marketingPreferences.smsConsentStatus, 'granted'), sql`${marketingPreferences.smsEligible} = true`, sql`${marketingPreferences.unsubscribedAt} is null`))
  return row?.n ?? 0
}
