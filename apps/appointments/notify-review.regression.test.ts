/**
 * REGRESSION TESTS from the pre-deployment review of the booking confirmation email work.
 * An independent review found four defects by writing tests that asserted the broken behaviour; each is
 * kept here, rewritten to assert the FIXED behaviour, so none of them can come back silently.
 *   1. A held confirmation was silently dropped for a near-term booking, labelled "Not needed".
 *   2. A held cancellation never became terminal and could be mailed a month late.
 *   3. A retryable delivery FAILURE was stored in the exact shape the UI called "Held (test mode)".
 *   4. An outcome write with no status guard resurrected a notice a reschedule had superseded → 2 reminders.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))

import { getDb } from '@/platform/db'
import { createAppointment, cancelAppointment, rescheduleAppointment, type BookingInput } from './db'
import { fakeVpic } from './test-vpic'
import { dispatchDue, AllowlistEmailProvider, isMissedSend, isTestModeHold, type EmailMessage, type TransactionalEmailProvider } from './notify'
import { DEFAULT_BOOKING_CONFIG, zonedToUtc, addDays, localParts, weekdayOf, holidayName, type BookingConfig } from './policy'

const pg = new PGlite()
const SCHEMA = `
CREATE TABLE app_settings (key varchar(80) PRIMARY KEY, value jsonb NOT NULL, type varchar(12) NOT NULL, category varchar(40), label varchar(160),
  description text, updated_by varchar(200), updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(240), normalized_phone varchar(20), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE service_orders (id uuid PRIMARY KEY, status text, order_number text, created_at timestamptz NOT NULL DEFAULT now());`

const CFG: BookingConfig = { ...DEFAULT_BOOKING_CONFIG, enabled: true, slotCapacity: 3, dailyUnits: 20 }

beforeAll(async () => {
  await pg.exec(SCHEMA)
  for (const f of ['0058_appointments.sql', '0060_booking_drafts.sql']) await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  await pg.query(`INSERT INTO app_settings (key, value, type) VALUES ('booking_config', $1::jsonb, 'json')`, [JSON.stringify(CFG)])
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM appointment_notifications; DELETE FROM appointment_events; DELETE FROM appointments;`)
})

let TUE = addDays(localParts(new Date(), 'America/Chicago').date, 8)
while (weekdayOf(TUE) !== 'tue' || holidayName(TUE)) TUE = addDays(TUE, 1)
const MON = addDays(TUE, -1)
const NOW = zonedToUtc(MON, '06:00', 'America/Chicago')

const book = async (over: Partial<BookingInput> = {}) => (await createAppointment({
  idempotencyKey: `rv-${randomUUID()}`, date: TUE, time: '08:00', serviceKeys: ['complete_detail'],
  firstName: 'Jane', lastName: 'Driver', phone: '9795550444', email: 'real.customer@gmail.com',
  vehicleType: 'car', vehicleYear: '2019', vehicleMake: 'Ford', vehicleModel: 'F-150', ...over,
}, { mode: 'public', source: 'website_booking', actor: null, now: NOW, cfg: CFG, vehicleFetch: fakeVpic({ Ford: ['F-150', 'Ranger'] }) })).appointment

const box: EmailMessage[] = []
const inner: TransactionalEmailProvider = { name: 'fake', live: true, async send(m) { box.push(m); return { status: 'sent', providerMessageId: `m${box.length}` } } }
const ownerOnly = new AllowlistEmailProvider(inner, ['owner@pittstop.test'])
const noticeRow = async (apptId: string, kind: string) => (await pg.query(
  `SELECT id, status, attempts, error, send_after FROM appointment_notifications WHERE appointment_id = $1 AND kind = $2`, [apptId, kind],
)).rows[0] as { id: string; status: string; attempts: number; error: string | null; send_after: Date }

describe('FIXED 1 — a held confirmation is released on the next dispatch, and a missed one is loud', () => {
  it('goes out as soon as the allowlist is lifted, with no artificial delay', async () => {
    box.length = 0
    const a = await book()
    expect((await dispatchDue({ provider: ownerOnly, now: NOW, appointmentId: a.id })).held).toBe(1)
    const held = await noticeRow(a.id, 'confirmation')
    expect(held.status).toBe('pending')
    expect(held.attempts).toBe(0)
    // The hold must NOT push send_after into the future: the owner lifting the allowlist has to be enough.
    expect(held.send_after.getTime()).toBeLessThanOrEqual(NOW.getTime())
    expect((await dispatchDue({ provider: inner, now: NOW, appointmentId: a.id })).sent).toBe(1)
    expect(box).toHaveLength(1)
  })

  it('if a hold does outlive the drop-off, the miss is recorded as a problem instead of "Not needed"', async () => {
    box.length = 0
    const a = await book()
    await dispatchDue({ provider: ownerOnly, now: NOW, appointmentId: a.id })
    const TUE_CRON = zonedToUtc(TUE, '16:00', 'America/Chicago')   // after the 08:00 drop-off
    const tally = await dispatchDue({ provider: inner, now: TUE_CRON, appointmentId: a.id })
    expect(box).toHaveLength(0)                     // still correct: never mail a backdated confirmation
    expect(tally.sent).toBe(0)
    const row = await noticeRow(a.id, 'confirmation')
    expect(row.status).toBe('skipped')
    expect(row.error).toBe('drop-off time passed')
    // THE FIX: it is no longer silent. History carries an email_not_sent row naming the miss, and the UI
    // renders this exact (kind, error) pair as "Not sent — drop-off passed", not "Not needed".
    const ev = (await pg.query(
      `SELECT event_type, meta FROM appointment_events WHERE appointment_id = $1 AND event_type = 'email_not_sent'`, [a.id],
    )).rows as { event_type: string; meta: { kind: string; reason: string } }[]
    expect(ev).toHaveLength(1)
    expect(ev[0].meta).toMatchObject({ kind: 'confirmation', reason: 'drop-off time passed' })
  })
})

describe('FIXED 2 — a cancellation cannot arrive long after the fact', () => {
  it('abandons a long-held cancellation instead of mailing a month-old notice', async () => {
    box.length = 0
    const a = await book()
    await pg.exec(`DELETE FROM appointment_notifications`)
    await cancelAppointment(a.id, { actor: 'Tony', by: 'staff', now: NOW, cfg: CFG })
    let t = NOW
    for (let i = 0; i < 5; i++) {
      t = new Date(t.getTime() + 24 * 3_600_000)
      await dispatchDue({ provider: ownerOnly, now: t, appointmentId: a.id })
    }
    // 30 days later the allowlist is gone — and the age backstop refuses it rather than surprising the customer.
    const MUCH_LATER = new Date(NOW.getTime() + 30 * 24 * 3_600_000)
    const tally = await dispatchDue({ provider: inner, now: MUCH_LATER, appointmentId: a.id })
    expect(tally.sent).toBe(0)
    expect(box).toHaveLength(0)
    const row = await noticeRow(a.id, 'cancellation')
    expect(row.status).toBe('skipped')
    expect(row.error).toBe('too late to be useful')
  })

  it('still sends a cancellation promptly, including after the drop-off time', async () => {
    box.length = 0
    const a = await book()
    await pg.exec(`DELETE FROM appointment_notifications`)
    await cancelAppointment(a.id, { actor: 'Tony', by: 'staff', now: NOW, cfg: CFG })
    const AFTER = zonedToUtc(TUE, '16:00', 'America/Chicago')
    expect((await dispatchDue({ provider: inner, now: AFTER, appointmentId: a.id })).sent).toBe(1)
    expect(box[0].subject).toMatch(/cancelled/)
  })
})

describe('FIXED 3 — a delivery failure is never presented as a test-mode hold', () => {
  it('is distinguishable from a hold by the predicate the screen actually uses', async () => {
    const a = await book()
    const busy: TransactionalEmailProvider = { name: 'fake', live: true, async send() { return { status: 'failed', retryable: true, error: '503 Postmark is busy or unavailable' } } }
    expect((await dispatchDue({ provider: busy, now: NOW, appointmentId: a.id })).failed).toBe(1)
    const failed = await noticeRow(a.id, 'confirmation')
    expect(failed.status).toBe('pending')            // still pending: it will be retried
    expect(isTestModeHold(failed)).toBe(false)       // but NOT a hold → the UI says "Retrying", in red
  })

  it('and a genuine hold is still recognised as one', async () => {
    const a = await book()
    await dispatchDue({ provider: ownerOnly, now: NOW, appointmentId: a.id })
    expect(isTestModeHold(await noticeRow(a.id, 'confirmation'))).toBe(true)
  })
})

describe('FIXED 4 — an outcome write cannot resurrect a notice a reschedule superseded', () => {
  it('leaves exactly one reminder, and the customer is reminded once', async () => {
    box.length = 0
    const a = await book()
    await pg.exec(`DELETE FROM appointment_notifications WHERE kind <> 'reminder'`)
    await pg.exec(`UPDATE appointment_notifications SET send_after = now() - interval '1 minute'`)

    // The reschedule lands while the row is 'sending' — the window the guard has to cover.
    const racing: TransactionalEmailProvider = {
      name: 'fake', live: true,
      async send() {
        await rescheduleAppointment(a.id, { date: addDays(TUE, 1), time: '09:00' }, { actor: 'Tony', override: true, now: NOW, cfg: CFG })
        return { status: 'blocked', reason: 'Test mode: recipient is not on APPOINTMENT_EMAIL_ALLOWLIST, so nothing was sent.' }
      },
    }
    await dispatchDue({ provider: racing, now: NOW, appointmentId: a.id })
    // The blocked write does put the in-flight row back to 'pending', so for a moment TWO reminder rows
    // exist: the superseded one and the reschedule's new one. That alone is not the bug — sending both is.
    const rows = (await pg.query(
      `SELECT count(*)::int n FROM appointment_notifications WHERE appointment_id = $1 AND kind = 'reminder'`, [a.id],
    )).rows[0] as { n: number }
    expect(rows.n).toBe(2)

    // THE FIX: the next dispatch recognises the stale row by its dedupe key (which names the OLD drop-off
    // time) and retires it, so the customer is reminded exactly once — about the new time.
    const WED = zonedToUtc(addDays(TUE, 1), '08:00', 'America/Chicago')
    await dispatchDue({ provider: inner, now: WED, appointmentId: a.id })
    expect(box.filter((m) => /^Reminder/.test(m.subject))).toHaveLength(1)
    const retired = (await pg.query(
      `SELECT status, error FROM appointment_notifications WHERE appointment_id = $1 AND kind = 'reminder' AND status = 'skipped'`, [a.id],
    )).rows as { status: string; error: string }[]
    expect(retired).toHaveLength(1)
    expect(retired[0].error).toBe('superseded by a reschedule')
  })
})


// ── Second review pass: two more defects of the same family, found by re-reviewing the fixes ────────
describe('FIXED 5 — a reschedule notice cannot be sent twice either', () => {
  it('retires a superseded "Appointment moved" notice instead of mailing it again', async () => {
    box.length = 0
    const a = await book()
    await pg.exec(`DELETE FROM appointment_notifications`)
    // First move: queues a reschedule notice keyed to the NEW time.
    await rescheduleAppointment(a.id, { date: addDays(TUE, 1), time: '09:00' }, { actor: 'Tony', override: true, now: NOW, cfg: CFG })
    await pg.exec(`UPDATE appointment_notifications SET send_after = now() - interval '1 minute'`)

    // A SECOND move lands while that notice is in flight — the same race as the reminder, and the reschedule
    // notice is keyed by drop-off time in exactly the same way, so it must be caught the same way.
    const racing: TransactionalEmailProvider = {
      name: 'fake', live: true,
      async send() {
        await rescheduleAppointment(a.id, { date: addDays(TUE, 2), time: '10:00' }, { actor: 'Tony', override: true, now: NOW, cfg: CFG })
        return { status: 'blocked', reason: 'Test mode: recipient is not on APPOINTMENT_EMAIL_ALLOWLIST, so nothing was sent.' }
      },
    }
    await dispatchDue({ provider: racing, now: NOW, appointmentId: a.id })
    const LATER = zonedToUtc(addDays(TUE, 2), '08:00', 'America/Chicago')
    await dispatchDue({ provider: inner, now: LATER, appointmentId: a.id })
    expect(box.filter((m) => /^Appointment moved/.test(m.subject))).toHaveLength(1)
    const retired = (await pg.query(
      `SELECT error FROM appointment_notifications WHERE appointment_id = $1 AND kind = 'reschedule' AND status = 'skipped'`, [a.id],
    )).rows as { error: string }[]
    expect(retired.some((r) => r.error === 'superseded by a reschedule')).toBe(true)
  })
})

describe('FIXED 6 — a cancellation the customer was never told about is not filed as routine', () => {
  it('records the miss so it cannot read as "Not needed" on the staff screen', async () => {
    box.length = 0
    const a = await book()
    await pg.exec(`DELETE FROM appointment_notifications`)
    // Cancelled well after the drop-off: outside the grace window, so it is correctly not emailed…
    const LATE = new Date(zonedToUtc(TUE, '08:00', 'America/Chicago').getTime() + 5 * 24 * 3_600_000)
    await cancelAppointment(a.id, { actor: 'Tony', by: 'staff', now: LATE, cfg: CFG })
    const tally = await dispatchDue({ provider: inner, now: LATE, appointmentId: a.id })
    expect(tally.sent).toBe(0)
    expect(box).toHaveLength(0)
    const row = await noticeRow(a.id, 'cancellation')
    expect(row.status).toBe('skipped')
    expect(row.error).toBe('too late to be useful')
    // …but it is NOT silent: isMissedSend covers it, so History carries the miss and the panel reds it.
    expect(isMissedSend('cancellation', 'too late to be useful')).toBe(true)
    expect((await pg.query(
      `SELECT count(*)::int n FROM appointment_events WHERE appointment_id = $1 AND event_type = 'email_not_sent'`, [a.id],
    )).rows[0]).toEqual({ n: 1 })
  })
})
