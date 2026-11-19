/**
 * Cancelled-appointment recovery against real SQL (embedded PGlite, never Neon): enrolment at cancel, the dark
 * default, duplicate prevention, the send-time gate (opt-out, rebooking, master switch), pause/stop, rebooking by
 * link vs. by contact match, original-source preservation, and revenue that counts only completed + paid jobs,
 * once. Emails go to an in-memory provider — nothing leaves the process. All fixture data is fictional.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { createAppointment, cancelAppointment, getAppointment, type Appointment, type BookingInput } from './db'
import { dispatchDue, type DeliveryResult, type EmailMessage, type TransactionalEmailProvider } from './notify'
import {
  enrollCancellation, enrollManually, startSequence, pauseSequence, resumeSequence, stopSequence, setStaffOutcome, sendNextNow,
  reviewRebookMatch, detectRebookings, getRecoveryForAppointment, listRecoveries, listCandidates, recoveryReport, PAUSED_NOTE, REASONS,
  recordManagerEmailConsent, hasEmailConsent, reconcileRecoveries, recoverInterruptedEmails, refreshRecoveredPayments,
} from './recovery'
import { recoveryToken } from './tokens'
import { checkRecoveryStream, syncPostmarkSuppressions } from './postmark-sync'
import { EMAIL_CONSENT_TEXT, EMAIL_CONSENT_VERSION } from './email-consent'
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
CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text, completed_at timestamptz, cancelled_at timestamptz, approved_price_cents integer);
CREATE TABLE job_estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_order_id uuid, total_cents integer, qb_invoice_id varchar(100), qb_payment_status varchar(20) NOT NULL DEFAULT 'none',
  qb_payment_balance_state varchar(20), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE service_catalog (slug varchar(80) PRIMARY KEY, default_price_cents integer, active boolean NOT NULL DEFAULT true);
CREATE TABLE app_settings (
  key varchar(80) PRIMARY KEY, value jsonb NOT NULL, type varchar(12) NOT NULL, category varchar(40), label varchar(160),
  description text, updated_by varchar(200), updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);`

beforeAll(async () => {
  await pg.exec(PARENTS)
  for (const f of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0058_appointments.sql', '0060_booking_drafts.sql',
    '0077_appointments_referral_source.sql', '0072_marketing_leads_referral.sql', '0081_appointment_estimate_declined.sql', '0082_appointment_recovery.sql']) {
    await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  }
  // The migration is idempotent: a second run changes nothing and does not fail.
  await pg.exec(readFileSync('drizzle/migrations/manual/0082_appointment_recovery.sql', 'utf8'))
  await pg.exec(`INSERT INTO service_catalog (slug, default_price_cents) VALUES ('ceramic_coating_1yr', 100000), ('ceramic_coating_3yr', 220000), ('interior_detail', NULL), ('mini_detail', 15000)`)
  vi.mocked(getDb).mockReturnValue(db)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM appointment_recovery_events; DELETE FROM appointment_recoveries; DELETE FROM booking_draft_events; DELETE FROM booking_drafts;
    DELETE FROM appointment_notifications; DELETE FROM appointment_events; DELETE FROM appointments; DELETE FROM appointment_blocks;
    DELETE FROM marketing_attribution; DELETE FROM marketing_events; DELETE FROM marketing_leads; DELETE FROM marketing_consent_events;
    DELETE FROM marketing_preferences; DELETE FROM customer_vehicles; DELETE FROM customers; DELETE FROM job_estimates; DELETE FROM service_orders; DELETE FROM app_settings;`)
  sent.length = 0
  nextResult = null
})

const count = async (table: string, where = 'true') =>
  ((await pg.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0] as { n: number }).n
const rows = async <T>(q: string) => (await pg.query(q)).rows as T[]

// The appointment is for a far-future Tuesday so "now" (the real clock, which cancelled_at uses) is always before it.
const BOOK_NOW = zonedToUtc('2030-01-07', '06:00', 'America/Chicago')
const TUE = '2030-01-08'
const WED = '2030-01-09'
const BASE: BookingConfig = { ...DEFAULT_BOOKING_CONFIG, enabled: true, maxAdvanceDays: 30 }
/** dispatchDue and the cancel hook read booking_config from app_settings, so the switches are set there. */
async function setCfg(over: Partial<BookingConfig> = {}): Promise<BookingConfig> {
  const cfg = { ...BASE, ...over }
  await pg.query(`INSERT INTO app_settings (key, value, type) VALUES ('booking_config', $1::jsonb, 'json') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(cfg)])
  return cfg
}
const LIVE = { recoveryEmailsEnabled: true, recoveryAutoStart: true }

let seq = 0
const input = (over: Partial<BookingInput> = {}): BookingInput => ({
  idempotencyKey: `recovery-key-${++seq}-${Math.random().toString(36).slice(2, 8)}`,
  date: TUE, time: '08:45', serviceKeys: ['interior_detail', 'ceramic_coating', 'odor'],
  firstName: 'Fictional', lastName: 'Canceller', phone: '(979) 555-0142', email: 'fictional.canceller@example.com',
  vehicleType: 'car', vehicleYear: '2020', vehicleMake: 'Honda', vehicleModel: 'Civic', referralSource: 'drive_by', ...over,
})
const pub = (cfg: BookingConfig) => ({ mode: 'public' as const, source: 'website_booking' as const, actor: null, now: BOOK_NOW, cfg, vehicleFetch: fakeVpic() })

const sent: EmailMessage[] = []
let nextResult: DeliveryResult | null = null
const provider: TransactionalEmailProvider = {
  name: 'memory', live: true,
  async send(msg) { if (nextResult) return nextResult; sent.push(msg); return { status: 'sent', providerMessageId: `m-${sent.length}` } },
}

/** Books online WITH the email-marketing box ticked, an hour before the cancel (so it is not a "quick cancel"), unless overridden. */
async function bookAndCancel(cfgOver: Partial<BookingConfig> = LIVE, by: { by: 'customer' } | { by: 'staff'; initiator?: 'customer' | 'shop' | null } = { by: 'customer' }, over: Partial<BookingInput> = {}, opts: { quick?: boolean } = {}): Promise<{ appt: Appointment; cfg: BookingConfig }> {
  const cfg = await setCfg(cfgOver)
  const { appointment } = await createAppointment(input({ attribution: { utm_source: 'google', utm_medium: 'cpc', gclid: 'g-rec-1' }, emailMarketingOptIn: true, ...over }), pub(cfg))
  if (!opts.quick) await pg.query(`UPDATE appointments SET created_at = created_at - interval '1 hour' WHERE id = $1`, [appointment.id])
  const appt = await cancelAppointment(appointment.id, { actor: by.by === 'customer' ? 'customer' : 'Manager Mia', now: BOOK_NOW, ...by })
  return { appt, cfg }
}
const emails = (apptId: string) => rows<{ kind: string; status: string; send_after: Date; error: string | null }>(
  `SELECT kind, status, send_after, error FROM appointment_notifications WHERE appointment_id = '${apptId}' AND kind LIKE 'recovery%' ORDER BY kind`)
/** Run the recovery dispatcher as of the moment a given email is due. */
async function runAt(apptId: string, kind: string) {
  const [n] = await rows<{ send_after: Date }>(`SELECT send_after FROM appointment_notifications WHERE appointment_id = '${apptId}' AND kind = '${kind}'`)
  return dispatchDue({ now: new Date(new Date(n.send_after).getTime() + 1000), provider, only: 'recovery' })
}

describe('enrolment at cancellation', () => {
  it('ships dark: with the defaults a customer cancellation is queued for review and NO recovery email exists', async () => {
    const { appt } = await bookAndCancel({})
    const rec = await getRecoveryForAppointment(appt.id)
    expect(rec).toMatchObject({ status: 'review', origin: 'customer', reason: REASONS.emailsOff })
    expect(await emails(appt.id)).toEqual([])
    // The existing cancellation notice is still queued exactly as before.
    expect(await count('appointment_notifications', `appointment_id = '${appt.id}' AND kind = 'cancellation' AND status = 'pending'`)).toBe(1)
    await dispatchDue({ now: new Date(Date.now() + 30 * 86_400_000), provider, only: 'recovery' })
    expect(sent).toEqual([])
  })

  it('with both switches on, a customer cancellation starts the three-email sequence on schedule', async () => {
    const { appt } = await bookAndCancel()
    const rec = await getRecoveryForAppointment(appt.id)
    expect(rec).toMatchObject({ status: 'active', origin: 'customer', reason: null })
    const q = await emails(appt.id)
    expect(q.map((e) => [e.kind, e.status])).toEqual([['recovery_1', 'pending'], ['recovery_2', 'pending'], ['recovery_3', 'pending']])
    const cancelled = appt.cancelledAt!.getTime()
    const hours = q.map((e) => (new Date(e.send_after).getTime() - cancelled) / 3_600_000)
    // Never earlier than the configured delay; at most one overnight wait for the send window.
    expect(hours[0]).toBeGreaterThanOrEqual(2); expect(hours[0]).toBeLessThan(2 + 14)
    expect(hours[1]).toBeGreaterThanOrEqual(72); expect(hours[1]).toBeLessThan(72 + 14)
    expect(hours[2]).toBeGreaterThanOrEqual(168); expect(hours[2]).toBeLessThan(168 + 14)
  })

  it('a Pitt Stop cancellation is never enrolled; an unrecorded staff cancel waits for review; "customer asked" starts', async () => {
    const shop = await bookAndCancel(LIVE, { by: 'staff', initiator: 'shop' })
    expect(await getRecoveryForAppointment(shop.appt.id)).toBeNull()
    expect(await emails(shop.appt.id)).toEqual([])

    const unknown = await bookAndCancel(LIVE, { by: 'staff' }, { email: 'fictional.unknown@example.com', phone: '(979) 555-0143', time: '09:00' })
    expect(await getRecoveryForAppointment(unknown.appt.id)).toMatchObject({ status: 'review', origin: 'unknown', reason: REASONS.unknownOrigin })
    expect(await emails(unknown.appt.id)).toEqual([])

    const asked = await bookAndCancel(LIVE, { by: 'staff', initiator: 'customer' }, { email: 'fictional.asked@example.com', phone: '(979) 555-0144', time: '09:15' })
    expect(await getRecoveryForAppointment(asked.appt.id)).toMatchObject({ status: 'active', origin: 'customer' })
    // The staff member's answer is on the append-only cancel event.
    expect(await count('appointment_events', `appointment_id = '${asked.appt.id}' AND event_type = 'cancelled' AND meta->>'initiator' = 'customer'`)).toBe(1)
  })

  it('a customer with no email is queued for a phone follow-up, never an email', async () => {
    const cfg = await setCfg(LIVE)
    const { appointment } = await createAppointment(input({ email: '' }), { ...pub(cfg), mode: 'staff', source: 'phone', actor: 'Employee Eli' })
    const appt = await cancelAppointment(appointment.id, { actor: 'Manager Mia', by: 'staff', initiator: 'customer', now: BOOK_NOW })
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'review', reason: REASONS.noEmail })
    expect(await emails(appt.id)).toEqual([])
  })

  it('a customer who unsubscribed is queued but never emailed, and a manager cannot start it either', async () => {
    const cfg = await setCfg(LIVE)
    const { appointment } = await createAppointment(input(), pub(cfg))
    await pg.query(`INSERT INTO marketing_preferences (customer_id, email_eligible, unsubscribed_at, unsubscribe_scope) VALUES ($1, false, now(), 'all')`, [appointment.customerId])
    const appt = await cancelAppointment(appointment.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
    const rec = await getRecoveryForAppointment(appt.id)
    expect(rec).toMatchObject({ status: 'review', reason: REASONS.optedOut })
    await expect(startSequence(rec!.id, 'Manager Mia')).rejects.toThrow(REASONS.optedOut)
    expect(await emails(appt.id)).toEqual([])
  })

  it('cancelling one of two bookings is not a lost customer — nothing is enrolled', async () => {
    const cfg = await setCfg(LIVE)
    const a = await createAppointment(input(), pub(cfg))
    await createAppointment(input({ date: WED, time: '09:00' }), pub(cfg))
    await cancelAppointment(a.appointment.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
    expect(await getRecoveryForAppointment(a.appointment.id)).toBeNull()
  })

  it('a failure inside recovery can never undo or block the cancellation', async () => {
    const cfg = await setCfg(LIVE)
    const { appointment } = await createAppointment(input(), pub(cfg))
    await pg.exec('ALTER TABLE appointment_recoveries RENAME TO appointment_recoveries_gone')
    try {
      const appt = await cancelAppointment(appointment.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
      expect(appt.status).toBe('cancelled')
      expect(await count('appointment_notifications', `appointment_id = '${appt.id}' AND kind = 'cancellation'`)).toBe(1)
    } finally {
      await pg.exec('ALTER TABLE appointment_recoveries_gone RENAME TO appointment_recoveries')
    }
  })
})

describe('duplicate prevention', () => {
  it('one cancellation gets one recovery and each email exists once, however often enrolment or start runs', async () => {
    const { appt, cfg } = await bookAndCancel()
    const again = await enrollCancellation(appt, 'customer', { cfg })
    expect(again.verdict.enroll).toBe(false)
    const rec = (await getRecoveryForAppointment(appt.id))!
    await expect(startSequence(rec.id, 'Manager Mia')).rejects.toThrow(/already running/)
    await expect(enrollManually(appt.id, 'Manager Mia')).rejects.toThrow(/Already in the Lead Recovery queue/)
    expect(await count('appointment_recoveries', `appointment_id = '${appt.id}'`)).toBe(1)
    expect((await emails(appt.id)).length).toBe(3)
    expect(await count('appointment_recovery_events', `recovery_id = '${rec.id}' AND event_type = 'sequence_started'`)).toBe(1)
  })

  it('cancelling twice (double-tap) enrols once', async () => {
    const { appt } = await bookAndCancel()
    await cancelAppointment(appt.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
    expect(await count('appointment_recoveries')).toBe(1)
    expect((await emails(appt.id)).length).toBe(3)
  })

  it('running the dispatcher repeatedly, even concurrently, sends each email once', async () => {
    const { appt } = await bookAndCancel()
    const [n] = await rows<{ send_after: Date }>(`SELECT send_after FROM appointment_notifications WHERE appointment_id = '${appt.id}' AND kind = 'recovery_1'`)
    const now = new Date(new Date(n.send_after).getTime() + 1000)
    await Promise.all([dispatchDue({ now, provider, only: 'recovery' }), dispatchDue({ now, provider, only: 'recovery' }), dispatchDue({ now, provider, only: 'recovery' })])
    await dispatchDue({ now, provider, only: 'recovery' })
    expect(sent.length).toBe(1)
    expect((await emails(appt.id)).map((e) => e.status)).toEqual(['sent', 'pending', 'pending'])
  })
})

describe('the sequence', () => {
  it('sends 1, 2, 3 in order with the customer’s link and opt-out, then finishes', async () => {
    const { appt } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    await runAt(appt.id, 'recovery_1')
    expect(sent.length).toBe(1)
    expect(sent[0].to).toBe('fictional.canceller@example.com')
    expect(sent[0].subject).toBe('Need to reschedule your appointment?')
    expect(sent[0].text).toContain('your 2020 Honda Civic was canceled')
    expect(sent[0].text).toContain(`/book/c/${recoveryToken(rec.id)}`)
    const [pref] = await rows<{ unsubscribe_token: string }>(`SELECT unsubscribe_token FROM marketing_preferences WHERE customer_id = '${appt.customerId}'`)
    expect(sent[0].text).toContain(`/unsubscribe/${pref.unsubscribe_token}`)
    expect(sent[0].headers?.[0]).toEqual({ name: 'List-Unsubscribe', value: expect.stringContaining(`/unsubscribe/${pref.unsubscribe_token}`) })
    // The link never carries customer details.
    expect(sent[0].text).not.toMatch(/book\/c\/[^\s]*(fictional|canceller|555)/i)
    expect((await getRecoveryForAppointment(appt.id))!.lastContactAt).toBeTruthy()

    await runAt(appt.id, 'recovery_2')
    expect(sent[1].subject).toBe('Still interested in getting your 2020 Honda Civic taken care of?')
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('active')
    await runAt(appt.id, 'recovery_3')
    expect(sent[2].subject).toBe('We’re here whenever you’re ready')
    expect(sent.length).toBe(3)
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('finished')
    expect(await count('appointment_recovery_events', `recovery_id = '${rec.id}' AND event_type = 'email_sent'`)).toBe(3)
  })

  it('emails that came due together never go out together: the older one gives way', async () => {
    const { appt } = await bookAndCancel()
    await runAt(appt.id, 'recovery_2') // e.g. the job was down for days: 1 and 2 are both due
    expect(sent.length).toBe(1)
    expect(sent[0].subject).toContain('Still interested')
    expect((await emails(appt.id)).map((e) => e.status)).toEqual(['skipped', 'sent', 'pending'])
  })

  it('the existing booking notices are untouched by a recovery-only run', async () => {
    const { appt } = await bookAndCancel()
    await runAt(appt.id, 'recovery_3')
    expect(await count('appointment_notifications', `appointment_id = '${appt.id}' AND kind = 'cancellation' AND status = 'pending'`)).toBe(1)
  })
})

describe('stop conditions', () => {
  it('an opt-out after the emails were queued stops the sequence at send time', async () => {
    const { appt } = await bookAndCancel()
    await runAt(appt.id, 'recovery_1')
    await pg.query(`UPDATE marketing_preferences SET email_eligible = false, unsubscribed_at = now(), unsubscribe_scope = 'all' WHERE customer_id = $1`, [appt.customerId])
    await runAt(appt.id, 'recovery_3')
    expect(sent.length).toBe(1)
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'stopped', reason: REASONS.optedOut })
    expect((await emails(appt.id)).map((e) => e.status)).toEqual(['sent', 'skipped', 'skipped'])
  })

  it('an SMS-only unsubscribe does not block recovery email', async () => {
    const { appt } = await bookAndCancel()
    await pg.query(`INSERT INTO marketing_preferences (customer_id, unsubscribed_at, unsubscribe_scope) VALUES ($1, now(), 'sms')
      ON CONFLICT (customer_id) DO UPDATE SET unsubscribed_at = now(), unsubscribe_scope = 'sms'`, [appt.customerId])
    await runAt(appt.id, 'recovery_1')
    expect(sent.length).toBe(1)
  })

  it('staff stop, "not interested" and "recovered" each end the sequence and retire unsent emails', async () => {
    for (const how of ['stop', 'not_interested', 'recovered'] as const) {
      const { appt } = await bookAndCancel(LIVE, { by: 'customer' }, { email: `fictional.${how}@example.com`, phone: `(979) 555-01${50 + seq}`, time: how === 'stop' ? '08:00' : how === 'recovered' ? '08:15' : '08:30' })
      const rec = (await getRecoveryForAppointment(appt.id))!
      if (how === 'stop') expect(await stopSequence(rec.id, 'Manager Mia', 'Stopped by staff.')).toBe(true)
      else await setStaffOutcome(rec.id, how, 'Manager Mia')
      expect((await getRecoveryForAppointment(appt.id))!.status).toBe('stopped')
      expect((await emails(appt.id)).every((e) => e.status === 'skipped')).toBe(true)
      await runAt(appt.id, 'recovery_3')
    }
    expect(sent).toEqual([])
  })

  it('"contacted" is a note: it records the contact and does not stop the emails', async () => {
    const { appt } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    await setStaffOutcome(rec.id, 'contacted', 'Manager Mia')
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'active', staffOutcome: 'contacted' })
    await runAt(appt.id, 'recovery_1')
    expect(sent.length).toBe(1)
  })

  it('pause holds the unsent emails; resume releases exactly those, re-timed from now', async () => {
    const { appt } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    await runAt(appt.id, 'recovery_1')
    expect(await pauseSequence(rec.id, 'Manager Mia')).toBe(true)
    expect((await emails(appt.id)).map((e) => [e.status, e.error])).toEqual([['sent', null], ['skipped', PAUSED_NOTE], ['skipped', PAUSED_NOTE]])
    await dispatchDue({ now: new Date(Date.now() + 20 * 86_400_000), provider, only: 'recovery' })
    expect(sent.length).toBe(1)

    const resumedAt = new Date()
    await resumeSequence(rec.id, 'Manager Mia', { now: resumedAt })
    const q = await emails(appt.id)
    expect(q.map((e) => e.status)).toEqual(['sent', 'pending', 'pending'])
    expect(new Date(q[1].send_after).getTime()).toBeGreaterThanOrEqual(resumedAt.getTime())
    // The gap between emails 2 and 3 is kept (168 h − 72 h), give or take one overnight send-window wait.
    const gap = (new Date(q[2].send_after).getTime() - new Date(q[1].send_after).getTime()) / 3_600_000
    expect(gap).toBeGreaterThan(96 - 14); expect(gap).toBeLessThan(96 + 14)
  })

  it('the master switch is a kill switch: turned off, nothing sends and the sequence pauses', async () => {
    const { appt } = await bookAndCancel()
    await setCfg({ recoveryEmailsEnabled: false, recoveryAutoStart: true })
    await runAt(appt.id, 'recovery_1')
    expect(sent).toEqual([])
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('paused')
    // Turning it back on does not release anything by itself.
    await setCfg(LIVE)
    await dispatchDue({ now: new Date(Date.now() + 20 * 86_400_000), provider, only: 'recovery' })
    expect(sent).toEqual([])
  })

  it('a rejected (undeliverable) address stops the sequence; later emails are never attempted', async () => {
    const { appt } = await bookAndCancel()
    nextResult = { status: 'failed', retryable: false, error: '422 inactive recipient', code: 406 }
    await runAt(appt.id, 'recovery_1')
    nextResult = null
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'stopped', reason: REASONS.undeliverable })
    await runAt(appt.id, 'recovery_3')
    expect(sent).toEqual([])
    expect((await emails(appt.id)).map((e) => e.status)).toEqual(['failed', 'skipped', 'skipped'])
  })

  it('a temporary provider fault is retried, not treated as undeliverable', async () => {
    const { appt } = await bookAndCancel()
    nextResult = { status: 'failed', retryable: true, error: '503 busy' }
    await runAt(appt.id, 'recovery_1')
    nextResult = null
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('active')
    expect((await emails(appt.id))[0].status).toBe('pending')
  })

  it('a manual send obeys the same rules: refused while the switch is off, gated when it is on', async () => {
    const { appt } = await bookAndCancel({})
    const rec = (await getRecoveryForAppointment(appt.id))!
    await expect(sendNextNow(rec.id, 'Manager Mia')).rejects.toThrow(REASONS.emailsOff)
    await expect(startSequence(rec.id, 'Manager Mia')).rejects.toThrow(REASONS.emailsOff)
    await setCfg({ recoveryEmailsEnabled: true })
    const now = new Date()
    const res = await sendNextNow(rec.id, 'Manager Mia', { now })
    expect(res.kind).toBe('recovery_1')
    await dispatchDue({ now: new Date(now.getTime() + 1000), provider, appointmentId: appt.id, only: 'recovery' })
    expect(sent.length).toBe(1)
    expect(await count('appointment_recovery_events', `recovery_id = '${rec.id}' AND event_type = 'manual_send' AND actor = 'Manager Mia'`)).toBe(1)
  })
})

describe('rebooking and attribution', () => {
  it('booking through the recovery link credits the cancellation, stops the emails and keeps the original lead and source', async () => {
    const { appt, cfg } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    await runAt(appt.id, 'recovery_1')
    const leadsBefore = await count('marketing_leads')
    const attrBefore = await count('marketing_attribution')

    const { appointment: again } = await createAppointment(input({ date: WED, time: '09:00', recoveryToken: recoveryToken(rec.id) }), pub(cfg))
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'rebooked', rebookedAppointmentId: again.id, rebookMatch: 'link', rebookReview: null })
    expect((await emails(appt.id)).map((e) => e.status)).toEqual(['sent', 'skipped', 'skipped'])
    // Same lead, same first-touch attribution — a recovered customer is not a new acquisition.
    expect(again.marketingLeadId).toBe(appt.marketingLeadId)
    expect(await count('marketing_leads')).toBe(leadsBefore)
    expect(await count('marketing_attribution')).toBe(attrBefore)
    expect(await count('marketing_leads', `id = '${appt.marketingLeadId}' AND source = 'google_ads'`)).toBe(1)
    await runAt(appt.id, 'recovery_3')
    expect(sent.length).toBe(1)
  })

  it('a booking without the link stops the emails but is only an uncertain match until a manager confirms it', async () => {
    const { appt, cfg } = await bookAndCancel()
    const { appointment: again } = await createAppointment(input({ date: WED, time: '09:00' }), pub(cfg))
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'rebooked', rebookedAppointmentId: again.id, rebookMatch: 'contact', rebookReview: 'pending' })
    expect((await emails(appt.id)).every((e) => e.status === 'skipped')).toBe(true)
    // Uncertain: a normal new lead was created, and it is not counted as a recovery yet.
    expect(again.marketingLeadId).not.toBe(appt.marketingLeadId)
    const range = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) }
    expect(await recoveryReport(range)).toMatchObject({ eligible: 1, rebooked: 0, rebookedUnconfirmed: 1 })
    expect((await listRecoveries('attention')).map((r) => r.id)).toContain((await getRecoveryForAppointment(appt.id))!.id)

    await reviewRebookMatch((await getRecoveryForAppointment(appt.id))!.id, 'confirmed', 'Manager Mia')
    expect(await recoveryReport(range)).toMatchObject({ rebooked: 1, rebookedUnconfirmed: 0 })
    await expect(reviewRebookMatch((await getRecoveryForAppointment(appt.id))!.id, 'rejected', 'Manager Mia')).rejects.toThrow(/already been reviewed/)
  })

  it('the send-time gate catches a booking that no one linked (e.g. the post-booking step failed)', async () => {
    const { appt } = await bookAndCancel()
    await pg.query(`INSERT INTO appointments (reference, token_hash, idempotency_key, status, local_date, local_time, starts_at, first_name, email)
      VALUES ('PS-RAWRAW', 'h-raw', 'k-raw', 'confirmed', '2030-01-09', '09:30', '2030-01-09T15:30:00Z', 'Fictional', 'FICTIONAL.CANCELLER@example.com')`)
    await runAt(appt.id, 'recovery_1')
    expect(sent).toEqual([])
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'rebooked', rebookMatch: 'contact', rebookReview: 'pending' })
  })

  it('staff rebooking from the queue is a certain match', async () => {
    const { appt, cfg } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    const { appointment: again } = await createAppointment(input({ date: WED, time: '09:00', recoveryId: rec.id }), { ...pub(cfg), mode: 'staff', source: 'phone', actor: 'Manager Mia' })
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'rebooked', rebookedAppointmentId: again.id, rebookMatch: 'staff' })
    expect(again.marketingLeadId).toBe(appt.marketingLeadId)
  })

  it('a recovery token is never trusted from a staff entry, and a bad token never breaks a booking', async () => {
    const { appt, cfg } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    const other = await createAppointment(input({ date: WED, time: '09:00', email: 'someone.else@example.com', phone: '(979) 555-0199', recoveryToken: recoveryToken(rec.id) }), { ...pub(cfg), mode: 'staff', source: 'phone', actor: 'Employee Eli' })
    expect(other.appointment.status).toBe('confirmed')
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('active')
    const bad = await createAppointment(input({ date: WED, time: '09:15', email: 'another.person@example.com', phone: '(979) 555-0198', recoveryToken: 'B'.repeat(32) }), pub(cfg))
    expect(bad.appointment.status).toBe('confirmed')
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('active')
  })

  it('one new booking is credited to one cancellation only, and a cancellation is credited once', async () => {
    const cfg = await setCfg(LIVE)
    const first = await createAppointment(input(), pub(cfg))
    const a1 = await cancelAppointment(first.appointment.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
    const second = await createAppointment(input({ time: '09:00' }), pub(cfg))
    // The second booking answered the first cancellation…
    expect(await getRecoveryForAppointment(a1.id)).toMatchObject({ status: 'rebooked', rebookedAppointmentId: second.appointment.id })
    // …then is itself cancelled, and a third booking arrives.
    const a2 = await cancelAppointment(second.appointment.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
    const third = await createAppointment(input({ date: WED, time: '09:00' }), pub(cfg))
    expect(await getRecoveryForAppointment(a2.id)).toMatchObject({ status: 'rebooked', rebookedAppointmentId: third.appointment.id })
    expect((await getRecoveryForAppointment(a1.id))!.rebookedAppointmentId).toBe(second.appointment.id)
    expect(await count('appointment_recoveries', `rebooked_appointment_id = '${third.appointment.id}'`)).toBe(1)
    expect(await detectRebookings()).toBe(0)
  })
})

describe('reporting — revenue only when completed AND paid, counted once', () => {
  const range = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) })
  async function recoveredWithJob(job: { status: string; completed: boolean; paid: boolean; total: number }) {
    const { appt, cfg } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    await runAt(appt.id, 'recovery_1')
    const { appointment: again } = await createAppointment(input({ date: WED, time: '09:00', recoveryToken: recoveryToken(rec.id) }), pub(cfg))
    const so = '11111111-1111-4111-8111-111111111111'
    await pg.query(`INSERT INTO service_orders (id, status, completed_at) VALUES ($1, $2, $3)`, [so, job.status, job.completed ? new Date() : null])
    await pg.query(`INSERT INTO job_estimates (service_order_id, total_cents, qb_payment_status) VALUES ($1, $2, $3)`, [so, job.total, job.paid ? 'paid' : 'none'])
    await pg.query(`UPDATE appointments SET service_order_id = $1, status = 'arrived' WHERE id = $2`, [so, again.id])
    return { appt, again }
  }

  it('a rebooking alone is not revenue', async () => {
    const { appt, cfg } = await bookAndCancel()
    await runAt(appt.id, 'recovery_1')
    await createAppointment(input({ date: WED, time: '09:00', recoveryToken: recoveryToken((await getRecoveryForAppointment(appt.id))!.id) }), pub(cfg))
    expect(await recoveryReport(range())).toMatchObject({ eligible: 1, contacted: 1, emailsSent: 1, rebooked: 1, completed: 0, completedAndPaid: 0, recoveredRevenueCents: 0 })
  })

  it('a completed but unpaid job is counted as completed, with zero revenue', async () => {
    await recoveredWithJob({ status: 'ready', completed: true, paid: false, total: 215000 })
    expect(await recoveryReport(range())).toMatchObject({ rebooked: 1, completed: 1, completedAndPaid: 0, recoveredRevenueCents: 0, recoveredValueCents: 215000 })
  })

  it('a paid job that is not completed is not revenue either', async () => {
    await recoveredWithJob({ status: 'in_progress', completed: false, paid: true, total: 215000 })
    expect(await recoveryReport(range())).toMatchObject({ completed: 0, completedAndPaid: 0, recoveredRevenueCents: 0 })
  })

  it('completed and paid counts the job total exactly once', async () => {
    await recoveredWithJob({ status: 'delivered', completed: true, paid: true, total: 215000 })
    // A second estimate row on the same job must not double the money.
    await pg.query(`INSERT INTO job_estimates (service_order_id, total_cents, qb_payment_status, created_at) VALUES ('11111111-1111-4111-8111-111111111111', 215000, 'paid', now() - interval '1 day')`)
    expect(await recoveryReport(range())).toMatchObject({ eligible: 1, contacted: 1, rebooked: 1, completed: 1, completedAndPaid: 1, recoveredRevenueCents: 215000 })
  })

  it('a rebooking that is itself cancelled is not counted', async () => {
    const { again } = await recoveredWithJob({ status: 'delivered', completed: true, paid: true, total: 215000 })
    await pg.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [again.id])
    expect(await recoveryReport(range())).toMatchObject({ rebooked: 0, completedAndPaid: 0, recoveredRevenueCents: 0 })
  })

  it('an empty window reports honest zeros', async () => {
    expect(await recoveryReport({ from: new Date('2020-01-01'), to: new Date('2020-02-01') })).toEqual({
      eligible: 0, awaitingReview: 0, contacted: 0, emailsSent: 0, emailsUncertain: 0, emailsFailed: 0, rebooked: 0, rebookedUnconfirmed: 0,
      completed: 0, completedAndPaid: 0, recoveredValueCents: 0, recoveredRevenueCents: 0,
    })
  })
})

describe('older cancellations (the PS-BFJAJM shape) — recognised, never enrolled by themselves', () => {
  /** Booked online and cancelled by the customer BEFORE this feature existed: no recovery row. */
  async function historical(): Promise<Appointment> {
    const cfg = await setCfg(LIVE)
    const { appointment } = await createAppointment(input({ firstName: 'Fictional', lastName: 'Earlier', vehicleMake: 'Honda', vehicleModel: 'CR-V' }), pub(cfg))
    await cancelAppointment(appointment.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
    await pg.exec('DELETE FROM appointment_notifications WHERE kind LIKE \'recovery%\'; DELETE FROM appointment_recovery_events; DELETE FROM appointment_recoveries;')
    return (await getAppointment(appointment.id))!
  }

  it('is listed as a recovery opportunity with an honest value floor — and looking at the list changes nothing', async () => {
    const appt = await historical()
    const [c] = await listCandidates()
    expect(c.appointment.id).toBe(appt.id)
    expect(c.origin).toBe('customer')
    // Booked before the consent checkbox existed: an opportunity for the queue, never an automatic email.
    expect(c.verdict).toEqual({ enroll: true, start: false, reason: REASONS.noConsent })
    expect(c.tier).toBe(3)
    expect(c.value).toEqual({ minCents: 100000, priced: [{ label: 'Ceramic Coating', cents: 100000, from: true }], unpriced: ['Interior Detail', 'Odor / Ozone'] })
    expect(await count('appointment_recoveries')).toBe(0)
    expect(await count('appointment_notifications', `kind LIKE 'recovery%'`)).toBe(0)
  })

  it('no cron pass enrols it', async () => {
    await historical()
    await detectRebookings()
    await dispatchDue({ now: new Date(Date.now() + 30 * 86_400_000), provider, only: 'recovery' })
    expect(await count('appointment_recoveries')).toBe(0)
    expect(sent).toEqual([])
  })

  it('a manager can add it to the queue; that never starts emails, even with auto-start on', async () => {
    const appt = await historical()
    const res = await enrollManually(appt.id, 'Manager Mia')
    expect(res.started).toBe(false)
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'review', origin: 'customer', reason: REASONS.noConsent })
    expect(await emails(appt.id)).toEqual([])
    expect((await listRecoveries('attention'))[0]).toMatchObject({ reference: appt.reference, tier: 3, vehicle: '2020 Honda CR-V' })
    expect(await listCandidates()).toEqual([])
  })

  it('a Pitt Stop cancellation can be queued for a personal follow-up but can never be emailed', async () => {
    const { appt } = await bookAndCancel(LIVE, { by: 'staff', initiator: 'shop' })
    await enrollManually(appt.id, 'Manager Mia')
    const rec = (await getRecoveryForAppointment(appt.id))!
    expect(rec).toMatchObject({ status: 'review', origin: 'shop', reason: REASONS.shopCancelled })
    await expect(startSequence(rec.id, 'Manager Mia')).rejects.toThrow(REASONS.shopCancelled)
    await expect(sendNextNow(rec.id, 'Manager Mia')).rejects.toThrow(REASONS.shopCancelled)
    expect(await emails(appt.id)).toEqual([])
  })
})

describe('email-marketing consent', () => {
  it('ticking the box records an opt-in with wording, version, source, time and request details; the booking event records it too', async () => {
    const cfg = await setCfg(LIVE)
    const { appointment } = await createAppointment(input({ emailMarketingOptIn: true }), { ...pub(cfg), emailConsent: { ip: '203.0.113.9', userAgent: 'test-agent' } })
    const [e] = await rows<Record<string, unknown>>(`SELECT channel, event, source, wording_version, consent_text, ip, user_agent, created_at, meta FROM marketing_consent_events WHERE customer_id = '${appointment.customerId}' AND channel = 'email'`)
    expect(e).toMatchObject({ channel: 'email', event: 'opt_in', source: 'website_form', wording_version: EMAIL_CONSENT_VERSION, consent_text: EMAIL_CONSENT_TEXT, ip: '203.0.113.9', user_agent: 'test-agent' })
    expect(e.created_at).toBeTruthy()
    expect((e.meta as { appointmentId: string }).appointmentId).toBe(appointment.id)
    expect(await count('appointment_events', `appointment_id = '${appointment.id}' AND event_type = 'booked' AND meta->>'emailMarketingOptIn' = 'true'`)).toBe(1)
    expect(await hasEmailConsent(appointment)).toBe(true)
  })

  it('the box is off by default: no consent is recorded, and the appointment emails are queued exactly the same', async () => {
    const cfg = await setCfg(LIVE)
    const { appointment } = await createAppointment(input(), pub(cfg))
    expect(await count('marketing_consent_events', `channel = 'email'`)).toBe(0)
    expect(await hasEmailConsent(appointment)).toBe(false)
    const ticked = await createAppointment(input({ emailMarketingOptIn: true, email: 'fictional.ticked@example.com', phone: '(979) 555-0170', time: '09:00' }), pub(cfg))
    for (const a of [appointment, ticked.appointment]) {
      expect((await rows<{ kind: string }>(`SELECT kind FROM appointment_notifications WHERE appointment_id = '${a.id}' ORDER BY kind`)).map((r) => r.kind)).toEqual(['confirmation', 'reminder'])
    }
  })

  it('a staff-entered booking never records consent, whatever the request says', async () => {
    const cfg = await setCfg(LIVE)
    await createAppointment(input({ emailMarketingOptIn: true }), { ...pub(cfg), mode: 'staff', source: 'phone', actor: 'Employee Eli' })
    expect(await count('marketing_consent_events', `channel = 'email'`)).toBe(0)
  })

  it('without consent a cancellation waits in the queue; nobody can start emails until permission is recorded', async () => {
    const { appt } = await bookAndCancel(LIVE, { by: 'customer' }, { emailMarketingOptIn: false })
    const rec = (await getRecoveryForAppointment(appt.id))!
    expect(rec).toMatchObject({ status: 'review', reason: REASONS.noConsent })
    expect(await emails(appt.id)).toEqual([])
    await expect(startSequence(rec.id, 'Manager Mia')).rejects.toThrow(REASONS.noConsent)
    await expect(sendNextNow(rec.id, 'Manager Mia')).rejects.toThrow(REASONS.noConsent)
    expect((await listRecoveries('attention'))[0]).toMatchObject({ emailConsent: false })

    await recordManagerEmailConsent(rec.id, 'Manager Mia')
    const [e] = await rows<Record<string, unknown>>(`SELECT event, source, actor FROM marketing_consent_events WHERE customer_id = '${appt.customerId}' AND channel = 'email'`)
    expect(e).toEqual({ event: 'opt_in', source: 'manager', actor: 'Manager Mia' })
    expect((await listRecoveries('attention'))[0]).toMatchObject({ emailConsent: true })
    await startSequence(rec.id, 'Manager Mia')
    expect((await emails(appt.id)).length).toBe(3)
  })

  it('consent withdrawn after the emails were queued stops them at send time', async () => {
    const { appt } = await bookAndCancel()
    await pg.query(`INSERT INTO marketing_consent_events (customer_id, channel, event, source, created_at) VALUES ($1, 'email', 'opt_out', 'manager', now() + interval '1 second')`, [appt.customerId])
    await runAt(appt.id, 'recovery_1')
    expect(sent).toEqual([])
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'stopped', reason: REASONS.noConsent })
  })

  it('a manager cannot record permission for someone who unsubscribed', async () => {
    const { appt } = await bookAndCancel(LIVE, { by: 'customer' }, { emailMarketingOptIn: false })
    await pg.query(`INSERT INTO marketing_preferences (customer_id, email_eligible, unsubscribed_at, unsubscribe_scope) VALUES ($1, false, now(), 'all')`, [appt.customerId])
    await expect(recordManagerEmailConsent((await getRecoveryForAppointment(appt.id))!.id, 'Manager Mia')).rejects.toThrow(/unsubscribed/)
  })
})

describe('cancelled within five minutes of booking', () => {
  it('the first email asks whether they need help; the next two are the standard ones', async () => {
    const { appt } = await bookAndCancel(LIVE, { by: 'customer' }, {}, { quick: true })
    expect((await listRecoveries('running'))[0]).toMatchObject({ quickCancel: true })
    await runAt(appt.id, 'recovery_1')
    expect(sent[0].subject).toBe('Need a hand with your booking?')
    expect(sent[0].text).toContain('canceled shortly after you booked it')
    await runAt(appt.id, 'recovery_2')
    expect(sent[1].subject).toContain('Still interested')
  })
  it('a normal cancellation keeps the reschedule wording', async () => {
    const { appt } = await bookAndCancel()
    expect((await listRecoveries('running'))[0]).toMatchObject({ quickCancel: false })
    await runAt(appt.id, 'recovery_1')
    expect(sent[0].subject).toBe('Need to reschedule your appointment?')
  })
})

describe('streams', () => {
  it('recovery emails go out on the broadcast stream; the cancellation notice stays on the default transactional stream', async () => {
    const { appt } = await bookAndCancel()
    const [n] = await rows<{ send_after: Date }>(`SELECT send_after FROM appointment_notifications WHERE appointment_id = '${appt.id}' AND kind = 'recovery_1'`)
    await dispatchDue({ now: new Date(new Date(n.send_after).getTime() + 1000), provider })   // every kind, as the daily job does
    const recoveryMail = sent.find((m) => m.subject.startsWith('Need to reschedule'))!
    const cancelMail = sent.find((m) => m.subject.startsWith('Appointment cancelled'))!
    expect(recoveryMail.messageStream).toBe('broadcast')
    expect(cancelMail.messageStream).toBeUndefined()
    expect(cancelMail.headers).toBeUndefined()
  })
  it('a setup rejection (e.g. the stream does not exist) fails that email but does NOT mark the customer undeliverable', async () => {
    const { appt } = await bookAndCancel()
    nextResult = { status: 'failed', retryable: false, error: '422 The MessageStream provided does not exist', code: 1235 }
    await runAt(appt.id, 'recovery_1')
    nextResult = null
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('active')
    expect((await emails(appt.id))[0].status).toBe('failed')
  })
})

describe('scheduler — timing, duplicates and restarts', () => {
  it('ticking every hour: nothing goes early, each email goes on the first tick after it is due, and never twice', async () => {
    const { appt } = await bookAndCancel()
    const due = (await emails(appt.id)).map((e) => new Date(e.send_after).getTime())
    const start = appt.cancelledAt!.getTime()
    const sentAt: number[] = []
    for (let t = start; t <= start + 9 * 86_400_000; t += 3_600_000) {
      const before = sent.length
      await reconcileRecoveries({ now: new Date(t) })
      await dispatchDue({ now: new Date(t), provider, only: 'recovery' })
      if (sent.length > before) { expect(sent.length).toBe(before + 1); sentAt.push(t) }
    }
    expect(sent.length).toBe(3)
    sentAt.forEach((t, i) => { expect(t).toBeGreaterThanOrEqual(due[i]); expect(t - due[i]).toBeLessThan(3_600_000) })
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('finished')
  })

  it('a run that died AFTER the provider call began is never resent: marked uncertain, and the sequence carries on', async () => {
    const { appt } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    const [n] = await rows<{ id: string; send_after: Date }>(`SELECT id, send_after FROM appointment_notifications WHERE appointment_id = '${appt.id}' AND kind = 'recovery_1'`)
    // Simulate the crash: claimed, gate passed, provider call started, process gone before the outcome was written.
    await pg.query(`UPDATE appointment_notifications SET status = 'sending', attempts = 1 WHERE id = $1`, [n.id])
    await pg.query(`INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta, created_at) VALUES ($1, 'email_claimed', 'system', $2::jsonb, now() - interval '2 hours'), ($1, 'email_sending', 'system', $2::jsonb, now() - interval '2 hours' + interval '1 second')`,
      [rec.id, JSON.stringify({ notificationId: n.id, step: 1 })])
    // The stuck email holds its successor back until it is recovered…
    await dispatchDue({ now: new Date(Date.now() + 4 * 86_400_000), provider, only: 'recovery' })
    expect(sent).toEqual([])
    // …then the next scheduled run repairs it without sending it again.
    expect(await recoverInterruptedEmails()).toBe(1)
    expect((await emails(appt.id))[0]).toMatchObject({ status: 'uncertain' })
    await runAt(appt.id, 'recovery_2')
    expect(sent.length).toBe(1)
    expect(sent[0].subject).toContain('Still interested')
    await dispatchDue({ now: new Date(Date.now() + 5 * 86_400_000), provider, only: 'recovery' })
    expect(sent.filter((m) => m.subject.startsWith('Need to reschedule'))).toEqual([])
  })

  it('a run that died BEFORE the provider call is retried — exactly once', async () => {
    const { appt } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    const [n] = await rows<{ id: string }>(`SELECT id FROM appointment_notifications WHERE appointment_id = '${appt.id}' AND kind = 'recovery_1'`)
    await pg.query(`UPDATE appointment_notifications SET status = 'sending', attempts = 1 WHERE id = $1`, [n.id])
    await pg.query(`INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta, created_at) VALUES ($1, 'email_claimed', 'system', $2::jsonb, now() - interval '2 hours')`, [rec.id, JSON.stringify({ notificationId: n.id, step: 1 })])
    expect(await recoverInterruptedEmails()).toBe(1)
    expect((await emails(appt.id))[0].status).toBe('pending')
    await runAt(appt.id, 'recovery_1'); await runAt(appt.id, 'recovery_1')
    expect(sent.length).toBe(1)
  })

  it('an email another run claimed moments ago is left alone', async () => {
    const { appt } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    const [n] = await rows<{ id: string }>(`SELECT id FROM appointment_notifications WHERE appointment_id = '${appt.id}' AND kind = 'recovery_1'`)
    await pg.query(`UPDATE appointment_notifications SET status = 'sending' WHERE id = $1`, [n.id])
    await pg.query(`INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta) VALUES ($1, 'email_claimed', 'system', $2::jsonb)`, [rec.id, JSON.stringify({ notificationId: n.id, step: 1 })])
    expect(await recoverInterruptedEmails()).toBe(0)
    expect((await emails(appt.id))[0].status).toBe('sending')
  })

  it('everything queued survives a restart: state lives in the database, so a fresh process picks up where the last one stopped', async () => {
    const { appt } = await bookAndCancel()
    await runAt(appt.id, 'recovery_1')
    vi.resetModules()   // a new server instance: nothing carried over in memory
    const fresh = await import('./notify')
    const [n] = await rows<{ send_after: Date }>(`SELECT send_after FROM appointment_notifications WHERE appointment_id = '${appt.id}' AND kind = 'recovery_2'`)
    await fresh.dispatchDue({ now: new Date(new Date(n.send_after).getTime() + 1000), provider, only: 'recovery' })
    expect(sent.map((m) => m.subject)).toEqual(['Need to reschedule your appointment?', 'Still interested in getting your 2020 Honda Civic taken care of?'])
  })
})

describe('payments made directly in QuickBooks', () => {
  it('re-checks only recovered jobs that are completed, invoiced and not yet marked paid', async () => {
    const { appt, cfg } = await bookAndCancel()
    const rec = (await getRecoveryForAppointment(appt.id))!
    const { appointment: again } = await createAppointment(input({ date: WED, time: '09:00', recoveryToken: recoveryToken(rec.id) }), pub(cfg))
    const so = '22222222-2222-4222-8222-222222222222'
    await pg.exec(`ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_invoice_id varchar(100)`)
    await pg.query(`INSERT INTO service_orders (id, status, completed_at) VALUES ($1, 'delivered', now())`, [so])
    await pg.query(`INSERT INTO job_estimates (service_order_id, total_cents, qb_payment_status, qb_invoice_id) VALUES ($1, 215000, 'none', 'QB-1')`, [so])
    await pg.query(`UPDATE appointments SET service_order_id = $1, status = 'arrived' WHERE id = $2`, [so, again.id])
    const asked: string[] = []
    // Stand-in for the existing QuickBooks read path, which adopts a zero balance as paid.
    const check = async (orderId: string) => { asked.push(orderId); await pg.query(`UPDATE job_estimates SET qb_payment_status = 'paid' WHERE service_order_id = $1`, [orderId]) }
    expect(await refreshRecoveredPayments({ check })).toEqual({ checked: 1, failed: 0 })
    expect(asked).toEqual([so])
    const range = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) }
    expect(await recoveryReport(range)).toMatchObject({ completedAndPaid: 1, recoveredRevenueCents: 215000, recoveredValueCents: 215000 })
    // Already paid → not asked again.
    expect(await refreshRecoveredPayments({ check })).toEqual({ checked: 0, failed: 0 })
    expect(asked.length).toBe(1)
  })
  it('a QuickBooks problem is counted, never thrown', async () => {
    expect(await refreshRecoveredPayments({ check: async () => { throw new Error('QuickBooks unreachable') } })).toEqual({ checked: 0, failed: 0 })
  })
})

describe('historical import (scripts/recovery-backfill.ts)', () => {
  it('lands in the review queue only: no email is queued even with both switches on and permission on record, and a re-run adds nothing', async () => {
    const cfg = await setCfg(LIVE)
    const { appointment } = await createAppointment(input({ emailMarketingOptIn: true }), pub(cfg))
    await cancelAppointment(appointment.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
    await pg.exec(`DELETE FROM appointment_notifications WHERE kind LIKE 'recovery%'; DELETE FROM appointment_recovery_events; DELETE FROM appointment_recoveries;`)
    const appt = (await getAppointment(appointment.id))!
    const first = await enrollCancellation(appt, 'customer', { actor: 'backfill', historical: true, cfg })
    expect(first).toMatchObject({ started: false })
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'review', origin: 'customer', reason: REASONS.historical })
    expect(await emails(appt.id)).toEqual([])
    expect(await count('appointment_recovery_events', `event_type = 'enrolled' AND actor = 'backfill' AND meta->>'historical' = 'true'`)).toBe(1)
    const again = await enrollCancellation(appt, 'customer', { actor: 'backfill', historical: true, cfg })
    expect(again.verdict.enroll).toBe(false)
    expect(await count('appointment_recoveries')).toBe(1)
    await reconcileRecoveries(); await dispatchDue({ now: new Date(Date.now() + 30 * 86_400_000), provider, only: 'recovery' })
    expect(sent).toEqual([])
  })
  it('a customer with no permission on record is imported with that stated, and still cannot be emailed', async () => {
    const cfg = await setCfg(LIVE)
    const { appointment } = await createAppointment(input(), pub(cfg))
    await cancelAppointment(appointment.id, { actor: 'customer', by: 'customer', now: BOOK_NOW })
    await pg.exec(`DELETE FROM appointment_recovery_events; DELETE FROM appointment_recoveries;`)
    await enrollCancellation((await getAppointment(appointment.id))!, 'customer', { actor: 'backfill', historical: true, cfg })
    const rec = (await getRecoveryForAppointment(appointment.id))!
    expect(rec.reason).toBe(`${REASONS.historical} ${REASONS.noConsent}`)
    await expect(startSequence(rec.id, 'Manager Mia')).rejects.toThrow(REASONS.noConsent)
  })
  it('never imports a Pitt Stop cancellation', async () => {
    const { appt, cfg } = await bookAndCancel(LIVE, { by: 'staff', initiator: 'shop' })
    expect((await enrollCancellation(appt, 'shop', { actor: 'backfill', historical: true, cfg })).recoveryId).toBeNull()
  })
})

describe('Postmark broadcast stream — suppression sync and stream check', () => {
  const PM = { APPOINTMENT_EMAIL_PROVIDER: 'postmark', POSTMARK_SERVER_TOKEN: 'test-token' } as unknown as NodeJS.ProcessEnv
  const urls: string[] = []
  const pmFetch = (routes: Record<string, [number, unknown]>) => (async (u: unknown, init?: { headers?: Record<string, string> }) => {
    urls.push(String(u)); expect(init?.headers?.['X-Postmark-Server-Token']).toBe('test-token')
    const hit = Object.entries(routes).find(([k]) => String(u).endsWith(k))
    return new Response(JSON.stringify(hit ? hit[1][1] : { Message: 'not found' }), { status: hit ? hit[1][0] : 404 })
  }) as unknown as typeof fetch
  const dump = (list: unknown[]) => pmFetch({ '/message-streams/broadcast/suppressions/dump': [200, { Suppressions: list }] })

  it('an unsubscribe made through Postmark’s own link blocks marketing email here, is logged, and stops the sequence at once', async () => {
    const { appt } = await bookAndCancel()
    await runAt(appt.id, 'recovery_1')
    const res = await syncPostmarkSuppressions({ env: PM, fetchImpl: dump([{ EmailAddress: 'Fictional.Canceller@Example.com', SuppressionReason: 'ManualSuppression', Origin: 'Recipient', CreatedAt: '2026-11-20T10:00:00Z' }]) })
    expect(res).toMatchObject({ enabled: true, seen: 1, customersBlocked: 1, sequencesStopped: 1 })
    expect(await count('marketing_preferences', `customer_id = '${appt.customerId}' AND email_eligible = false AND unsubscribe_reason = 'postmark:ManualSuppression'`)).toBe(1)
    expect(await count('marketing_consent_events', `customer_id = '${appt.customerId}' AND channel = 'email' AND event = 'opt_out' AND source = 'email_provider'`)).toBe(1)
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'stopped', reason: REASONS.optedOut })
    await runAt(appt.id, 'recovery_3')
    expect(sent.length).toBe(1)   // only the email sent before the unsubscribe
    // SMS consent is not touched by an email unsubscribe.
    expect(await count('marketing_preferences', `customer_id = '${appt.customerId}' AND unsubscribed_at IS NOT NULL`)).toBe(0)
    // Re-running changes nothing.
    const again = await syncPostmarkSuppressions({ env: PM, fetchImpl: dump([{ EmailAddress: 'fictional.canceller@example.com', SuppressionReason: 'ManualSuppression', Origin: 'Recipient' }]) })
    expect(again).toMatchObject({ seen: 1, customersBlocked: 0, sequencesStopped: 0 })
    expect(await count('marketing_consent_events', `customer_id = '${appt.customerId}' AND event = 'opt_out'`)).toBe(1)
  })

  it('after the sync nobody can restart or manually send, and a new cancellation by that customer is never auto-started', async () => {
    const { appt } = await bookAndCancel()
    await syncPostmarkSuppressions({ env: PM, fetchImpl: dump([{ EmailAddress: 'fictional.canceller@example.com', SuppressionReason: 'SpamComplaint', Origin: 'Recipient' }]) })
    const again = await bookAndCancel(LIVE, { by: 'customer' }, { time: '09:30' })
    const rec = (await getRecoveryForAppointment(again.appt.id))!
    expect(rec).toMatchObject({ status: 'review', reason: REASONS.optedOut })
    await expect(startSequence(rec.id, 'Manager Mia')).rejects.toThrow(REASONS.optedOut)
    await expect(recordManagerEmailConsent(rec.id, 'Manager Mia')).rejects.toThrow(/unsubscribed/)
    expect(await emails(again.appt.id)).toEqual([])
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('stopped')
  })

  it('a hard bounce stops the sequence as undeliverable', async () => {
    const { appt } = await bookAndCancel()
    await syncPostmarkSuppressions({ env: PM, fetchImpl: dump([{ EmailAddress: 'fictional.canceller@example.com', SuppressionReason: 'HardBounce', Origin: 'Recipient' }]) })
    expect(await getRecoveryForAppointment(appt.id)).toMatchObject({ status: 'stopped', reason: REASONS.undeliverable })
  })

  it('runs as part of every recovery pass, before dispatch — and a Postmark outage never breaks the pass', async () => {
    const { appt } = await bookAndCancel()
    const res = await reconcileRecoveries()   // Postmark not configured in tests → reported as disabled, nothing fetched
    expect(res.suppressions).toMatchObject({ enabled: false })
    expect(await syncPostmarkSuppressions({ env: PM, fetchImpl: pmFetch({}) })).toMatchObject({ enabled: true, seen: 0, problem: 'Postmark answered 404' })
    expect((await getRecoveryForAppointment(appt.id))!.status).toBe('active')
  })

  it('an address with no customer record, or junk in the list, is ignored safely', async () => {
    const res = await syncPostmarkSuppressions({ env: PM, fetchImpl: dump([{ EmailAddress: 'nobody.here@example.com', SuppressionReason: 'HardBounce' }, { EmailAddress: '' }, {}]) })
    expect(res).toMatchObject({ seen: 1, customersBlocked: 0, sequencesStopped: 0 })
  })

  it('stream check: ready only for a live broadcast stream; never throws; says why otherwise', async () => {
    const stream = (body: unknown, status = 200) => checkRecoveryStream({ env: PM, fetchImpl: pmFetch({ '/message-streams/broadcast': [status, body] }) })
    expect(await stream({ ID: 'broadcast', MessageStreamType: 'Broadcasts', ArchivedAt: null, SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Postmark' } }))
      .toEqual({ configured: true, stream: 'broadcast', ok: true, type: 'Broadcasts', unsubscribeHandling: 'Postmark', archived: false })
    expect(await stream({ ID: 'broadcast', MessageStreamType: 'Transactional' })).toMatchObject({ ok: false, problem: expect.stringContaining('not a broadcast stream') })
    expect(await stream({ ID: 'broadcast', MessageStreamType: 'Broadcasts', ArchivedAt: '2026-01-01' })).toMatchObject({ ok: false, problem: 'The stream is archived.' })
    expect(await stream({ Message: 'no such stream' }, 404)).toMatchObject({ ok: false, problem: expect.stringContaining('404') })
    expect(await checkRecoveryStream({ env: {} as NodeJS.ProcessEnv })).toMatchObject({ configured: false, ok: false })
    expect(await checkRecoveryStream({ env: PM, fetchImpl: (async () => { throw new TypeError('down') }) as unknown as typeof fetch })).toMatchObject({ ok: false })
  })
})
