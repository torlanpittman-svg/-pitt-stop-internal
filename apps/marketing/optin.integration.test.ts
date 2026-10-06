import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { recordPublicOptIn, smsSubscriberCount, ConsentNotGivenError, InvalidPhoneError } from './optin'
import { getPreferences, hasSmsConsent, listConsentEvents } from './consent'

const pg = new PGlite()
const PARENTS = `CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name varchar(120), last_name varchar(120),
  display_name varchar(240), company varchar(240), phone varchar(40), normalized_phone varchar(20),
  email varchar(240), normalized_email varchar(240), customer_type varchar(20) NOT NULL DEFAULT 'retail',
  active boolean NOT NULL DEFAULT true, source varchar(20) NOT NULL DEFAULT 'autoleap', source_key varchar(240),
  autoleap_customer_id varchar(120), quickbooks_customer_id varchar(120), autoleap_vehicle_count integer,
  source_values jsonb NOT NULL DEFAULT '{}', created_by_import_batch_id uuid,
  first_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text);`

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0047_marketing_sms_consent.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec('DELETE FROM marketing_consent_events; DELETE FROM marketing_preferences; DELETE FROM customers;')
})

const base = { consentText: 'I agree to recurring promotional texts...', wordingVersion: 'v1-2026-10' }

describe('public SMS opt-in', () => {
  it('does NOT consent (and creates nothing) when the box is unchecked — consent is affirmative', async () => {
    await expect(recordPublicOptIn({ ...base, agreed: false, phone: '5125550123' })).rejects.toBeInstanceOf(ConsentNotGivenError)
    const n0 = ((await pg.query('SELECT count(*)::int AS n FROM customers')).rows[0] as { n: number }).n
    expect(n0).toBe(0)
    expect(await smsSubscriberCount()).toBe(0)
  })

  it('rejects an invalid phone number', async () => {
    await expect(recordPublicOptIn({ ...base, agreed: true, phone: '123' })).rejects.toBeInstanceOf(InvalidPhoneError)
  })

  it('records proven consent (status granted + audit event) for a new opt-in and creates a prospect', async () => {
    const res = await recordPublicOptIn({ ...base, agreed: true, phone: '(512) 555-0123', name: 'New Prospect', ip: '1.2.3.4', userAgent: 'test' })
    expect(res.matchedExisting).toBe(false)
    const pref = await getPreferences(res.customerId)
    expect(hasSmsConsent(pref)).toBe(true)
    expect(pref?.smsConsentSource).toBe('website_form')
    const events = await listConsentEvents(res.customerId)
    expect(events[0].event).toBe('opt_in')
    expect(events[0].consentText).toContain('I agree')
    expect(events[0].ip).toBe('1.2.3.4')
    expect(await smsSubscriberCount()).toBe(1)
  })

  it('matches an existing customer by phone instead of duplicating', async () => {
    const first = await recordPublicOptIn({ ...base, agreed: true, phone: '5125550123' })
    const again = await recordPublicOptIn({ ...base, agreed: true, phone: '1-512-555-0123' }) // same number, different format
    expect(again.matchedExisting).toBe(true)
    expect(again.customerId).toBe(first.customerId)
    const n1 = ((await pg.query('SELECT count(*)::int AS n FROM customers')).rows[0] as { n: number }).n
    expect(n1).toBe(1)
  })

  it('staff cannot silently make an unknown customer SMS-eligible without a real opt-in', async () => {
    // Insert a plain customer (as an employee intake would) — no opt-in.
    await pg.query("INSERT INTO customers (id, display_name, phone, normalized_phone) VALUES (gen_random_uuid(), 'Walk-in', '+15129990000', '5129990000')")
    expect(await smsSubscriberCount()).toBe(0) // merely existing ≠ consented
  })
})
