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
import { checkInAppointment } from './checkin'
import { dispatchDue, renderMessage, PostmarkEmailProvider, NotConfiguredEmailProvider, type TransactionalEmailProvider } from './notify'
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
let catalogId = ''

beforeAll(async () => {
  await pg.exec(SCHEMA)
  for (const f of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0058_appointments.sql']) await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  await pg.query(`INSERT INTO app_settings (key, value, type) VALUES ('booking_config', $1::jsonb, 'json')`, [JSON.stringify(CFG)])
  catalogId = ((await pg.query(`INSERT INTO service_catalog (slug, name, kind) VALUES ('complete_detail', 'Complete Detail', 'package') RETURNING id`)).rows[0] as { id: string }).id
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
  vehicleYear: '2019', vehicleMake: 'Ford', vehicleModel: 'F-150', notes: 'Dog hair in the back seat', ...over,
}, { mode: 'public', source: 'website_booking', actor: null, now: NOW, cfg: CFG })).appointment

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
    expect(arg.lines).toEqual([
      expect.objectContaining({ catalogId, name: 'Complete Detail', kind: 'package' }), // canonical catalog identity kept
      expect.objectContaining({ kind: 'custom', name: 'Odor / Ozone' }),              // staff picks the exact odor service
    ])
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
    expect(m.text).toContain(`Your appointment with Pitt Stop Detail & Auto Sales is confirmed for ${formatDateLabel(TUE)} at 8:00 AM.`)
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
    expect(sent[0].subject).toMatch(/^Appointment confirmed/)
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
    expect(sent.map((m) => m.subject.split(' ')[0])).toEqual(['Appointment', 'Appointment']) // confirmed + cancelled, no reminder
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
