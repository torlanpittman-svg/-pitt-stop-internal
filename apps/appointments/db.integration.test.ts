import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import {
  createAppointment, cancelAppointment, rescheduleAppointment, markNoShow, getAppointmentByToken, getAvailability,
  BookingError, PUBLIC_HOURLY_LIMIT, hashIp, type BookingInput,
} from './db'
import { DEFAULT_BOOKING_CONFIG, zonedToUtc, type BookingConfig } from './policy'
import { publicSummary } from './public'

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
CREATE TABLE vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
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
  for (const f of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0058_appointments.sql']) {
    await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  }
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM appointment_notifications; DELETE FROM appointment_events; DELETE FROM appointments; DELETE FROM appointment_blocks;
    DELETE FROM marketing_attribution; DELETE FROM marketing_events; DELETE FROM marketing_leads; DELETE FROM marketing_consent_events;
    DELETE FROM marketing_preferences; DELETE FROM customer_vehicles; DELETE FROM customers;`)
})

const count = async (table: string, where = 'true') =>
  ((await pg.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0] as { n: number }).n

// Monday 2026-10-19 06:00 Central (fixed, in the past) — rules are evaluated against this injected clock.
// The rate-limit window compares DB created_at (real now) ≥ NOW − 1h, which holds for any later real date.
const NOW = zonedToUtc('2026-10-19', '06:00', 'America/Chicago')
const TUE = '2026-10-20'
// The launch configuration (owner decision 2026-10-19): one public drop-off per 15-minute time, no daily cap,
// workload limits off. Only `enabled` differs from the shipped defaults.
const CFG: BookingConfig = { ...DEFAULT_BOOKING_CONFIG, enabled: true }
let seq = 0
const input = (over: Partial<BookingInput> = {}): BookingInput => ({
  idempotencyKey: `test-key-${++seq}-${Math.random().toString(36).slice(2, 8)}`,
  date: TUE, time: '08:00', serviceKeys: ['complete_detail'],
  firstName: 'Test', lastName: 'Customer', phone: '(979) 555-0101', email: 'test.customer@example.com',
  vehicleYear: '2020', vehicleMake: 'Honda', vehicleModel: 'Civic', ...over,
})
const pub = (over: Partial<Parameters<typeof createAppointment>[1]> = {}) =>
  ({ mode: 'public' as const, source: 'website_booking' as const, actor: null, now: NOW, cfg: CFG, ...over })

describe('public booking', () => {
  it('creates a confirmed appointment, its history, its notices, a canonical customer and a lead', async () => {
    const { appointment: a, token, replayed } = await createAppointment(input(), pub())
    expect(replayed).toBe(false)
    expect(a.status).toBe('confirmed')
    expect(a.reference).toMatch(/^PS-[2-9A-HJ-KM-NP-Z]{6}$/)
    expect(a.startsAt.toISOString()).toBe('2026-10-20T13:00:00.000Z')
    expect(a.source).toBe('website_booking')
    expect(await count('appointment_events', `appointment_id = '${a.id}' AND event_type = 'booked'`)).toBe(1)
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND kind = 'confirmation'`)).toBe(1)
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND kind = 'reminder'`)).toBe(1)
    expect(a.customerId).toBeTruthy()
    expect(await count('customers')).toBe(1)
    expect(a.marketingLeadId).toBeTruthy()
    expect(await count('marketing_leads', `status = 'booked'`)).toBe(1)
    // The private link resolves only this appointment.
    expect((await getAppointmentByToken(token))?.id).toBe(a.id)
    expect(await getAppointmentByToken('x'.repeat(32))).toBeNull()
  })

  it('reconciles an existing customer by email/phone instead of creating a duplicate', async () => {
    const [{ id }] = (await pg.query(`INSERT INTO customers (display_name, email, normalized_email, phone, normalized_phone, source)
      VALUES ('Existing Person', 'Test.Customer@Example.com', 'test.customer@example.com', '9795550101', '9795550101', 'quickbooks') RETURNING id`)).rows as { id: string }[]
    const { appointment } = await createAppointment(input({ firstName: 'Testy' }), pub())
    expect(appointment.customerId).toBe(id)
    expect(await count('customers')).toBe(1)
    // Anonymous booking data never overwrites the authoritative record.
    expect(((await pg.query(`SELECT display_name FROM customers WHERE id = '${id}'`)).rows[0] as { display_name: string }).display_name).toBe('Existing Person')
  })

  it('a duplicate submission (same key) returns the same appointment', async () => {
    const i = input()
    const first = await createAppointment(i, pub())
    const second = await createAppointment(i, pub())
    expect(second.replayed).toBe(true)
    expect(second.appointment.id).toBe(first.appointment.id)
    expect(second.token).toBe(first.token)
    expect(await count('appointments')).toBe(1)
    expect(await count('marketing_leads')).toBe(1)
  })

  it('full capacity: the second booking for the last opening fails and leaves no partial state', async () => {
    await createAppointment(input(), pub())
    const before = { customers: await count('customers'), leads: await count('marketing_leads'), events: await count('appointment_events'), notes: await count('appointment_notifications') }
    await expect(createAppointment(input({ email: 'other@example.com', phone: '9795550199' }), pub())).rejects.toMatchObject({ code: 'full' })
    expect(await count('appointments')).toBe(1)
    expect({ customers: await count('customers'), leads: await count('marketing_leads'), events: await count('appointment_events'), notes: await count('appointment_notifications') }).toEqual(before)
    // ...and that time is no longer offered.
    const { days } = await getAvailability({ cfg: CFG, serviceKeys: ['complete_detail'], fromDate: TUE, days: 1, now: NOW })
    expect(days[0].slots.find((s) => s.time === '08:00')).toMatchObject({ available: false, reason: 'full' })
  })

  it('concurrent attempts at the same time: exactly one public booking wins', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      createAppointment(input({ time: '09:15', email: `racer${i}@example.com`, phone: `97955502${10 + i}` }), pub())))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as BookingError).code === 'full')).toHaveLength(5)
    expect(await count('appointments', `local_time = '09:15' AND status = 'confirmed'`)).toBe(1)
  })

  it('a stored per-time limit above 1 is still enforced under concurrency', async () => {
    const cfg = { ...CFG, slotCapacity: 2 }
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      createAppointment(input({ email: `racer${i}@example.com`, phone: `97955503${10 + i}` }), pub({ cfg }))))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect(await count('appointments', `local_time = '08:00' AND status = 'confirmed'`)).toBe(2)
  })

  it('a double-tapped Confirm sent twice at once creates one appointment', async () => {
    const i = input({ time: '10:00' })
    const [a, b] = await Promise.allSettled([createAppointment(i, pub()), createAppointment(i, pub())])
    const ok = [a, b].filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createAppointment>>> => r.status === 'fulfilled')
    expect(ok).toHaveLength(2) // both taps succeed and point at the same appointment
    expect(new Set(ok.map((r) => r.value.appointment.id)).size).toBe(1)
    expect(await count('appointments')).toBe(1)
  })

  it('the next 15-minute time stays bookable after a time is taken', async () => {
    await createAppointment(input({ time: '08:30' }), pub())
    await expect(createAppointment(input({ time: '08:30', email: 'b@example.com', phone: '9795550301' }), pub())).rejects.toMatchObject({ code: 'full' })
    const { appointment } = await createAppointment(input({ time: '08:45', email: 'b@example.com', phone: '9795550301' }), pub())
    expect(appointment.localTime).toBe('08:45')
  })

  it('a busy day never closes: 15 bookings, and 11:00 (the last drop-off) is still bookable', async () => {
    const times = ['07:15', '07:30', '07:45', '08:00', '08:15', '08:30', '08:45', '09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45']
    for (const [n, time] of times.entries()) {
      // a mix of heavy services: weights are stored but must not use up the day
      const serviceKeys = n % 3 === 0 ? ['ceramic_coating'] : n % 3 === 1 ? ['paint_correction'] : ['complete_detail']
      await createAppointment(input({ time, serviceKeys, email: `busy${n}@example.com`, phone: `97955504${10 + n}` }), pub())
    }
    const { days } = await getAvailability({ cfg: CFG, serviceKeys: ['ceramic_coating'], fromDate: TUE, days: 1, now: NOW })
    expect(days[0].closed).toBe(false)
    expect(days[0].slots.filter((s) => s.available).map((s) => s.time)).toEqual(['11:00'])
    const { appointment } = await createAppointment(input({ time: '11:00', serviceKeys: ['ceramic_coating'], email: 'last@example.com', phone: '9795550499' }), pub())
    expect(appointment.localTime).toBe('11:00')
    expect(await count('appointments', `local_date = '${TUE}' AND status = 'confirmed'`)).toBe(16)
  })

  it('a ceramic coating at 8:00 leaves 8:15, 8:30 and every later time open', async () => {
    const { appointment } = await createAppointment(input({ serviceKeys: ['ceramic_coating'] }), pub())
    expect(appointment.unitsDetail).toBe(2) // weight recorded for a possible future workload limit
    await createAppointment(input({ time: '08:15', serviceKeys: ['paint_correction'], email: 'p@example.com', phone: '9795550302' }), pub())
    const { days } = await getAvailability({ cfg: CFG, serviceKeys: ['ceramic_coating'], fromDate: TUE, days: 1, now: NOW })
    const open = days[0].slots.filter((s) => s.available).map((s) => s.time)
    expect(open).not.toContain('08:00')
    expect(open).not.toContain('08:15')
    expect(open).toHaveLength(14)
    expect(open).toContain('08:30')
  })

  it('a manager-enabled daily limit is enforced by the atomic insert', async () => {
    const cfg = { ...CFG, dailyAppointmentLimit: 1 }
    await createAppointment(input(), pub({ cfg }))
    await expect(createAppointment(input({ time: '09:00', email: 'c@example.com', phone: '9795550303' }), pub({ cfg }))).rejects.toMatchObject({ code: 'full' })
  })

  it('rejects after-cutoff, closed and unready configurations server-side', async () => {
    await expect(createAppointment(input({ time: '11:15' }), pub())).rejects.toMatchObject({ code: 'closed' })
    await expect(createAppointment(input({ date: '2026-10-24' }), pub())).rejects.toMatchObject({ code: 'closed' }) // Saturday
    await expect(createAppointment(input(), pub({ cfg: { ...CFG, slotCapacity: null } }))).rejects.toMatchObject({ code: 'closed' })
    await expect(createAppointment(input(), pub({ cfg: { ...CFG, enabled: false } }))).rejects.toMatchObject({ code: 'closed' })
    expect(await count('appointments')).toBe(0)
  })

  it('same-day booking works and gets no immediate reminder', async () => {
    const now = zonedToUtc('2026-10-19', '08:10', 'America/Chicago')
    await expect(createAppointment(input({ date: '2026-10-19', time: '09:00' }), pub({ now }))).rejects.toMatchObject({ code: 'closed' }) // inside 60-min lead
    const { appointment } = await createAppointment(input({ date: '2026-10-19', time: '09:15' }), pub({ now }))
    expect(await count('appointment_notifications', `appointment_id = '${appointment.id}' AND kind = 'confirmation'`)).toBe(1)
    expect(await count('appointment_notifications', `appointment_id = '${appointment.id}' AND kind = 'reminder'`)).toBe(0)
  })

  it('rate-limits one connection', async () => {
    const ipHash = hashIp('203.0.113.9')
    const cfg = { ...CFG, slotCapacity: 50 }
    for (let i = 0; i < PUBLIC_HOURLY_LIMIT; i++) await createAppointment(input({ email: `rl${i}@example.com` }), pub({ cfg, ipHash }))
    await expect(createAppointment(input({ email: 'rl-extra@example.com' }), pub({ cfg, ipHash }))).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('the public summary exposes no internal fields', async () => {
    const { appointment } = await createAppointment(input({ notes: 'customer note' }), pub())
    const s = publicSummary(appointment) as unknown as Record<string, unknown>
    for (const k of ['id', 'customerId', 'serviceOrderId', 'marketingLeadId', 'internalNotes', 'attribution', 'ipHash', 'tokenHash', 'idempotencyKey']) expect(s).not.toHaveProperty(k)
  })
})

describe('SMS marketing consent', () => {
  const consent = { text: 'I agree to promotional texts…', version: 'v-test' }
  it('booking never creates marketing consent by itself', async () => {
    await createAppointment(input(), pub({ smsConsent: consent }))
    expect(await count('marketing_consent_events')).toBe(0)
    expect(await count('marketing_preferences', `sms_consent_status = 'granted'`)).toBe(0)
  })
  it('an explicit opt-in is recorded with its wording', async () => {
    const { appointment } = await createAppointment(input({ smsMarketingOptIn: true }), pub({ smsConsent: consent }))
    expect(appointment.smsMarketingOptIn).toBe(true)
    expect(await count('marketing_preferences', `sms_consent_status = 'granted' AND customer_id = '${appointment.customerId}'`)).toBe(1)
    expect(await count('marketing_consent_events')).toBeGreaterThan(0)
  })
})

describe('attribution', () => {
  it('unknown source stays unknown', async () => {
    await createAppointment(input(), pub())
    expect(await count('marketing_leads', `source = 'unknown'`)).toBe(1)
    expect(await count('marketing_attribution', `source = 'unknown' AND confidence = 'unknown'`)).toBe(1)
  })
  it('a Google Ads click is attributed directly', async () => {
    const { appointment } = await createAppointment(input({ attribution: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'ceramic-fall', gclid: 'abc123' } }), pub())
    expect(appointment.attribution).toMatchObject({ gclid: 'abc123', utm_campaign: 'ceramic-fall' })
    expect(await count('marketing_leads', `source = 'google_ads'`)).toBe(1)
    expect(await count('marketing_attribution', `source = 'google_ads' AND confidence = 'direct' AND click_id = 'abc123' AND utm_campaign = 'ceramic-fall'`)).toBe(1)
  })
})

describe('changes', () => {
  it('cancel releases capacity, skips the reminder and queues a cancellation notice', async () => {
    const { appointment } = await createAppointment(input(), pub())
    await cancelAppointment(appointment.id, { actor: 'Darryl', by: 'staff' })
    expect(await count('appointment_notifications', `appointment_id = '${appointment.id}' AND kind = 'reminder' AND status = 'skipped'`)).toBe(1)
    expect(await count('appointment_notifications', `appointment_id = '${appointment.id}' AND kind = 'cancellation' AND status = 'pending'`)).toBe(1)
    expect(await count('appointment_events', `appointment_id = '${appointment.id}' AND event_type = 'cancelled'`)).toBe(1)
    const again = await createAppointment(input({ email: 'next@example.com', phone: '9795550222' }), pub())
    expect(again.appointment.status).toBe('confirmed')
  })

  it('customers cannot cancel online inside the cutoff', async () => {
    const { appointment } = await createAppointment(input(), pub())
    const tooLate = zonedToUtc(TUE, '07:30', 'America/Chicago')
    await expect(cancelAppointment(appointment.id, { actor: 'customer', by: 'customer', now: tooLate, cfg: CFG })).rejects.toMatchObject({ code: 'too_late' })
    await cancelAppointment(appointment.id, { actor: 'customer', by: 'customer', now: NOW, cfg: CFG })
  })

  it('reschedule re-checks capacity (excluding itself) and managers can override', async () => {
    const a = (await createAppointment(input(), pub())).appointment
    await createAppointment(input({ time: '09:00', email: 'b@example.com', phone: '9795550333' }), pub())
    await expect(rescheduleAppointment(a.id, { date: TUE, time: '09:00' }, { actor: 'Tony', now: NOW, cfg: CFG })).rejects.toMatchObject({ code: 'full' })
    const moved = await rescheduleAppointment(a.id, { date: TUE, time: '10:00' }, { actor: 'Tony', now: NOW, cfg: CFG })
    expect(moved.localTime).toBe('10:00')
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND kind = 'reminder' AND status = 'pending'`)).toBe(1)
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND kind = 'reminder' AND status = 'skipped'`)).toBe(1)
    const overridden = await rescheduleAppointment(a.id, { date: TUE, time: '15:30' }, { actor: 'Tony', override: true, now: NOW, cfg: CFG })
    expect(overridden.localTime).toBe('15:30')
    expect(overridden.capacityOverride).toBe(true)
  })

  it('no-show only after the drop-off time', async () => {
    const { appointment } = await createAppointment(input(), pub())
    await expect(markNoShow(appointment.id, 'Tony', NOW)).rejects.toMatchObject({ code: 'conflict' })
    expect((await markNoShow(appointment.id, 'Tony', zonedToUtc(TUE, '12:00', 'America/Chicago'))).status).toBe('no_show')
  })
})

describe('staff bookings', () => {
  const staff = (over: Partial<Parameters<typeof createAppointment>[1]> = {}) =>
    ({ mode: 'staff' as const, source: 'phone' as const, actor: 'Darryl', now: NOW, cfg: CFG, ...over })

  it('phone bookings follow the normal rules; manager override books outside the window', async () => {
    await expect(createAppointment(input({ time: '14:00' }), staff())).rejects.toMatchObject({ code: 'closed' })
    const { appointment } = await createAppointment(input({ time: '14:00' }), staff({ override: true }))
    expect(appointment.capacityOverride).toBe(true)
    expect(appointment.createdBy).toBe('Darryl')
  })

  it('a manager override can add a second appointment at an already-booked public time', async () => {
    await createAppointment(input({ time: '08:30' }), pub())
    await expect(createAppointment(input({ time: '08:30', email: 'x@example.com' }), staff())).rejects.toMatchObject({ code: 'full' })
    const { appointment } = await createAppointment(input({ time: '08:30', email: 'x@example.com' }), staff({ override: true }))
    expect(appointment.status).toBe('confirmed')
    expect(appointment.capacityOverride).toBe(true)
    expect(await count('appointments', `local_time = '08:30' AND status = 'confirmed'`)).toBe(2)
    // the public page still treats 8:30 as taken
    await expect(createAppointment(input({ time: '08:30', email: 'y@example.com', phone: '9795550304' }), pub())).rejects.toMatchObject({ code: 'full' })
  })

  it('re-running an AutoLeap import does not duplicate appointments or customers', async () => {
    const row = () => input({ externalRef: 'autoleap:12345', firstName: 'Imported', email: 'imported@example.com' })
    const first = await createAppointment(row(), staff({ source: 'autoleap_import' }))
    const second = await createAppointment(row(), staff({ source: 'autoleap_import', override: true }))
    expect(second.replayed).toBe(true)
    expect(second.appointment.id).toBe(first.appointment.id)
    expect(await count('appointments', `source = 'autoleap_import'`)).toBe(1)
    expect(await count('customers', `normalized_email = 'imported@example.com'`)).toBe(1)
  })
})
