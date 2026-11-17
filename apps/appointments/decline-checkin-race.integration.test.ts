/**
 * REGRESSION — decline vs. check-in race. The check-in claim UPDATE re-checks status in SQL
 * (checkin.ts): before this, a decline landing between check-in's read and its claim would be claimed
 * over, a Job created, and linkJob would overwrite 'declined' with 'arrived'. Simulated here exactly:
 * check-in is handed a STALE confirmed snapshot while the row is already declined — the claim must
 * refuse at the database, no Job may be created, and the decline must survive. Embedded PGlite only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
vi.mock('@/apps/quick-entry/jobs-db', () => ({ createQuickEntryJob: vi.fn() }))
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>()
  return { ...actual, getAppointment: vi.fn(actual.getAppointment) }
})

import { getDb } from '@/platform/db'
import { createQuickEntryJob } from '@/apps/quick-entry/jobs-db'
import { createAppointment, declineEstimate, getAppointment, BookingError, type BookingInput } from './db'
import { checkInAppointment } from './checkin'
import { DEFAULT_BOOKING_CONFIG, zonedToUtc, type BookingConfig } from './policy'
import { fakeVpic } from './test-vpic'

const pg = new PGlite()
const PARENTS = `
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name varchar(120), last_name varchar(120),
  display_name varchar(240), company varchar(240), phone varchar(40), normalized_phone varchar(20),
  email varchar(240), normalized_email varchar(240), customer_type varchar(20) NOT NULL DEFAULT 'retail',
  active boolean NOT NULL DEFAULT true, source varchar(20) NOT NULL DEFAULT 'autoleap', source_key varchar(240),
  autoleap_customer_id varchar(120), quickbooks_customer_id varchar(120), autoleap_vehicle_count integer,
  source_values jsonb NOT NULL DEFAULT '{}', created_by_import_batch_id uuid,
  first_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vin varchar(17), year varchar(4), make varchar(100),
  model varchar(100), color varchar(100), license_plate varchar(20), body_class varchar(100),
  vin_raw jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id), vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  relationship varchar(20) NOT NULL DEFAULT 'owner', source varchar(20) NOT NULL DEFAULT 'autoleap', created_by_import_batch_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), UNIQUE (customer_id, vehicle_id)
);
CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text);
CREATE TABLE app_settings (
  key varchar(80) PRIMARY KEY, value jsonb NOT NULL, type varchar(12) NOT NULL, category varchar(40), label varchar(160),
  description text, updated_by varchar(200), updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);`

beforeAll(async () => {
  await pg.exec(PARENTS)
  for (const f of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0058_appointments.sql', '0060_booking_drafts.sql',
    '0077_appointments_referral_source.sql', '0072_marketing_leads_referral.sql', '0081_appointment_estimate_declined.sql']) {
    await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  }
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())

const NOW = zonedToUtc('2026-10-19', '06:00', 'America/Chicago')
const CFG: BookingConfig = { ...DEFAULT_BOOKING_CONFIG, enabled: true }
const input: BookingInput = {
  idempotencyKey: `race-key-${Math.random().toString(36).slice(2, 10)}`,
  date: '2026-10-20', time: '08:00', serviceKeys: ['complete_detail'],
  firstName: 'Fictional', lastName: 'Racerton', phone: '(979) 555-0177', email: 'fictional.racerton@example.com',
  vehicleType: 'car', vehicleYear: '2020', vehicleMake: 'Honda', vehicleModel: 'Civic', referralSource: 'google',
}

describe('check-in claim vs. decline', () => {
  it('a check-in holding a stale confirmed snapshot cannot claim a declined appointment or create a Job', async () => {
    const { appointment: staleSnapshot } = await createAppointment(input,
      { mode: 'public', source: 'website_booking', actor: null, now: NOW, cfg: CFG, vehicleFetch: fakeVpic() })
    expect(staleSnapshot.status).toBe('confirmed')

    await declineEstimate(staleSnapshot.id, { actor: 'Manager Mia', reason: 'price too high' })

    // Check-in read the row BEFORE the decline: its in-memory pre-checks all pass on this stale snapshot,
    // so only the claim UPDATE's own status re-check stands between the decline and a Job.
    vi.mocked(getAppointment).mockResolvedValueOnce(staleSnapshot)
    await expect(checkInAppointment(staleSnapshot.id, 'Employee Eddie')).rejects.toSatisfy(
      (e: unknown) => e instanceof BookingError && e.code === 'conflict' && /declined/.test(e.message))

    expect(createQuickEntryJob).not.toHaveBeenCalled()
    const after = (await pg.query(`SELECT status, checkin_started_at, service_order_id, arrived_at FROM appointments WHERE id = '${staleSnapshot.id}'`))
      .rows[0] as { status: string; checkin_started_at: string | null; service_order_id: string | null; arrived_at: string | null }
    expect(after).toEqual({ status: 'declined', checkin_started_at: null, service_order_id: null, arrived_at: null })
    // The lead stayed exactly where the decline put it.
    const lead = (await pg.query(`SELECT status FROM marketing_leads WHERE id = '${staleSnapshot.marketingLeadId}'`)).rows[0] as { status: string }
    expect(lead.status).toBe('lost')
  })
})
