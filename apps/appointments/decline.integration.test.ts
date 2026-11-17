/**
 * "Attended — estimate declined" (declineEstimate) against real SQL (embedded PGlite, never Neon):
 * the atomic appointment+lead+audit statement, honest lead outcomes (none/missing/conflict), the
 * idempotent retry, every refusal path, rollback when any leg of the statement fails, notification
 * suppression (never a cancellation email), and freed capacity. All fixture data is fictional.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import {
  createAppointment, declineEstimate, cancelAppointment, markNoShow, addInternalNote, getAvailability,
  type BookingInput,
} from './db'
import { dispatchDue, type TransactionalEmailProvider } from './notify'
import { publicSummary } from './public'
import { DEFAULT_BOOKING_CONFIG, zonedToUtc, type BookingConfig } from './policy'
import { fakeVpic } from './test-vpic'

const pg = new PGlite()
const db = drizzle(pg) as unknown as ReturnType<typeof getDb>
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
  for (const f of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0058_appointments.sql', '0060_booking_drafts.sql',
    '0077_appointments_referral_source.sql', '0072_marketing_leads_referral.sql', '0081_appointment_estimate_declined.sql']) {
    await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  }
  // The migration is idempotent: a re-run (its own BEGIN/COMMIT included) converges on the same constraint.
  await pg.exec(readFileSync('drizzle/migrations/manual/0081_appointment_estimate_declined.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(db)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM appointment_notifications; DELETE FROM appointment_events; DELETE FROM appointments; DELETE FROM appointment_blocks;
    DELETE FROM marketing_attribution; DELETE FROM marketing_events; DELETE FROM marketing_leads; DELETE FROM marketing_consent_events;
    DELETE FROM marketing_preferences; DELETE FROM customer_vehicles; DELETE FROM customers; DELETE FROM service_orders;`)
})

const count = async (table: string, where = 'true') =>
  ((await pg.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0] as { n: number }).n
const row = async <T>(q: string) => (await pg.query(q)).rows[0] as T

const NOW = zonedToUtc('2026-10-19', '06:00', 'America/Chicago')
const TUE = '2026-10-20'
const CFG: BookingConfig = { ...DEFAULT_BOOKING_CONFIG, enabled: true }
let seq = 0
const input = (over: Partial<BookingInput> = {}): BookingInput => ({
  idempotencyKey: `decline-key-${++seq}-${Math.random().toString(36).slice(2, 8)}`,
  date: TUE, time: '08:00', serviceKeys: ['complete_detail'],
  firstName: 'Fictional', lastName: 'Declinerson', phone: '(979) 555-0188', email: 'fictional.declinerson@example.com',
  vehicleType: 'car', vehicleYear: '2020', vehicleMake: 'Honda', vehicleModel: 'Civic', referralSource: 'google', ...over,
})
const pub = (over: Partial<Parameters<typeof createAppointment>[1]> = {}) =>
  ({ mode: 'public' as const, source: 'website_booking' as const, actor: null, now: NOW, cfg: CFG, vehicleFetch: fakeVpic(),
    ...over })

/** A booked appointment WITH its marketing lead (the normal public-booking shape). */
async function booked(over: Partial<BookingInput> = {}) {
  const { appointment } = await createAppointment(input({ attribution: { utm_source: 'google', utm_medium: 'cpc', gclid: 'g-decl-1' }, ...over }), pub())
  expect(appointment.marketingLeadId).toBeTruthy()
  return appointment
}

describe('decline — atomic update + audits', () => {
  it('marks the appointment declined and the linked lead Lost, with both append-only audits, in one go', async () => {
    const a = await booked()
    const res = await declineEstimate(a.id, { actor: 'Manager Mia', reason: '  price too high  ' })
    expect(res.appointment.status).toBe('declined')
    expect(res.lead).toBe('lost')
    // The lead is Lost; nothing else on it moved.
    expect(await count('marketing_leads', `id = '${a.marketingLeadId}' AND status = 'lost'`)).toBe(1)
    // Appointment audit: reason + lead outcome + the lead reference, recorded-at = the event's own created_at.
    const ev = await row<{ actor: string; meta: { reason: string; lead: string; marketingLeadId: string } }>(
      `SELECT actor, meta FROM appointment_events WHERE appointment_id = '${a.id}' AND event_type = 'estimate_declined'`)
    expect(ev.actor).toBe('Manager Mia')
    expect(ev.meta).toMatchObject({ reason: 'price too high', lead: 'lost', marketingLeadId: a.marketingLeadId })
    // Marketing audit: canonical lead_updated with the appointment linkage in meta.
    const mev = await row<{ actor: string; meta: Record<string, unknown> }>(
      `SELECT actor, meta FROM marketing_events WHERE event_type = 'lead_updated' AND entity_id = '${a.marketingLeadId}' AND meta->>'via' = 'appointment_estimate_declined'`)
    expect(mev.actor).toBe('Manager Mia')
    expect(mev.meta).toMatchObject({ status: 'lost', reason: 'price too high', appointmentId: a.id, appointmentReference: a.reference, via: 'appointment_estimate_declined' })
  })

  it('never fabricates arrival, completion or revenue, and never touches source/attribution/estimates', async () => {
    const a = await booked()
    const leadBefore = await row<Record<string, unknown>>(`SELECT source, referral_source, campaign_id, estimated_value_cents, attributed_revenue_cents, service_order_id, customer_id FROM marketing_leads WHERE id = '${a.marketingLeadId}'`)
    const attrBefore = await count('marketing_attribution')
    await declineEstimate(a.id, { actor: 'Manager Mia', reason: null })
    const after = await row<{ arrived_at: string | null; cancelled_at: string | null; service_order_id: string | null }>(
      `SELECT arrived_at, cancelled_at, service_order_id FROM appointments WHERE id = '${a.id}'`)
    expect(after).toEqual({ arrived_at: null, cancelled_at: null, service_order_id: null })
    expect(await row<Record<string, unknown>>(`SELECT source, referral_source, campaign_id, estimated_value_cents, attributed_revenue_cents, service_order_id, customer_id FROM marketing_leads WHERE id = '${a.marketingLeadId}'`)).toEqual(leadBefore)
    expect(await count('marketing_attribution')).toBe(attrBefore)
    const ev = await row<{ meta: { reason: string | null } }>(`SELECT meta FROM appointment_events WHERE appointment_id = '${a.id}' AND event_type = 'estimate_declined'`)
    expect(ev.meta.reason).toBeNull()
  })

  it('suppresses this appointment\'s pending notices and NEVER queues a cancellation email', async () => {
    const a = await booked()
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND status = 'pending'`)).toBe(2) // confirmation + reminder
    await declineEstimate(a.id, { actor: 'Manager Mia' })
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND status = 'pending'`)).toBe(0)
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND status = 'skipped'`)).toBe(2)
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND kind = 'cancellation'`)).toBe(0)
  })

  it('a sent notice is preserved, and the dispatcher re-check retires a notice revived after the decline without calling the provider', async () => {
    const a = await booked()
    await pg.exec(`UPDATE appointment_notifications SET status = 'sent', sent_at = now() WHERE appointment_id = '${a.id}' AND kind = 'confirmation'`)
    await declineEstimate(a.id, { actor: 'Manager Mia' })
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND kind = 'confirmation' AND status = 'sent'`)).toBe(1)
    // A notice that was mid-flight (claimed/held) when the decline landed comes back 'pending': the
    // dispatcher must re-check and retire it, not send it.
    await pg.exec(`UPDATE appointment_notifications SET status = 'pending', send_after = now() - interval '1 minute' WHERE appointment_id = '${a.id}' AND kind = 'reminder'`)
    const send = vi.fn()
    const provider: TransactionalEmailProvider = { name: 'test', live: false, send }
    const tally = await dispatchDue({ appointmentId: a.id, provider })
    expect(send).not.toHaveBeenCalled()
    expect(tally.skipped).toBe(1)
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND kind = 'reminder' AND status = 'skipped' AND error = 'appointment declined'`)).toBe(1)
    // The customer attended in person — a retired notice here is housekeeping, never a "missed send" anomaly.
    expect(await count('appointment_events', `appointment_id = '${a.id}' AND event_type = 'email_not_sent'`)).toBe(0)
  })

  it('frees the slot: declined does not occupy capacity', async () => {
    const a = await booked()
    const before = await getAvailability({ cfg: CFG, serviceKeys: ['complete_detail'], fromDate: TUE, days: 1, now: NOW })
    expect(before.days[0].slots.find((s) => s.time === '08:00')).toMatchObject({ available: false })
    await declineEstimate(a.id, { actor: 'Manager Mia' })
    const after = await getAvailability({ cfg: CFG, serviceKeys: ['complete_detail'], fromDate: TUE, days: 1, now: NOW })
    expect(after.days[0].slots.find((s) => s.time === '08:00')).toMatchObject({ available: true })
  })

  it('staff notes still work after declined, and the public summary stays allowlisted', async () => {
    const a = await booked()
    await declineEstimate(a.id, { actor: 'Manager Mia' })
    await addInternalNote(a.id, 'Quoted full correction; will call back in spring.', 'Manager Mia')
    expect(await count('appointment_events', `appointment_id = '${a.id}' AND event_type = 'note_added'`)).toBe(1)
    const declined = await row<{ status: string }>(`SELECT status FROM appointments WHERE id = '${a.id}'`)
    expect(declined.status).toBe('declined')
    const s = publicSummary({ ...a, status: 'declined' }) as unknown as Record<string, unknown>
    expect(s.status).toBe('declined')
    for (const k of ['id', 'customerId', 'serviceOrderId', 'marketingLeadId', 'internalNotes', 'attribution']) expect(s).not.toHaveProperty(k)
  })
})

describe('decline — lead edge cases, honestly reported', () => {
  it('no linked lead: the decline proceeds and records lead:none — no lead audit is invented', async () => {
    const a = await booked()
    await pg.exec(`UPDATE appointments SET marketing_lead_id = NULL WHERE id = '${a.id}'`)
    const res = await declineEstimate(a.id, { actor: 'Manager Mia' })
    expect(res.lead).toBe('none')
    expect(await count('marketing_leads', `status = 'lost'`)).toBe(0)
    expect(await count('marketing_events', `event_type = 'lead_updated' AND meta->>'via' = 'appointment_estimate_declined'`)).toBe(0)
    const ev = await row<{ meta: { lead: string; marketingLeadId: string | null } }>(`SELECT meta FROM appointment_events WHERE appointment_id = '${a.id}' AND event_type = 'estimate_declined'`)
    expect(ev.meta).toMatchObject({ lead: 'none', marketingLeadId: null })
  })

  it('dangling lead id: a clear conflict, and the appointment is left exactly as it was', async () => {
    const a = await booked()
    const ghost = '00000000-0000-4000-8000-00000000dead'
    await pg.exec(`UPDATE appointments SET marketing_lead_id = '${ghost}' WHERE id = '${a.id}'`)
    await expect(declineEstimate(a.id, { actor: 'Manager Mia' })).rejects.toMatchObject(
      { code: 'conflict', message: expect.stringContaining('no longer exists') })
    expect(await count('appointments', `id = '${a.id}' AND status = 'confirmed'`)).toBe(1)
    expect(await count('marketing_leads', `status = 'lost'`)).toBe(0)
    expect(await count('appointment_events', `event_type = 'estimate_declined'`)).toBe(0)
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND status = 'pending'`)).toBe(2)
    expect(await count('marketing_events', `event_type = 'lead_updated' AND meta->>'via' = 'appointment_estimate_declined'`)).toBe(0)
  })

  it('a Won lead is never overwritten — conflict, nothing written', async () => {
    const a = await booked()
    await pg.exec(`UPDATE marketing_leads SET status = 'won' WHERE id = '${a.marketingLeadId}'`)
    await expect(declineEstimate(a.id, { actor: 'Manager Mia' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await count('appointments', `id = '${a.id}' AND status = 'confirmed'`)).toBe(1)
    expect(await count('marketing_leads', `id = '${a.marketingLeadId}' AND status = 'won'`)).toBe(1)
    expect(await count('appointment_events', `event_type = 'estimate_declined'`)).toBe(0)
  })

  it('REGRESSION — a lead turning Won AFTER the preflight read but BEFORE the write refuses the WHOLE decline', async () => {
    const a = await booked()
    // Interleave exactly the window the statement's row locks must close: declineEstimate's first
    // db.execute is its preflight lead read (which sees an eligible lead), its second is the atomic
    // statement. The lead turns Won in between — as a concurrent manager/check-in commit would.
    let executes = 0
    const raced = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return async (q: unknown) => {
            executes += 1
            if (executes === 2) await pg.query(`UPDATE marketing_leads SET status = 'won' WHERE id = '${a.marketingLeadId}'`)
            return (db as unknown as { execute: (q: unknown) => unknown }).execute(q)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as ReturnType<typeof getDb>
    vi.mocked(getDb).mockReturnValue(raced)
    try {
      await expect(declineEstimate(a.id, { actor: 'Manager Mia', reason: 'price' })).rejects.toMatchObject(
        { code: 'conflict', message: expect.stringContaining('Won') })
    } finally {
      vi.mocked(getDb).mockReturnValue(db)
    }
    expect(executes).toBeGreaterThanOrEqual(2) // the interleave actually happened
    // NOTHING committed: appointment still confirmed, no decline audit, notices untouched, lead stays Won.
    expect(await count('appointments', `id = '${a.id}' AND status = 'confirmed'`)).toBe(1)
    expect(await count('appointment_events', `event_type = 'estimate_declined'`)).toBe(0)
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND status = 'pending'`)).toBe(2)
    expect(await count('marketing_leads', `id = '${a.marketingLeadId}' AND status = 'won'`)).toBe(1)
    expect(await count('marketing_events', `event_type = 'lead_updated' AND meta->>'via' = 'appointment_estimate_declined'`)).toBe(0)
  })

  it('a job-linked lead is never overwritten — conflict, nothing written', async () => {
    const a = await booked()
    await pg.exec(`INSERT INTO service_orders (id, customer_id, status) VALUES (gen_random_uuid(), NULL, 'in_progress')`)
    const so = await row<{ id: string }>(`SELECT id FROM service_orders LIMIT 1`)
    await pg.exec(`UPDATE marketing_leads SET service_order_id = '${so.id}' WHERE id = '${a.marketingLeadId}'`)
    await expect(declineEstimate(a.id, { actor: 'Manager Mia' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await count('appointments', `id = '${a.id}' AND status = 'confirmed'`)).toBe(1)
    expect(await count('appointment_events', `event_type = 'estimate_declined'`)).toBe(0)
  })
})

describe('decline — refusal of ineligible records', () => {
  it('refuses when a Work Board job is already linked', async () => {
    const a = await booked()
    await pg.exec(`INSERT INTO service_orders (id, customer_id, status) VALUES (gen_random_uuid(), NULL, 'in_progress')`)
    const so = await row<{ id: string }>(`SELECT id FROM service_orders LIMIT 1`)
    await pg.exec(`UPDATE appointments SET service_order_id = '${so.id}', status = 'arrived' WHERE id = '${a.id}'`)
    await expect(declineEstimate(a.id, { actor: 'Manager Mia' })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses while a check-in claim exists (a Job may be mid-creation)', async () => {
    const a = await booked()
    await pg.exec(`UPDATE appointments SET checkin_started_at = now() WHERE id = '${a.id}'`)
    await expect(declineEstimate(a.id, { actor: 'Manager Mia' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await count('appointments', `id = '${a.id}' AND status = 'confirmed'`)).toBe(1)
    expect(await count('marketing_leads', `status = 'lost'`)).toBe(0)
  })

  it('refuses cancelled and no-show appointments', async () => {
    const a = await booked()
    await cancelAppointment(a.id, { actor: 'Manager Mia', by: 'staff' })
    await expect(declineEstimate(a.id, { actor: 'Manager Mia' })).rejects.toMatchObject({ code: 'conflict' })
    const b = await booked({ time: '09:00', email: 'second.fictional@example.com', phone: '9795550189' })
    await markNoShow(b.id, 'Manager Mia', zonedToUtc(TUE, '12:00', 'America/Chicago'))
    await expect(declineEstimate(b.id, { actor: 'Manager Mia' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await count('appointment_events', `event_type = 'estimate_declined'`)).toBe(0)
  })

  it('refuses a nonexistent id', async () => {
    await expect(declineEstimate('00000000-0000-4000-8000-000000000001', { actor: 'Manager Mia' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('decline — retries, double-taps and rollback', () => {
  it('a retry is harmless: no duplicate audit, and a lead a manager has since changed is NOT clobbered', async () => {
    const a = await booked()
    expect((await declineEstimate(a.id, { actor: 'Manager Mia', reason: 'price' })).lead).toBe('lost')
    // The owner re-qualifies the lead afterwards…
    await pg.exec(`UPDATE marketing_leads SET status = 'contacted' WHERE id = '${a.marketingLeadId}'`)
    // …and a stale retry/double-tap lands.
    const again = await declineEstimate(a.id, { actor: 'Manager Mia', reason: 'price' })
    expect(again.lead).toBe('already')
    expect(await count('marketing_leads', `id = '${a.marketingLeadId}' AND status = 'contacted'`)).toBe(1)
    expect(await count('appointment_events', `appointment_id = '${a.id}' AND event_type = 'estimate_declined'`)).toBe(1)
    expect(await count('marketing_events', `event_type = 'lead_updated' AND meta->>'via' = 'appointment_estimate_declined'`)).toBe(1)
  })

  it('concurrent declines: exactly one wins, the rest replay, one audit each', async () => {
    const a = await booked()
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => declineEstimate(a.id, { actor: 'Manager Mia', reason: 'price' })))
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const outcomes = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof declineEstimate>>>).value.lead)
    expect(outcomes.filter((o) => o === 'lost')).toHaveLength(1)
    expect(await count('appointment_events', `appointment_id = '${a.id}' AND event_type = 'estimate_declined'`)).toBe(1)
    expect(await count('marketing_events', `event_type = 'lead_updated' AND meta->>'via' = 'appointment_estimate_declined'`)).toBe(1)
  })

  it('rolls back EVERYTHING when the marketing audit insert fails', async () => {
    const a = await booked()
    await pg.exec(`CREATE OR REPLACE FUNCTION ps_force_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER ps_fail_mev BEFORE INSERT ON marketing_events FOR EACH ROW EXECUTE FUNCTION ps_force_fail();`)
    try {
      await expect(declineEstimate(a.id, { actor: 'Manager Mia', reason: 'price' })).rejects.toThrow()
      expect(await count('appointments', `id = '${a.id}' AND status = 'confirmed'`)).toBe(1)
      expect(await count('marketing_leads', `id = '${a.marketingLeadId}' AND status = 'booked'`)).toBe(1)
      expect(await count('appointment_events', `event_type = 'estimate_declined'`)).toBe(0)
      expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND status = 'pending'`)).toBe(2)
    } finally {
      await pg.exec(`DROP TRIGGER ps_fail_mev ON marketing_events;`)
    }
  })

  it('rolls back EVERYTHING when the lead update fails', async () => {
    const a = await booked()
    await pg.exec(`CREATE OR REPLACE FUNCTION ps_force_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced lead failure'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER ps_fail_lead BEFORE UPDATE ON marketing_leads FOR EACH ROW EXECUTE FUNCTION ps_force_fail();`)
    try {
      await expect(declineEstimate(a.id, { actor: 'Manager Mia', reason: 'price' })).rejects.toThrow()
      expect(await count('appointments', `id = '${a.id}' AND status = 'confirmed'`)).toBe(1)
      expect(await count('marketing_leads', `id = '${a.marketingLeadId}' AND status = 'booked'`)).toBe(1)
      expect(await count('appointment_events', `event_type = 'estimate_declined'`)).toBe(0)
    } finally {
      await pg.exec(`DROP TRIGGER ps_fail_lead ON marketing_leads;`)
    }
  })
})
