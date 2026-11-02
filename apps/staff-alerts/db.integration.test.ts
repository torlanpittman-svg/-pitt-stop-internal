/**
 * The alert outbox against a real Postgres (PGlite) running the ACTUAL migrations — so the unique
 * indexes, the atomic fan-out and the booking statement's alert CTE are exercised, not mocked.
 *
 * What these tests are really protecting:
 *   • a booking is never lost or duplicated because of notifications;
 *   • a retry, a replayed submission or two workers can never notify the same phone twice;
 *   • a person who loses access, or a device that goes away, stops being notified;
 *   • nothing identifying the customer reaches a lock screen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { createAppointment, type BookingInput } from '@/apps/appointments/db'
import { DEFAULT_BOOKING_CONFIG, zonedToUtc, type BookingConfig } from '@/apps/appointments/policy'
import { fakeVpic } from '@/apps/appointments/test-vpic'
import {
  MAX_DELIVERY_ATTEMPTS, allowedRecipientKeys, disableSubscription, dispatchStaffAlerts, findSubscription,
  listSubscriptions, mayEnrol, newBookingDedupeKey, recentDeliveryProblems, recordNewBookingAlert,
  refreshSubscription, renderAlert, saveSubscription, sendTestNotification,
} from './db'
import { PUSH_SEND_TIMEOUT_MS, generateVapidKeys, type PushConfig } from './web-push'

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
  for (const f of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0058_appointments.sql', '0060_booking_drafts.sql', '0068_staff_push_alerts.sql']) {
    await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  }
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM staff_alert_deliveries; DELETE FROM staff_alerts; DELETE FROM staff_push_subscriptions;
    DELETE FROM appointment_notifications; DELETE FROM appointment_events; DELETE FROM appointments;
    DELETE FROM marketing_attribution; DELETE FROM marketing_events; DELETE FROM marketing_leads;
    DELETE FROM marketing_consent_events; DELETE FROM marketing_preferences; DELETE FROM customer_vehicles; DELETE FROM customers;`)
})

// ── fixtures ──────────────────────────────────────────────────────────────────

// Bookings are validated against a FIXED past clock (the booking rules care about weekday/lead time).
// Delivery, however, is compared against rows the database timestamped with its own now(), so the
// dispatch clock has to be the real present — not the booking clock.
const NOW = zonedToUtc('2026-10-19', '06:00', 'America/Chicago')
const TUE = '2026-10-20'
const dispatchNow = (offsetMs = 0) => new Date(Date.now() + offsetMs)
const HOUR = 3_600_000
const CFG: BookingConfig = { ...DEFAULT_BOOKING_CONFIG, enabled: true, confirmationEnabled: false, reminderEnabled: false }
const VAPID = generateVapidKeys()
const PUSH: PushConfig = { vapid: VAPID, subject: 'mailto:shop@example.com' }
const MANAGER = { key: 'torlan', name: 'Torlan', role: 'manager' as const }
const OTHER_MANAGER = { key: 'darryl', name: 'Darryl', role: 'manager' as const }

let seq = 0
const booking = (over: Partial<BookingInput> = {}): BookingInput => ({
  idempotencyKey: `book-${++seq}-aaaaaaaa`, date: TUE, time: '09:00', serviceKeys: ['complete_detail'],
  firstName: 'Alex', lastName: 'Rivera', phone: '(979) 555-0101', email: 'alex.rivera@example.com',
  vehicleType: 'car', vehicleYear: '2020', vehicleMake: 'Honda', vehicleModel: 'Civic', ...over,
})
/**
 * Books the way the real surfaces do: the public route records the alert right after the booking
 * commits (never inside it), the staff path records nothing.
 */
const book = async (over: Partial<BookingInput> = {}, mode: 'public' | 'staff' = 'public') => {
  const result = await createAppointment(booking(over), {
    mode, source: mode === 'public' ? 'website_booking' : 'phone', actor: mode === 'staff' ? 'Tony' : null,
    now: NOW, cfg: CFG, vehicleFetch: fakeVpic(),
  })
  if (mode === 'public' && !result.replayed) await recordNewBookingAlert(result.appointment.id)
  return result
}

// Real, well-formed subscription keys (the RFC 8291 §5 receiver) so encryption actually runs.
const UA_P256DH = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
const UA_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg'
const device = (actor = MANAGER, endpoint = `https://web.push.apple.com/${Math.random().toString(36).slice(2)}`) =>
  saveSubscription({ endpoint, p256dh: UA_P256DH, auth: UA_AUTH, deviceLabel: 'iPhone · Safari' }, actor)

const rows = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => (await pg.query(sql)).rows as T[]
const count = async (table: string, where = 'true') => ((await pg.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0] as { n: number }).n
/**
 * Enrolment timestamps are compared in SQL, at the database's microsecond resolution: two writes in
 * the same millisecond are indistinguishable once a timestamptz has been narrowed to a JS Date.
 */
const enrolment = async (endpoint: string) => (await rows<{ enrolled: string; moved: boolean }>(
  `SELECT enrolled_at::text AS enrolled, enrolled_at > created_at AS moved
   FROM staff_push_subscriptions WHERE endpoint = '${endpoint}'`))[0]

/** A push service that answers with the given statuses in order (last one repeats). */
function pushService(...statuses: number[]) {
  const calls: { url: string; body: Uint8Array }[] = []
  let i = 0
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body as Uint8Array })
    const status = statuses[Math.min(i++, statuses.length - 1)] ?? 201
    return new Response(status === 201 ? '' : 'nope', { status })
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

// ── the booking → alert link ──────────────────────────────────────────────────

describe('an online booking records exactly one durable alert', () => {
  it('records the alert WITHOUT the booking statement depending on the table', async () => {
    // The booking must survive the alert table being unavailable — that is the whole point of
    // recording it separately, and it is what lets migration 0068 be rolled back while live.
    await pg.exec('ALTER TABLE staff_alerts RENAME TO staff_alerts_hidden')
    try {
      const { appointment } = await createAppointment(booking(), { mode: 'public', source: 'website_booking', actor: null, now: NOW, cfg: CFG, vehicleFetch: fakeVpic() })
      expect(appointment.status).toBe('confirmed')
    } finally {
      await pg.exec('ALTER TABLE staff_alerts_hidden RENAME TO staff_alerts')
    }
    expect(await count('appointments')).toBe(1)
  })

  it('records exactly one alert for the booking', async () => {
    const { appointment } = await book()
    const alerts = await rows<{ appointment_id: string; dedupe_key: string; kind: string }>('SELECT * FROM staff_alerts')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].appointment_id).toBe(appointment.id)
    expect(alerts[0].kind).toBe('new_booking')
    expect(alerts[0].dedupe_key).toBe(newBookingDedupeKey(appointment.id))
  })

  it('adds no second alert when the customer double-taps Book (same submission replayed)', async () => {
    const input = booking()
    const pub = { mode: 'public' as const, source: 'website_booking' as const, actor: null, now: NOW, cfg: CFG, vehicleFetch: fakeVpic() }
    const first = await createAppointment(input, pub)
    const second = await createAppointment(input, pub)
    expect(second.replayed).toBe(true)
    expect(second.appointment.id).toBe(first.appointment.id)
    // Even if the route recorded an alert for BOTH responses, the dedupe key allows only one.
    expect(await recordNewBookingAlert(first.appointment.id)).toBe(await recordNewBookingAlert(second.appointment.id))
    expect(await count('staff_alerts')).toBe(1)
  })

  it('does not alert for a booking staff took over the phone', async () => {
    await book({ time: '10:00' }, 'staff')
    expect(await count('staff_alerts')).toBe(0)
    expect(await count('appointments')).toBe(1)
  })

  it('still saves the booking when there is nobody to notify', async () => {
    const { appointment } = await book()
    const tally = await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH })
    expect(appointment.status).toBe('confirmed')
    expect(tally.sent).toBe(0)
    expect(await rows<{ resolution: string }>('SELECT resolution FROM staff_alerts')).toEqual([{ resolution: 'no_devices' }])
  })
})

// ── delivery ──────────────────────────────────────────────────────────────────

describe('delivery to enrolled devices', () => {
  it('sends one notification per enrolled device and marks the alert delivered', async () => {
    await device(MANAGER)
    await device(OTHER_MANAGER)
    await book()
    const svc = pushService(201)
    const tally = await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(tally.sent).toBe(2)
    expect(svc.calls).toHaveLength(2)
    expect(await count('staff_alert_deliveries', `status = 'sent'`)).toBe(2)
    expect(await rows<{ resolution: string }>('SELECT resolution FROM staff_alerts')).toEqual([{ resolution: 'delivered' }])
  })

  it('never notifies the same device twice, however often dispatch runs', async () => {
    await device()
    await book()
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(1)
    expect(await count('staff_alert_deliveries')).toBe(1)
  })

  it('does not notify a device that enrolled after the booking arrived', async () => {
    await book()
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl }) // no devices yet
    await device()
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(0)
  })

  it('posts an encrypted body to the device endpoint, not to any third party', async () => {
    const sub = await device(MANAGER, 'https://web.push.apple.com/the-endpoint')
    await book()
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls[0].url).toBe(sub.endpoint)
    const body = Buffer.from(svc.calls[0].body)
    expect(body.length).toBeGreaterThan(90)
    // The customer's details must not be recoverable from the wire bytes.
    expect(body.toString('latin1')).not.toContain('Alex')
    expect(body.toString('latin1')).not.toContain('Civic')
  })
})

// ── which bookings a device is entitled to hear about ─────────────────────────

/**
 * The rule under test: a device is told about a booking only if its CURRENT enrolment started at or
 * before THAT BOOKING arrived. The comparison must be against the appointment's own created_at —
 * not "now", and not the alert row's created_at, which for a recovered or retried alert is long
 * after the booking it describes. Getting this wrong means a phone buzzing about yesterday evening
 * the first time somebody turns notifications on, which is exactly the way to make staff switch the
 * feature back off.
 */
describe('a device only hears about bookings from its own enrolment onwards', () => {
  const EARLY = 'https://web.push.apple.com/enrolled-before-the-booking'
  const LATE = 'https://web.push.apple.com/enrolled-after-the-booking'

  it('alerts the phone enrolled before the booking and NOT the one enrolled after it', async () => {
    await device(MANAGER, EARLY)
    await book()
    await device(OTHER_MANAGER, LATE)
    const svc = pushService(201)
    const tally = await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(tally.sent).toBe(1)
    expect(svc.calls.map((c) => c.url)).toEqual([EARLY])
    // One delivery row only — the later phone is never even queued.
    expect(await count('staff_alert_deliveries')).toBe(1)
  })

  it('judges a RECOVERED alert by the booking time, not by when the alert was recreated', async () => {
    await device(MANAGER, EARLY)
    const { appointment } = await book()
    await pg.exec('DELETE FROM staff_alerts')      // as if the post-response write was dropped
    await device(OTHER_MANAGER, LATE)              // a phone enrolled in between
    const svc = pushService(201)
    // Hours later the cron recreates the alert. Its created_at is NOW; the booking's is not.
    await dispatchStaffAlerts({ now: dispatchNow(2 * HOUR), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(await rows<{ appointment_id: string }>('SELECT appointment_id FROM staff_alerts')).toEqual([{ appointment_id: appointment.id }])
    expect(svc.calls.map((c) => c.url)).toEqual([EARLY])
  })

  it('creates no recovery alert at all when no enrolled device predates the booking', async () => {
    await book()
    await pg.exec('DELETE FROM staff_alerts')
    await device(MANAGER, LATE)
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(2 * HOUR), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(await count('staff_alerts')).toBe(0)
    expect(svc.calls).toHaveLength(0)
  })

  it('a routine refresh keeps the alerts the device was already owed', async () => {
    const endpoint = 'https://web.push.apple.com/manager-own-phone'
    await device(MANAGER, endpoint)
    const before = await enrolment(endpoint)
    await book()
    // The notifications screen re-registers the same device, for the same person, on every visit.
    await device(MANAGER, endpoint)
    const after = await enrolment(endpoint)
    expect(after.enrolled).toBe(before.enrolled)
    expect(after.moved).toBe(false)

    const svc = pushService(201)
    expect((await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })).sent).toBe(1)
  })

  it('re-enabling a device does not hand it the bookings that arrived while it was off', async () => {
    const endpoint = 'https://web.push.apple.com/turned-off-and-on-again'
    await device(MANAGER, endpoint)
    await disableSubscription(endpoint, 'signed_out')
    await book()                                   // arrived while nobody was listening
    await device(MANAGER, endpoint)                // …then the phone is turned back on
    expect((await enrolment(endpoint)).moved).toBe(true)

    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(0)
    expect(await rows<{ resolution: string }>('SELECT resolution FROM staff_alerts')).toEqual([{ resolution: 'no_devices' }])

    // …but it is covered from now on, which is the point of turning it back on.
    await book({ time: '09:15' })
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(1)
  })

  it('drops a QUEUED delivery when the phone changes hands after it was fanned out', async () => {
    // The gap the fan-out rule alone cannot close: the delivery was already created and correct
    // when it was created. It then sits pending (no VAPID keys yet, a retry backoff, a budget
    // deferral) while a different person signs in on that shared shop phone and re-enrols the SAME
    // endpoint — without signing out first, so nothing is ever disabled.
    const endpoint = 'https://web.push.apple.com/handover-while-queued'
    await device(MANAGER, endpoint)
    await book()
    await dispatchStaffAlerts({ now: dispatchNow(), config: null })   // fan out, send nothing
    expect(await count('staff_alert_deliveries', `status = 'pending'`)).toBe(1)

    await device(OTHER_MANAGER, endpoint)
    const svc = pushService(201)
    const tally = await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })

    expect(svc.calls).toHaveLength(0)
    expect(tally).toMatchObject({ sent: 0, skipped: 1 })
    const [row] = await rows<{ status: string; error: string }>('SELECT status, error FROM staff_alert_deliveries')
    expect(row.status).toBe('skipped')
    expect(row.error).toMatch(/re-enrolled/)
  })

  it('still sends a queued delivery when the same person merely refreshed the device', async () => {
    const endpoint = 'https://web.push.apple.com/refreshed-while-queued'
    await device(MANAGER, endpoint)
    await book()
    await dispatchStaffAlerts({ now: dispatchNow(), config: null })
    await device(MANAGER, endpoint)      // the notifications screen, re-registering the same device
    const svc = pushService(201)
    expect((await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })).sent).toBe(1)
    expect(svc.calls).toHaveLength(1)
  })

  it('handing a shared shop phone to another manager starts a fresh enrolment', async () => {
    const endpoint = 'https://web.push.apple.com/shared-shop-phone-handover'
    await device(MANAGER, endpoint)
    await book()
    await device(OTHER_MANAGER, endpoint)          // a different person signs in on the same phone
    const after = await enrolment(endpoint)
    expect(after.moved).toBe(true)

    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    // Darryl does not inherit a booking that arrived while the phone was Torlan's.
    expect(svc.calls).toHaveLength(0)
    expect(await count('staff_push_subscriptions')).toBe(1)
  })
})

// ── the invocation's time budget ───────────────────────────────────────────────

describe('one dispatch run stays inside its invocation', () => {
  it('stops before starting a send it has no time for, and leaves those deliveries untouched', async () => {
    for (let i = 0; i < 4; i++) await device(MANAGER, `https://web.push.apple.com/phone-${i}`)
    await book()

    // Fake clock: each send costs a FULL push timeout, the way an unreachable endpoint does. The
    // row limit alone would happily start all four — 4 × 8 s is already past a 16 s budget.
    let clock = 0
    let calls = 0
    const fetchImpl = vi.fn(async () => { calls++; clock += PUSH_SEND_TIMEOUT_MS; return new Response('', { status: 201 }) })
    const opts = { config: PUSH, fetchImpl: fetchImpl as unknown as typeof fetch, monotonicNow: () => clock }

    const tally = await dispatchStaffAlerts({ ...opts, now: dispatchNow(), budgetMs: 2 * PUSH_SEND_TIMEOUT_MS })
    expect(calls).toBe(2)
    expect(tally).toMatchObject({ sent: 2, deferred: 2 })
    // The two it never reached were not claimed: still pending, and no attempt was spent on them.
    expect(await count('staff_alert_deliveries', `status = 'pending' AND attempts = 0`)).toBe(2)
    expect(await count('staff_alerts', 'resolved_at IS NOT NULL')).toBe(0)

    // Nothing was lost — the next run finishes them.
    clock = 0
    const second = await dispatchStaffAlerts({ ...opts, now: dispatchNow() })
    expect(second).toMatchObject({ sent: 2, deferred: 0 })
    expect(calls).toBe(4)
    expect(await count('staff_alert_deliveries', `status = 'sent'`)).toBe(4)
    expect(await rows<{ resolution: string }>('SELECT resolution FROM staff_alerts')).toEqual([{ resolution: 'delivered' }])
  })

  it('sends nothing — rather than one thing — when the budget cannot fit a single send', async () => {
    await device()
    await book()
    const fetchImpl = vi.fn(async () => new Response('', { status: 201 }))
    const tally = await dispatchStaffAlerts({
      now: dispatchNow(), config: PUSH, fetchImpl: fetchImpl as unknown as typeof fetch,
      budgetMs: 1_000, monotonicNow: () => 0,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(tally).toMatchObject({ sent: 0, deferred: 1 })
    expect(await count('staff_alert_deliveries', `status = 'pending' AND attempts = 0`)).toBe(1)
  })
})

// ── failure handling ──────────────────────────────────────────────────────────

describe('failures never cost a booking and never spam a phone', () => {
  it('retries a temporary push-service failure on a later run, then gives up', async () => {
    await device()
    await book()
    const svc = pushService(503)
    let tally = await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(tally).toMatchObject({ retrying: 1, sent: 0 })
    expect(await count('staff_alert_deliveries', `status = 'pending'`)).toBe(1)

    // Backoff: the same instant is too early to try again.
    tally = await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(1)

    // Later runs keep trying until the attempt limit, then stop for good.
    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
      await dispatchStaffAlerts({ now: dispatchNow(i * HOUR), config: PUSH, fetchImpl: svc.fetchImpl })
    }
    expect(svc.calls.length).toBe(MAX_DELIVERY_ATTEMPTS)
    expect(await count('staff_alert_deliveries', `status = 'failed'`)).toBe(1)
    expect(await rows<{ resolution: string }>('SELECT resolution FROM staff_alerts')).toEqual([{ resolution: 'all_failed' }])
  })

  it('retires a device the push service says is gone, and skips its other queued alerts', async () => {
    const sub = await device()
    await book({ time: '09:00' })
    await book({ time: '09:15' })
    const svc = pushService(410)
    const tally = await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(tally.expired).toBe(1)
    // One call only: after the first 410 the device is disabled and the second alert is skipped.
    expect(svc.calls).toHaveLength(1)
    const after = await findSubscription(sub.endpoint)
    expect(after?.disabledReason).toBe('expired')
    expect(await count('staff_alert_deliveries', `status = 'skipped'`)).toBe(1)
  })

  it('queues alerts safely when the server has no notification keys yet', async () => {
    await device()
    await book()
    const tally = await dispatchStaffAlerts({ now: dispatchNow(), config: null })
    expect(tally.notConfigured).toBe(true)
    expect(tally.sent).toBe(0)
    // The alert survives, so it still goes out once the keys are added — on the same day.
    expect(await count('staff_alert_deliveries', `status = 'pending'`)).toBe(1)
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(HOUR), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(1)
  })

  it('retires an alert nobody received within a day instead of buzzing phones late', async () => {
    await device()
    await book()
    const svc = pushService(201)
    const twoDaysLater = dispatchNow(48 * HOUR)
    const tally = await dispatchStaffAlerts({ now: twoDaysLater, config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(0)
    expect(tally.staleAlerts).toBe(1)
    expect(await rows<{ resolution: string }>('SELECT resolution FROM staff_alerts')).toEqual([{ resolution: 'expired_unsent' }])
  })

  it('requeues a send abandoned by a crashed worker instead of losing the alert', async () => {
    await device()
    await book()
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: null })   // fan out, send nothing
    // A worker that claimed the row and was killed before recording an outcome.
    await pg.exec(`UPDATE staff_alert_deliveries SET status = 'sending', attempts = 1, claimed_at = now() - interval '30 minutes'`)

    const tally = await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    // Sent on this pass. A phone that already got the first attempt replaces that notification
    // rather than stacking a second one, because both carry the alert id as their tag.
    expect(tally.sent).toBe(1)
    expect(svc.calls).toHaveLength(1)
    const [row] = await rows<{ status: string; attempts: number }>('SELECT status, attempts FROM staff_alert_deliveries')
    expect(row.status).toBe('sent')
    expect(row.attempts).toBe(2)
  })

  it('gives up on an abandoned send once the attempt limit is reached', async () => {
    await device()
    await book()
    await dispatchStaffAlerts({ now: dispatchNow(), config: null })
    await pg.exec(`UPDATE staff_alert_deliveries SET status = 'sending', attempts = ${MAX_DELIVERY_ATTEMPTS}, claimed_at = now() - interval '30 minutes'`)
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(0)
    expect(await count('staff_alert_deliveries', `status = 'failed'`)).toBe(1)
    expect(await rows<{ resolution: string }>('SELECT resolution FROM staff_alerts')).toEqual([{ resolution: 'all_failed' }])
  })

  it('leaves a send that was only just claimed alone', async () => {
    await device()
    await book()
    await dispatchStaffAlerts({ now: dispatchNow(), config: null })
    await pg.exec(`UPDATE staff_alert_deliveries SET status = 'sending', attempts = 1, claimed_at = now()`)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: pushService(201).fetchImpl })
    expect(await count('staff_alert_deliveries', `status = 'sending'`)).toBe(1)
  })

  it('recreates an alert that was never recorded (safety net)', async () => {
    await device()
    const { appointment } = await book()
    await pg.exec('DELETE FROM staff_alerts')   // as if recordNewBookingAlert never ran
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(await rows<{ appointment_id: string }>('SELECT appointment_id FROM staff_alerts')).toEqual([{ appointment_id: appointment.id }])
    expect(svc.calls).toHaveLength(1)
  })

  it('does not replay the backlog onto a phone enrolled after those bookings arrived', async () => {
    await book()                 // booking first…
    await pg.exec('DELETE FROM staff_alerts')
    await device()               // …device enrolled afterwards
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(await count('staff_alerts')).toBe(0)
    expect(svc.calls).toHaveLength(0)
  })

  it('does not re-alert a booking staff already marked seen', async () => {
    await device()
    const { appointment } = await book()
    await pg.exec('DELETE FROM staff_alerts')
    await pg.query('UPDATE appointments SET acknowledged_at = now(), acknowledged_by = $1 WHERE id = $2', ['Torlan', appointment.id])
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(await count('staff_alerts')).toBe(0)
    expect(svc.calls).toHaveLength(0)
  })

  it('does not alert a staff-entered booking even when its source says website', async () => {
    await device()
    await book({ time: '10:00' }, 'staff')
    await pg.query(`UPDATE appointments SET source = 'website_booking'`)
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    // created_by is set for anything a person entered, which is what separates the two.
    expect(await count('staff_alerts')).toBe(0)
    expect(svc.calls).toHaveLength(0)
  })
})

// ── who may be notified ───────────────────────────────────────────────────────

describe('only authorized staff keep getting alerts', () => {
  it('accepts managers and admins and refuses everyone else', () => {
    expect(mayEnrol(MANAGER)).toBe(true)
    expect(mayEnrol({ key: 'admin', name: 'Admin', role: 'admin' })).toBe(true)
    expect(mayEnrol({ key: 'torlan', name: 'Torlan', role: 'employee' })).toBe(false)
    expect(mayEnrol(null)).toBe(false)
    expect(allowedRecipientKeys([{ key: 'a', role: 'manager' }, { key: 'b', role: 'employee' }])).toEqual(['admin', 'a'])
  })

  it('disables the devices of somebody who no longer has access, before sending anything', async () => {
    const sub = await device({ key: 'former', name: 'Former Manager', role: 'manager' })
    await book()
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(0)
    expect((await findSubscription(sub.endpoint))?.disabledReason).toBe('revoked')
  })

  it('stops alerting a device that signed out', async () => {
    const sub = await device()
    expect(await disableSubscription(sub.endpoint, 'signed_out')).toBe(true)
    await book()
    const svc = pushService(201)
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: svc.fetchImpl })
    expect(svc.calls).toHaveLength(0)
    expect(await listSubscriptions()).toHaveLength(0)
    expect(await listSubscriptions({ includeDisabled: true })).toHaveLength(1)
  })

  /**
   * The automatic refresh the setup screen performs on load. Because nobody asked for it, it must be
   * incapable of changing WHO or WHETHER — only "still current". Otherwise simply opening the
   * Notifications screen silently undoes an opt-out (the browser subscription often still exists,
   * e.g. when the local unsubscribe failed) or hands a colleague's phone to whoever is signed in.
   */
  describe('the automatic refresh cannot enrol, re-enable or transfer', () => {
    const ENDPOINT = 'https://web.push.apple.com/refresh-only-device'
    const SUB = { endpoint: ENDPOINT, p256dh: UA_P256DH, auth: UA_AUTH, deviceLabel: 'iPhone · Safari' }

    it('keeps an active enrolment of the owner current, without moving its enrolment window', async () => {
      await device(MANAGER, ENDPOINT)
      const before = await enrolment(ENDPOINT)
      const row = await refreshSubscription(SUB, MANAGER)
      expect(row?.employeeKey).toBe(MANAGER.key)
      expect((await enrolment(ENDPOINT)).enrolled).toBe(before.enrolled)
    })

    it('leaves a device that was turned OFF disabled — opening the screen cannot re-enable it', async () => {
      await device(MANAGER, ENDPOINT)
      await disableSubscription(ENDPOINT, 'disabled_by_staff')

      // The browser still holds the subscription (its unsubscribe failed), so the screen refreshes it.
      expect(await refreshSubscription(SUB, MANAGER)).toBeNull()

      const [row] = await rows<{ disabled_reason: string; endpoint: string }>(
        `SELECT disabled_reason, endpoint FROM staff_push_subscriptions`)
      expect(row.disabled_reason).toBe('disabled_by_staff')
      expect(row.endpoint).toBe('')                       // credentials stayed cleared
      expect(await listSubscriptions()).toHaveLength(0)    // still not an active device
      expect(await count('staff_push_subscriptions')).toBe(1)   // and no second row was inserted

      // Only an explicit Enable may bring it back.
      await device(MANAGER, ENDPOINT)
      expect(await listSubscriptions()).toHaveLength(1)
    })

    it('refuses a refresh from somebody who is not the owner, and changes nothing', async () => {
      await device(MANAGER, ENDPOINT)
      const before = (await rows<{ employee_key: string; employee_name: string; last_seen_at: string }>(
        `SELECT employee_key, employee_name, last_seen_at::text FROM staff_push_subscriptions`))[0]

      expect(await refreshSubscription(SUB, OTHER_MANAGER)).toBeNull()

      const after = (await rows<{ employee_key: string; employee_name: string; last_seen_at: string }>(
        `SELECT employee_key, employee_name, last_seen_at::text FROM staff_push_subscriptions`))[0]
      expect(after).toEqual(before)                      // not transferred, not even touched
      expect(await count('staff_push_subscriptions')).toBe(1)
    })

    it('never creates a device that was not enrolled at all', async () => {
      expect(await refreshSubscription(SUB, MANAGER)).toBeNull()
      expect(await count('staff_push_subscriptions')).toBe(0)
    })
  })

  it('re-points a shared shop phone at whoever enrolled it last, without duplicating it', async () => {
    const endpoint = 'https://web.push.apple.com/shared-shop-phone'
    await device(MANAGER, endpoint)
    await disableSubscription(endpoint, 'signed_out')
    await device(OTHER_MANAGER, endpoint)
    const all = await listSubscriptions({ includeDisabled: true })
    expect(all).toHaveLength(1)
    expect(all[0].employeeKey).toBe('darryl')
    expect(all[0].disabledAt).toBeNull()
  })
})

// ── what the phone actually shows ─────────────────────────────────────────────

describe('notification text', () => {
  it('shows the drop-off time and nothing that identifies the customer', () => {
    const msg = renderAlert({ id: 'alert-1', kind: 'new_booking', appointmentId: 'appt-1' }, { localDate: '2026-10-20', localTime: '09:00' })
    expect(msg.title).toBe('New online booking')
    expect(msg.body).toContain('9:00')
    expect(msg.url).toBe('/appointments/appt-1')
    const text = `${msg.title} ${msg.body}`
    for (const detail of ['Alex', 'Rivera', '979', 'example.com', 'Civic', 'Honda']) expect(text).not.toContain(detail)
  })

  it('falls back to the appointments list when the appointment is gone', () => {
    expect(renderAlert({ id: 'a', kind: 'new_booking', appointmentId: null }, null).url).toBe('/appointments?view=today')
  })
})

describe('telling the person their phone has gone quiet', () => {
  it('reports recent undelivered alerts for that person only', async () => {
    await device(MANAGER)
    await device(OTHER_MANAGER)
    await book()
    // A rotated VAPID key looks exactly like this: every push permanently rejected.
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: pushService(403).fetchImpl })

    const mine = await recentDeliveryProblems(MANAGER.key)
    expect(mine).toHaveLength(1)
    expect(mine[0].deviceLabel).toBe('iPhone · Safari')
    expect(mine[0].error).toContain('403')
    // Scoped per person: Darryl's failure is not reported to Torlan.
    expect(await recentDeliveryProblems(OTHER_MANAGER.key)).toHaveLength(1)
    expect(await recentDeliveryProblems('nobody')).toEqual([])
  })

  it('says nothing when deliveries are succeeding', async () => {
    await device()
    await book()
    await dispatchStaffAlerts({ now: dispatchNow(), config: PUSH, fetchImpl: pushService(201).fetchImpl })
    expect(await recentDeliveryProblems(MANAGER.key)).toEqual([])
  })
})

describe('test notification', () => {
  it('goes to that one device only, and is never queued or retried', async () => {
    const sub = await device()
    const svc = pushService(201)
    const outcome = await sendTestNotification(sub.id, { config: PUSH, fetchImpl: svc.fetchImpl })
    expect(outcome.status).toBe('sent')
    expect(svc.calls).toHaveLength(1)
    expect(await count('staff_alert_deliveries')).toBe(0)
  })

  it('refuses when push is not configured', async () => {
    const sub = await device()
    expect(await sendTestNotification(sub.id, { config: null })).toEqual({ status: 'not_configured' })
  })
})
