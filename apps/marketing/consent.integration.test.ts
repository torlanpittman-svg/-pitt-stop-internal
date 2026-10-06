import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import {
  ensurePreferences, grantSmsConsent, revokeSmsConsent, hasSmsConsent, getPreferences,
  listConsentEvents, unsubscribeByToken, recordConsentEvent,
} from './consent'

const pg = new PGlite()
const PARENTS = `
  CREATE TABLE customers (id uuid PRIMARY KEY, display_name text, phone text, email text, active boolean NOT NULL DEFAULT true);
  CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text);
`
const cust = randomUUID()

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0047_marketing_sms_consent.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec('DELETE FROM marketing_consent_events; DELETE FROM marketing_preferences; DELETE FROM marketing_events; DELETE FROM customers;')
  await pg.query('INSERT INTO customers (id, display_name, phone) VALUES ($1,$2,$3)', [cust, 'Consent Test', '+15125550123'])
})

describe('SMS consent model (phone != consent)', () => {
  it('unknown consent is NOT eligible, even with a preferences row and a phone', async () => {
    await ensurePreferences(cust)
    const pref = await getPreferences(cust)
    expect(pref?.smsConsentStatus).toBe('unknown')
    expect(hasSmsConsent(pref)).toBe(false)
  })

  it('granting consent sets status + records an auditable opt_in event with source and version', async () => {
    await grantSmsConsent(cust, { source: 'website_form', phone: '+15125550123', consentText: 'I agree...', actor: 'self' })
    const pref = await getPreferences(cust)
    expect(pref?.smsConsentStatus).toBe('granted')
    expect(pref?.smsConsentSource).toBe('website_form')
    expect(pref?.smsConsentAt).toBeTruthy()
    expect(hasSmsConsent(pref)).toBe(true)

    const events = await listConsentEvents(cust)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('opt_in')
    expect(events[0].channel).toBe('sms')
    expect(events[0].source).toBe('website_form')
    expect(events[0].wordingVersion).toBeTruthy()
  })

  it('STOP/revoke immediately makes the contact ineligible and logs opt_out', async () => {
    await grantSmsConsent(cust, { source: 'website_form' })
    await revokeSmsConsent(cust, { source: 'sms_keyword', reason: 'STOP' })
    const pref = await getPreferences(cust)
    expect(pref?.smsConsentStatus).toBe('revoked')
    expect(hasSmsConsent(pref)).toBe(false)
    const events = await listConsentEvents(cust)
    expect(events[0].event).toBe('opt_out') // most recent first
  })

  it('re-granting after revoke restores eligibility (START/UNSTOP flow)', async () => {
    await grantSmsConsent(cust, { source: 'website_form' })
    await revokeSmsConsent(cust, { source: 'sms_keyword' })
    await grantSmsConsent(cust, { source: 'sms_keyword' }) // START
    const pref = await getPreferences(cust)
    expect(pref?.smsConsentStatus).toBe('granted')
    expect(hasSmsConsent(pref)).toBe(true)
    expect((await listConsentEvents(cust)).length).toBe(3) // full audit trail preserved
  })

  it('a manager hard-block (smsEligible=false) overrides even granted consent', async () => {
    await grantSmsConsent(cust, { source: 'website_form' })
    const pref = await getPreferences(cust)
    expect(hasSmsConsent(pref)).toBe(true)
    expect(hasSmsConsent({ ...pref!, smsEligible: false })).toBe(false)
  })

  it('unsubscribeByToken revokes SMS consent and records the opt_out', async () => {
    const pref = await ensurePreferences(cust)
    await grantSmsConsent(cust, { source: 'website_form' })
    const res = await unsubscribeByToken(pref.unsubscribeToken)
    expect(res.ok).toBe(true)
    const after = await getPreferences(cust)
    expect(after?.smsConsentStatus).toBe('revoked')
    expect(after?.unsubscribedAt).toBeTruthy()
    const optOut = (await listConsentEvents(cust)).find((e) => e.event === 'opt_out')
    expect(optOut).toBeTruthy()
  })

  it('import_verified events never manufacture consent on their own', async () => {
    // Recording an import note does NOT flip status to granted — only an explicit grant does.
    await recordConsentEvent({ customerId: cust, channel: 'sms', event: 'import_verified', source: 'imported' })
    const pref = await getPreferences(cust)
    expect(pref?.smsConsentStatus ?? 'unknown').toBe('unknown')
    expect(hasSmsConsent(pref)).toBe(false)
  })
})
