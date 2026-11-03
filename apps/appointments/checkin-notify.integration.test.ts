import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
// The EXISTING Quick Entry job creator is what check-in reuses; here it is stubbed to a minimal Job insert
// so the test can prove exactly-once linking without the whole workflow schema.
const createJob = vi.fn()
vi.mock('@/apps/quick-entry/jobs-db', () => ({ createQuickEntryJob: (i: unknown) => createJob(i) }))
const linkLead = vi.fn(async () => {})
vi.mock('@/apps/marketing/attribution', async (orig) => ({ ...(await orig<typeof import('@/apps/marketing/attribution')>()), linkLeadOutcome: (...a: unknown[]) => linkLead(...(a as [])) }))

import { getDb } from '@/platform/db'
import { createAppointment, cancelAppointment, getAppointment, type BookingInput } from './db'
import { fakeVpic } from './test-vpic'
import { checkInAppointment } from './checkin'
import { dispatchDue, renderMessage, requeueNotification, PostmarkEmailProvider, NotConfiguredEmailProvider, AllowlistEmailProvider, replyToAddress, type EmailMessage, type TransactionalEmailProvider } from './notify'
import { DEFAULT_BOOKING_CONFIG, zonedToUtc, addDays, localParts, weekdayOf, formatDateLabel, holidayName, type BookingConfig } from './policy'

const pg = new PGlite()
const SCHEMA = `
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name varchar(120), last_name varchar(120), display_name varchar(240), company varchar(240),
  phone varchar(40), normalized_phone varchar(20), email varchar(240), normalized_email varchar(240), customer_type varchar(20) NOT NULL DEFAULT 'retail',
  active boolean NOT NULL DEFAULT true, source varchar(20) NOT NULL DEFAULT 'autoleap', source_key varchar(240), autoleap_customer_id varchar(120),
  quickbooks_customer_id varchar(120), autoleap_vehicle_count integer, source_values jsonb NOT NULL DEFAULT '{}', created_by_import_batch_id uuid,
  first_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), year varchar(4), make varchar(100), model varchar(100));
CREATE TABLE customer_vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, vehicle_id uuid NOT NULL,
  relationship varchar(20) NOT NULL DEFAULT 'owner', source varchar(20) NOT NULL DEFAULT 'x', created_by_import_batch_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), UNIQUE (customer_id, vehicle_id));
CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, vehicle_id uuid, status text, order_number text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE job_estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_order_id uuid NOT NULL, internal_notes text);
CREATE TABLE service_catalog (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug varchar(80), name varchar(160), kind varchar(20), active boolean NOT NULL DEFAULT true);
CREATE TABLE app_settings (key varchar(80) PRIMARY KEY, value jsonb NOT NULL, type varchar(12) NOT NULL, category varchar(40), label varchar(160),
  description text, updated_by varchar(200), updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());`

const CFG: BookingConfig = { ...DEFAULT_BOOKING_CONFIG, enabled: true, slotCapacity: 3, dailyUnits: 20 }

beforeAll(async () => {
  await pg.exec(SCHEMA)
  for (const f of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0058_appointments.sql', '0060_booking_drafts.sql']) await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  await pg.query(`INSERT INTO app_settings (key, value, type) VALUES ('booking_config', $1::jsonb, 'json')`, [JSON.stringify(CFG)])
  // A live Complete Detail catalog item exists — check-in must still not bill it from the booking.
  await pg.query(`INSERT INTO service_catalog (slug, name, kind) VALUES ('complete_detail', 'Complete Detail', 'package')`)
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  createJob.mockReset(); linkLead.mockClear()
  createJob.mockImplementation(async (i: { internalNote: string }) => {
    const id = randomUUID()
    await pg.query(`INSERT INTO service_orders (id, status, order_number) VALUES ($1, 'arrived', 'SO-TEST')`, [id])
    await pg.query(`INSERT INTO job_estimates (service_order_id, internal_notes) VALUES ($1, $2)`, [id, i.internalNote])
    return { jobId: randomUUID(), serviceOrderId: id, orderNumber: 'SO-TEST' }
  })
  await pg.exec(`DELETE FROM appointment_notifications; DELETE FROM appointment_events; DELETE FROM appointments; DELETE FROM job_estimates;
    DELETE FROM marketing_attribution; DELETE FROM marketing_events; DELETE FROM marketing_leads; DELETE FROM customer_vehicles; DELETE FROM customers;`)
  await pg.exec(`UPDATE service_orders SET status = status WHERE false; DELETE FROM service_orders;`)
})

const count = async (table: string, where = 'true') => ((await pg.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0] as { n: number }).n
// A Tuesday 1–2 weeks ahead of the REAL clock, so DB now() (when notices are queued) is always before the
// test's 'now' — never a time bomb.
let TUE = addDays(localParts(new Date(), 'America/Chicago').date, 8)
while (weekdayOf(TUE) !== 'tue' || holidayName(TUE)) TUE = addDays(TUE, 1)
const MON = addDays(TUE, -1)
const NOW = zonedToUtc(MON, '06:00', 'America/Chicago')
const EVENING_BEFORE = zonedToUtc(MON, '17:00', 'America/Chicago')
const book = async (over: Partial<BookingInput> = {}) => (await createAppointment({
  idempotencyKey: `ck-${randomUUID()}`, date: TUE, time: '08:00', serviceKeys: ['complete_detail', 'odor'],
  firstName: 'Jane', lastName: 'Driver', phone: '9795550444', email: 'jane.driver@example.com',
  vehicleType: 'car', vehicleYear: '2019', vehicleMake: 'Ford', vehicleModel: 'F-150', notes: 'Dog hair in the back seat', ...over,
}, { mode: 'public', source: 'website_booking', actor: null, now: NOW, cfg: CFG, vehicleFetch: fakeVpic({ Ford: ['F-150', 'Ranger'] }) })).appointment

describe('check-in → existing Work Board intake', () => {
  it('creates exactly one Job through the Quick Entry creator and links it', async () => {
    const a = await book()
    const r = await checkInAppointment(a.id, 'Tony')
    expect(r.existing).toBe(false)
    expect(createJob).toHaveBeenCalledTimes(1)
    const arg = createJob.mock.calls[0][0]
    expect(arg.customerName).toBe('Jane Driver')
    expect(arg.customerEmail).toBe('jane.driver@example.com')
    expect(arg.vehicle).toMatchObject({ year: '2019', make: 'Ford', model: 'F-150' })
    // The booking is the customer's REQUEST, not billable work: no service lines, no generic Complete
    // Detail charge, no invented package breakdown — staff itemize on the Estimate. The request is the Job note.
    expect(arg.lines).toEqual([])
    expect(arg.workPriceCents ?? null).toBeNull()
    expect(arg.jobNote).toBe(`Customer requested: Full Detail, Odor / Ozone (appointment ${a.reference}). Customer note: Dog hair in the back seat`)
    expect(arg.internalNote).toContain(`Appointment ${a.reference}`)
    expect(arg.internalNote).toContain('Dog hair')
    const after = await getAppointment(a.id)
    expect(after).toMatchObject({ status: 'arrived', serviceOrderId: r.serviceOrderId })
    expect(await count('appointment_events', `appointment_id = '${a.id}' AND event_type = 'checked_in'`)).toBe(1)
    expect(linkLead).toHaveBeenCalledWith(a.marketingLeadId, { serviceOrderId: r.serviceOrderId, confidence: 'unknown' }, 'Tony')
  })

  it('a second tap returns the same Job', async () => {
    const a = await book()
    const first = await checkInAppointment(a.id, 'Tony')
    const second = await checkInAppointment(a.id, 'Darryl')
    expect(second).toEqual({ serviceOrderId: first.serviceOrderId, existing: true })
    expect(createJob).toHaveBeenCalledTimes(1)
  })

  it('two staff checking in at once never create two Jobs', async () => {
    const a = await book()
    const results = await Promise.allSettled([checkInAppointment(a.id, 'Tony'), checkInAppointment(a.id, 'Darryl')])
    expect(createJob).toHaveBeenCalledTimes(1)
    expect(await count('service_orders')).toBe(1)
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
  })

  it('an interrupted check-in (Job created, link lost) is recovered on retry instead of duplicated', async () => {
    const a = await book()
    createJob.mockImplementationOnce(async (i: { internalNote: string }) => {
      const id = randomUUID()
      await pg.query(`INSERT INTO service_orders (id, status, order_number) VALUES ($1, 'arrived', 'SO-ORPHAN')`, [id])
      await pg.query(`INSERT INTO job_estimates (service_order_id, internal_notes) VALUES ($1, $2)`, [id, i.internalNote])
      throw new Error('network dropped after the Job was created')
    })
    await expect(checkInAppointment(a.id, 'Tony')).rejects.toThrow('network dropped')
    const r = await checkInAppointment(a.id, 'Tony')
    expect(r.existing).toBe(true)
    expect(await count('service_orders')).toBe(1)
    expect((await getAppointment(a.id))?.serviceOrderId).toBe(r.serviceOrderId)
  })

  it('a cancelled appointment cannot be checked in', async () => {
    const a = await book()
    await cancelAppointment(a.id, { actor: 'Tony', by: 'staff' })
    await expect(checkInAppointment(a.id, 'Tony')).rejects.toMatchObject({ code: 'conflict' })
    expect(createJob).not.toHaveBeenCalled()
  })
})

describe('transactional notices', () => {
  const sent: { to: string; subject: string; text: string }[] = []
  const fake: TransactionalEmailProvider = { name: 'fake', live: true, async send(m) { sent.push(m); return { status: 'sent', providerMessageId: `m${sent.length}` } } }

  it('confirmation copy carries the real appointment data', async () => {
    const a = await book()
    const m = renderMessage('confirmation', a, CFG)
    expect(m.text).toContain(`Your appointment with Pitt Stop Detail & Auto Sales is confirmed for ${formatDateLabel(TUE)} at 8:00 AM. Your appointment is for vehicle drop-off. We’ll confirm the estimated completion time when you arrive.`)
    // The drop-off note appears exactly ONCE in each part — it used to be repeated by cfg.instructions.
    for (const body of [m.text, m.html!]) {
      expect(body.split('Your appointment is for vehicle drop-off').length - 1).toBe(1)
      expect(body).not.toContain('not a promised finish time')
    }
    // Stripping that sentence must not eat the rest of the shared instructions.
    expect(m.text).toContain('Please remove valuables and personal items before drop-off.')
    expect(m.text).toContain('We will contact you when it is ready.')
    // Branded HTML carries the same facts, escaped, plus the secure view/cancel link.
    expect(m.html).toContain(a.reference)
    expect(m.html).toContain('View or cancel')
    expect(m.html).toContain('/book/a/')
    expect(m.html).not.toContain('<script')
    expect(formatDateLabel(TUE)).toMatch(/^Tuesday, /)
    expect(m.text).toContain(a.reference)
    expect(m.text).toContain('2019 Ford F-150')
    expect(m.text).toContain('/book/a/')
  })

  it('with no provider configured nothing is claimed as sent', async () => {
    const a = await book()
    const r = await dispatchDue({ provider: new NotConfiguredEmailProvider(), now: NOW })
    expect(r).toMatchObject({ sent: 0, notConfigured: 1 })
    expect(await count('appointment_notifications', `appointment_id = '${a.id}' AND kind = 'confirmation' AND status = 'not_configured'`)).toBe(1)
    expect(await count('appointment_notifications', `status = 'sent'`)).toBe(0)
  })

  it('sends once; a second run does not resend; the reminder waits for its time', async () => {
    sent.length = 0
    await book()
    expect((await dispatchDue({ provider: fake, now: NOW })).sent).toBe(1)
    expect((await dispatchDue({ provider: fake, now: NOW })).sent).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toMatch(/^Drop-off confirmed/)
    const reminderTime = EVENING_BEFORE
    expect((await dispatchDue({ provider: fake, now: reminderTime })).sent).toBe(1)
    expect(sent[1].subject).toMatch(/^Reminder/)
  })

  it('a reminder for a cancelled appointment never goes out', async () => {
    sent.length = 0
    const a = await book()
    await dispatchDue({ provider: fake, now: NOW })
    await cancelAppointment(a.id, { actor: 'Tony', by: 'staff' })
    await dispatchDue({ provider: fake, now: EVENING_BEFORE })
    expect(sent.map((m) => m.subject.split(' ')[0])).toEqual(['Drop-off', 'Appointment']) // confirmed + cancelled, no reminder
    expect(sent[1].subject).toMatch(/cancelled/)
  })

  it('a provider failure is retried, then marked failed', async () => {
    const failing: TransactionalEmailProvider = { name: 'fail', live: true, async send() { return { status: 'failed', error: 'boom' } } }
    const a = await book({ email: 'f@example.com' })
    let t = NOW.getTime()
    for (let i = 0; i < 3; i++) { await dispatchDue({ provider: failing, now: new Date(t), appointmentId: a.id }); t += 16 * 60_000 }
    const rows = (await pg.query(`SELECT status, attempts FROM appointment_notifications WHERE appointment_id = $1 AND kind = 'confirmation'`, [a.id])).rows as { status: string; attempts: number }[]
    expect(rows[0]).toEqual({ status: 'failed', attempts: 3 })
  })

  it('Postmark adapter reports sent only on a real acceptance', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-1' }), { status: 200 }))
    expect(await new PostmarkEmailProvider('tok', 'appointments@example.com', ok as unknown as typeof fetch).send({ to: 'a@b.co', subject: 's', text: 't' }))
      .toEqual({ status: 'sent', providerMessageId: 'pm-1' })
    const bad = vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient' }), { status: 422 }))
    expect(await new PostmarkEmailProvider('tok', 'x@example.com', bad as unknown as typeof fetch).send({ to: 'a@b.co', subject: 's', text: 't' }))
      .toMatchObject({ status: 'failed' })
  })
})

// ── Confirmation / reminder: uncertain delivery is never resent (independent review 2026-10-20) ──
describe('transactional notices: ambiguous delivery', () => {
  type Answer = () => Response | Promise<Response>
  const postmark = (...answers: Answer[]) => {
    let calls = 0
    const t = (async () => { const a = answers[Math.min(calls, answers.length - 1)]; calls++; return a() }) as typeof fetch
    return { provider: new PostmarkEmailProvider('tok', 'shop@example.com', t), calls: () => calls }
  }
  const accepted: Answer = () => new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-ok' }), { status: 200 })
  const lostResponse: Answer = () => { throw new TypeError('fetch failed: response connection lost') }
  const reply = (status: number, body: unknown): Answer => () => new Response(JSON.stringify(body), { status })
  const notice = async (id: string, kind: string) => (await pg.query(`SELECT id, status, attempts, error, send_after FROM appointment_notifications WHERE appointment_id = $1 AND kind = $2`, [id, kind])).rows[0] as { id: string; status: string; attempts: number; error: string | null; send_after: Date }

  it('confirmation accepted but the response is lost → "uncertain", visible in history, never resent or requeued', async () => {
    const a = await book()
    const pm = postmark(lostResponse, accepted)
    expect(await dispatchDue({ provider: pm.provider, now: NOW })).toMatchObject({ sent: 0, failed: 0, uncertain: 1 })
    let t = NOW.getTime()
    for (let i = 0; i < 3; i++) { t += 16 * 60_000; await dispatchDue({ provider: pm.provider, now: new Date(t) }) }
    expect(pm.calls()).toBe(1)
    const n = await notice(a.id, 'confirmation')
    expect(n).toMatchObject({ status: 'uncertain', attempts: 1 })
    expect(n.error).toMatch(/may have been delivered/i)
    expect(await count('appointment_events', `appointment_id = '${a.id}' AND event_type = 'email_uncertain'`)).toBe(1)
    await requeueNotification(n.id)
    await dispatchDue({ provider: pm.provider, now: new Date(t + 60_000) })
    expect(pm.calls()).toBe(1)
    expect((await notice(a.id, 'confirmation')).status).toBe('uncertain')
  })

  it('reminder accepted but the response is lost → "uncertain", not resent', async () => {
    const a = await book()
    await dispatchDue({ provider: postmark(accepted).provider, now: NOW }) // confirmation goes out normally
    const pm = postmark(lostResponse, accepted)
    await dispatchDue({ provider: pm.provider, now: EVENING_BEFORE })
    await dispatchDue({ provider: pm.provider, now: new Date(EVENING_BEFORE.getTime() + 20 * 60_000) })
    expect(pm.calls()).toBe(1)
    expect((await notice(a.id, 'reminder')).status).toBe('uncertain')
    expect((await notice(a.id, 'confirmation')).status).toBe('sent')
  })

  it('a definite permanent rejection → failed at once (no automatic retry); staff may requeue it', async () => {
    const a = await book()
    const pm = postmark(reply(422, { ErrorCode: 300, Message: 'Invalid email request' }), accepted)
    await dispatchDue({ provider: pm.provider, now: NOW, appointmentId: a.id })
    await dispatchDue({ provider: pm.provider, now: new Date(NOW.getTime() + 20 * 60_000), appointmentId: a.id })
    expect(pm.calls()).toBe(1)
    const n = await notice(a.id, 'confirmation')
    expect(n).toMatchObject({ status: 'failed', attempts: 1 })
    expect(n.error).toContain('Invalid email request')
    await requeueNotification(n.id)
    expect((await notice(a.id, 'confirmation')).status).toBe('pending')
  })

  it('a definite temporary rejection → retried after 15 minutes and delivered once', async () => {
    const a = await book()
    const pm = postmark(reply(429, { ErrorCode: 429, Message: 'Rate limit exceeded' }), accepted)
    await dispatchDue({ provider: pm.provider, now: NOW, appointmentId: a.id })
    expect(await notice(a.id, 'confirmation')).toMatchObject({ status: 'pending', attempts: 1 })
    await dispatchDue({ provider: pm.provider, now: new Date(NOW.getTime() + 5 * 60_000), appointmentId: a.id }) // not yet
    expect(pm.calls()).toBe(1)
    await dispatchDue({ provider: pm.provider, now: new Date(NOW.getTime() + 16 * 60_000), appointmentId: a.id })
    expect(pm.calls()).toBe(2)
    expect(await notice(a.id, 'confirmation')).toMatchObject({ status: 'sent', attempts: 2 })
  })
})


// ── Controlled test safety: an allowlist must never consume a real customer's notice ──────────────
// The failure this guards against: during an owner-only test the allowlist refuses every other address.
// If that counted as a terminal 'skipped', a genuine confirmation or reminder queued at the same time
// would be silently thrown away and could never be recovered (requeueNotification refuses 'skipped').
describe('transactional notices: test-mode allowlist is a hold, not a discard', () => {
  const box: EmailMessage[] = []
  const inner: TransactionalEmailProvider = { name: 'fake', live: true, async send(m) { box.push(m); return { status: 'sent', providerMessageId: `m${box.length}` } } }
  const allowOwnerOnly = new AllowlistEmailProvider(inner, ['owner@pittstop.test'])

  it("holds a real customer's confirmation instead of discarding it, then sends it exactly once afterwards", async () => {
    box.length = 0
    const a = await book({ email: 'real.customer@gmail.com' })

    // During the controlled test: nothing leaves, and the notice is NOT consumed.
    const held = await dispatchDue({ provider: allowOwnerOnly, now: NOW, appointmentId: a.id })
    expect(held).toMatchObject({ sent: 0, skipped: 0, held: 1 })
    expect(box).toHaveLength(0)
    const row = () => pg.query(
      `SELECT status, attempts, error FROM appointment_notifications WHERE appointment_id = $1 AND kind = 'confirmation'`, [a.id],
    ).then((r) => r.rows[0] as { status: string; attempts: number; error: string | null })
    const afterHold = await row()
    expect(afterHold.status).toBe('pending')          // still queued — recoverable
    expect(afterHold.attempts).toBe(0)                // a hold never burns a real delivery attempt
    expect(afterHold.error).toMatch(/allowlist/i)     // and says why, for the staff screen

    // The allowlist is removed (owner approves real email): it goes out on the very NEXT dispatch, with no
    // artificial delay — a held notice must not be left to expire against its own drop-off.
    expect((await dispatchDue({ provider: inner, now: NOW, appointmentId: a.id })).sent).toBe(1)
    expect((await dispatchDue({ provider: inner, now: NOW, appointmentId: a.id })).sent).toBe(0)
    expect(box).toHaveLength(1)
    expect(box[0].to).toBe('real.customer@gmail.com')
    expect((await row()).status).toBe('sent')
  })

  it('still sends to the allowlisted owner address while the test is running', async () => {
    box.length = 0
    const a = await book({ email: 'owner@pittstop.test' })
    expect((await dispatchDue({ provider: allowOwnerOnly, now: NOW, appointmentId: a.id })).sent).toBe(1)
    expect(box.map((m) => m.to)).toEqual(['owner@pittstop.test'])
  })

  it('a held notice that has become irrelevant is still not sent once the allowlist is removed', async () => {
    box.length = 0
    const a = await book({ email: 'real.customer@gmail.com' })
    await dispatchDue({ provider: allowOwnerOnly, now: NOW, appointmentId: a.id })   // confirmation held
    // NOTE: cancelAppointment's own "skip pending" sweep is what retires the held confirmation here, so this
    // case does not exercise staleReason — the drop-off-passed path is covered in notify-review.regression.
    await cancelAppointment(a.id, { actor: 'Tony', by: 'staff' })
    await dispatchDue({ provider: inner, now: NOW, appointmentId: a.id })
    expect(box.map((m) => m.subject.split(' ')[0])).toEqual(['Appointment'])
    expect(box[0].subject).toMatch(/cancelled/)
  })
})

// ── Replies must reach a monitored human inbox, not the unattended sending address ───────────────
describe('transactional notices: Reply-To', () => {
  it('stamps Reply-To from APPOINTMENT_EMAIL_REPLY_TO on what the provider is given', async () => {
    const box: EmailMessage[] = []
    const provider: TransactionalEmailProvider = { name: 'fake', live: true, async send(m) { box.push(m); return { status: 'sent', providerMessageId: 'x' } } }
    const prev = process.env.APPOINTMENT_EMAIL_REPLY_TO
    process.env.APPOINTMENT_EMAIL_REPLY_TO = 'service@pittstop.test'
    try {
      const a = await book()
      await dispatchDue({ provider, now: NOW, appointmentId: a.id })
      expect(box[0].replyTo).toBe('service@pittstop.test')
    } finally {
      if (prev === undefined) delete process.env.APPOINTMENT_EMAIL_REPLY_TO
      else process.env.APPOINTMENT_EMAIL_REPLY_TO = prev
    }
  })

  it('unset means no Reply-To header rather than an empty one', () => {
    expect(replyToAddress({} as NodeJS.ProcessEnv)).toBeNull()
    expect(replyToAddress({ APPOINTMENT_EMAIL_REPLY_TO: '  ' } as unknown as NodeJS.ProcessEnv)).toBeNull()
    expect(replyToAddress({ APPOINTMENT_EMAIL_REPLY_TO: ' service@x.co ' } as unknown as NodeJS.ProcessEnv)).toBe('service@x.co')
  })
})


// ── Backdated confirmations: a notice that sat un-sent must not go out after the drop-off ────────
// This is what protects the queue of notices recorded while no provider was configured: switching a
// provider on, or a staff retry weeks later, must not mail "your drop-off is confirmed" about a past date.
describe('transactional notices: a stale confirmation is never sent late', () => {
  const box: EmailMessage[] = []
  const provider: TransactionalEmailProvider = { name: 'fake', live: true, async send(m) { box.push(m); return { status: 'sent', providerMessageId: 'x' } } }

  it('refuses a confirmation once the drop-off time has passed, even when a manager re-queues it', async () => {
    box.length = 0
    const a = await book({ email: 'late@example.com' })
    // It was never sent (no provider at the time).
    await dispatchDue({ provider: new NotConfiguredEmailProvider(), now: NOW, appointmentId: a.id })
    const id = ((await pg.query(
      `SELECT id FROM appointment_notifications WHERE appointment_id = $1 AND kind = 'confirmation'`, [a.id],
    )).rows[0] as { id: string }).id

    // A provider now exists and staff press "Send again" — but the drop-off is in the past.
    await requeueNotification(id)
    const past = new Date(a.startsAt.getTime() + 60 * 60_000)
    await dispatchDue({ provider, now: past, appointmentId: a.id })
    expect(box).toHaveLength(0)
    const row = (await pg.query(`SELECT status, error FROM appointment_notifications WHERE id = $1`, [id]))
      .rows[0] as { status: string; error: string | null }
    expect(row.status).toBe('skipped')
    expect(row.error).toBe('drop-off time passed')
  })

  it('still sends a confirmation while the drop-off is ahead', async () => {
    box.length = 0
    const a = await book({ email: 'intime@example.com' })
    expect((await dispatchDue({ provider, now: NOW, appointmentId: a.id })).sent).toBe(1)
    expect(box[0].subject).toMatch(/^Drop-off confirmed/)
  })

  it('a cancellation notice is still allowed after the drop-off time', async () => {
    box.length = 0
    const a = await book({ email: 'cancel@example.com' })
    await dispatchDue({ provider, now: NOW, appointmentId: a.id })            // confirmation
    const past = new Date(a.startsAt.getTime() + 60 * 60_000)
    await cancelAppointment(a.id, { actor: 'Tony', by: 'staff' })
    await dispatchDue({ provider, now: past, appointmentId: a.id })
    expect(box.map((m) => m.subject.split(' ')[0])).toEqual(['Drop-off', 'Appointment'])
    expect(box[1].subject).toMatch(/cancelled/)
  })
})
