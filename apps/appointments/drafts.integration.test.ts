import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { createAppointment, getAvailability, type BookingInput } from './db'
import {
  saveDraft, getDraftByToken, dispatchDraftFollowUps, purgeExpiredDrafts, recordResume, setDraftStaffStatus, listDrafts,
  renderDraftFollowUp, requeueDraftFollowUp, recoverInterruptedFollowUps, LEAD_CLOSED,
  FOLLOW_UP_CONSENT_TEXT, FOLLOW_UP_CONSENT_VERSION, SAVE_NOTICE_VERSION, type DraftInput,
} from './drafts'
import { DEFAULT_BOOKING_CONFIG, zonedToUtc, type BookingConfig } from './policy'
import { AllowlistEmailProvider, PostmarkEmailProvider, type TransactionalEmailProvider, type EmailMessage } from './notify'
import { draftToken } from './tokens'
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
  for (const f of ['0046_marketing.sql', '0047_marketing_sms_consent.sql', '0058_appointments.sql', '0060_booking_drafts.sql']) {
    await pg.exec(readFileSync(`drizzle/migrations/manual/${f}`, 'utf8'))
  }
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM booking_draft_events; DELETE FROM booking_drafts; DELETE FROM appointment_notifications; DELETE FROM appointment_events;
    DELETE FROM appointments; DELETE FROM marketing_attribution; DELETE FROM marketing_events; DELETE FROM marketing_leads;
    DELETE FROM marketing_consent_events; DELETE FROM marketing_preferences; DELETE FROM customer_vehicles; DELETE FROM customers;`)
})

const q = async <T = Record<string, unknown>>(sql: string) => (await pg.query(sql)).rows as T[]
const count = async (table: string, where = 'true') => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n

const NOW = zonedToUtc('2026-10-19', '06:00', 'America/Chicago')
const TUE = '2026-10-20'
const CFG: BookingConfig = { ...DEFAULT_BOOKING_CONFIG, enabled: true }
const ON: BookingConfig = { ...CFG, draftFollowUpEnabled: true, draftFollowUpDelayHours: 24 }
const vehicleFetch = fakeVpic()
let seq = 0

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  draftKey: `draft-key-${++seq}-${Math.random().toString(36).slice(2, 8)}`, serviceKeys: ['complete_detail'],
  vehicleType: 'car', vehicleYear: '2020', vehicleMake: 'Honda', vehicleModel: 'Civic',
  firstName: 'Dana', lastName: 'Lee', phone: '(979) 555-0111', email: 'Dana.Lee@Example.com',
  preferredDate: TUE, preferredTime: '08:00', notes: '', followUpConsent: true, attribution: {}, ...over,
})
const book = (over: Partial<BookingInput> = {}) => createAppointment({
  idempotencyKey: `idem-${++seq}-${Math.random().toString(36).slice(2, 8)}`, date: TUE, time: '08:00', serviceKeys: ['complete_detail'],
  firstName: 'Dana', lastName: 'Lee', phone: '(979) 555-0111', email: 'dana.lee@example.com',
  vehicleType: 'car', vehicleYear: '2020', vehicleMake: 'Honda', vehicleModel: 'Civic', ...over,
}, { mode: 'public', source: 'website_booking', actor: null, now: NOW, cfg: CFG, vehicleFetch })

/** Age a draft so its follow-up is due. */
const age = (hours: number) => pg.exec(`UPDATE booking_drafts SET last_activity_at = now() - interval '${hours} hours', created_at = now() - interval '${hours + 1} hours'`)

function capture(): TransactionalEmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = []
  return { name: 'fake', live: true, sent, async send(m) { sent.push(m); return { status: 'sent', providerMessageId: `m${sent.length}` } } }
}

describe('saving an unfinished booking', () => {
  it('requires the completed contact step (all four fields) and a vehicle from the lists', async () => {
    await expect(saveDraft(draft({ email: '' }), { cfg: CFG, vehicleFetch })).rejects.toMatchObject({ code: 'invalid' })
    await expect(saveDraft(draft({ lastName: '' }), { cfg: CFG, vehicleFetch })).rejects.toMatchObject({ code: 'invalid' })
    await expect(saveDraft(draft({ phone: '555-0111' }), { cfg: CFG, vehicleFetch })).rejects.toMatchObject({ code: 'invalid' })
    await expect(saveDraft(draft({ vehicleModel: 'Typed In' }), { cfg: CFG, vehicleFetch })).rejects.toMatchObject({ code: 'invalid' })
    await expect(saveDraft(draft(), { cfg: { ...CFG, enabled: false }, vehicleFetch })).rejects.toMatchObject({ code: 'closed' })
    expect(await count('booking_drafts')).toBe(0)
  })

  it('records the follow-up permission with its exact wording, version and time', async () => {
    const { token } = await saveDraft(draft(), { cfg: CFG, vehicleFetch })
    const d = (await getDraftByToken(token))!
    expect(d).toMatchObject({ status: 'open', followUpConsent: true, followUpConsentText: FOLLOW_UP_CONSENT_TEXT,
      followUpConsentVersion: FOLLOW_UP_CONSENT_VERSION, saveNoticeVersion: SAVE_NOTICE_VERSION, followUpStatus: 'pending', email: 'dana.lee@example.com' })
    expect(d.followUpConsentAt).toBeInstanceOf(Date)
    expect(FOLLOW_UP_CONSENT_TEXT).toBe('If I don\u2019t finish booking, Pitt Stop may email me to help me schedule.')
  })

  it('an unchecked box means no permission and no follow-up', async () => {
    const { token } = await saveDraft(draft({ followUpConsent: false }), { cfg: CFG, vehicleFetch })
    expect(await getDraftByToken(token)).toMatchObject({ followUpConsent: false, followUpConsentText: null, followUpStatus: 'not_permitted' })
  })

  it('going back and continuing again updates the same draft; unticking withdraws permission', async () => {
    const d = draft()
    await saveDraft(d, { cfg: CFG, vehicleFetch })
    await saveDraft({ ...d, firstName: 'Danielle', followUpConsent: false }, { cfg: CFG, vehicleFetch })
    expect(await count('booking_drafts')).toBe(1)
    expect((await q('SELECT first_name, follow_up_consent, follow_up_status FROM booking_drafts'))[0]).toEqual({ first_name: 'Danielle', follow_up_consent: false, follow_up_status: 'not_permitted' })
    expect((await q<{ event_type: string }>('SELECT event_type FROM booking_draft_events ORDER BY created_at')).map((e) => e.event_type)).toEqual(['saved', 'updated'])
  })

  it('a draft never reserves capacity — its preferred time stays bookable by anyone', async () => {
    await saveDraft(draft({ preferredDate: TUE, preferredTime: '08:00' }), { cfg: CFG, vehicleFetch })
    const { days } = await getAvailability({ cfg: CFG, serviceKeys: ['complete_detail'], fromDate: TUE, days: 1, now: NOW })
    expect(days[0].slots.find((s) => s.time === '08:00')?.available).toBe(true)
    const { appointment } = await book({ email: 'someone.else@example.com', phone: '9795550999' })
    expect(appointment.localTime).toBe('08:00')
  })

  it('booking with the same draft key closes the draft and suppresses its follow-up atomically', async () => {
    const d = draft()
    await saveDraft(d, { cfg: CFG, vehicleFetch })
    const { appointment } = await book({ draftKey: d.draftKey })
    const [row] = await q<{ status: string; follow_up_status: string; appointment_id: string }>('SELECT status, follow_up_status, appointment_id FROM booking_drafts')
    expect(row).toEqual({ status: 'booked', follow_up_status: 'suppressed', appointment_id: appointment.id })
    expect(await count('booking_draft_events', `event_type = 'booked'`)).toBe(1)
    // Saving again with that key cannot reopen a completed booking.
    await expect(saveDraft(d, { cfg: CFG, vehicleFetch })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('resume links are opaque, resolve only their draft, and count as activity', async () => {
    const { token, draftId } = await saveDraft(draft(), { cfg: CFG, vehicleFetch })
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(token).toBe(draftToken(draftId))
    expect(token.toLowerCase()).not.toContain('dana')
    expect(await getDraftByToken('x'.repeat(32))).toBeNull()
    await age(48)
    await recordResume(draftId)
    expect(await count('booking_draft_events', `event_type = 'resumed'`)).toBe(1)
    expect(await count('booking_drafts', `last_activity_at > now() - interval '1 minute'`)).toBe(1)
  })
})

describe('the one follow-up email', () => {
  it('does nothing while the owner has not turned it on', async () => {
    await saveDraft(draft(), { cfg: CFG, vehicleFetch }); await age(48)
    const p = capture()
    expect(await dispatchDraftFollowUps({ cfg: CFG, provider: p })).toMatchObject({ enabled: false, sent: 0 })
    expect(p.sent).toHaveLength(0)
  })

  it('waits for the delay, then sends exactly once with a resume link and the "not booked yet" message', async () => {
    const { draftId } = await saveDraft(draft(), { cfg: ON, vehicleFetch })
    const p = capture()
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: p })).sent).toBe(0) // too soon
    await age(25)
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: p })).sent).toBe(1)
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: p })).sent).toBe(0) // never twice
    expect(p.sent).toHaveLength(1)
    expect(p.sent[0].to).toBe('dana.lee@example.com')
    expect(p.sent[0].text).toContain('No appointment is booked yet')
    expect(p.sent[0].text).toContain(`/book/r/${draftToken(draftId)}`)
    expect(p.sent[0].text).toContain('may have been taken')
    expect((await q('SELECT follow_up_status FROM booking_drafts'))[0]).toEqual({ follow_up_status: 'sent' })
  })

  it('two runs at once still send only one email', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const p = capture()
    await Promise.all([dispatchDraftFollowUps({ cfg: ON, provider: p }), dispatchDraftFollowUps({ cfg: ON, provider: p })])
    expect(p.sent).toHaveLength(1)
  })

  it('never goes to someone who did not give permission', async () => {
    await saveDraft(draft({ followUpConsent: false }), { cfg: ON, vehicleFetch }); await age(48)
    const p = capture()
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    expect(p.sent).toHaveLength(0)
  })

  it('is suppressed when the customer booked another way (same email) — re-checked right before sending', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    await book({ email: 'dana.lee@example.com' }) // a separate session, no draft key
    const p = capture()
    expect(await dispatchDraftFollowUps({ cfg: ON, provider: p })).toMatchObject({ sent: 0, suppressed: 1 })
    expect((await q('SELECT follow_up_status, follow_up_error FROM booking_drafts'))[0]).toEqual({ follow_up_status: 'suppressed', follow_up_error: 'customer has booked' })
  })

  it('is suppressed when the same address already got a follow-up from an earlier unfinished booking', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const p = capture()
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    await saveDraft(draft(), { cfg: ON, vehicleFetch })
    await pg.exec(`UPDATE booking_drafts SET last_activity_at = now() - interval '30 hours' WHERE follow_up_status = 'pending'`)
    expect(await dispatchDraftFollowUps({ cfg: ON, provider: p })).toMatchObject({ sent: 0, suppressed: 1 })
    expect(p.sent).toHaveLength(1)
  })

  it('with no provider, it is recorded honestly as not sent', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const none: TransactionalEmailProvider = { name: 'none', live: false, async send() { return { status: 'not_configured' } } }
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: none })).notConfigured).toBe(1)
    expect((await q('SELECT follow_up_status, follow_up_sent_at FROM booking_drafts'))[0]).toEqual({ follow_up_status: 'not_configured', follow_up_sent_at: null })
  })

  it('test-mode allowlist blocks real customers and nothing leaves', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const inner = capture()
    const p = new AllowlistEmailProvider(inner, ['owner@example.com'])
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: p })).suppressed).toBe(1)
    expect(inner.sent).toHaveLength(0)
  })

  it('a provider failure retries, then stops as failed', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const bad: TransactionalEmailProvider = { name: 'bad', live: true, async send() { return { status: 'failed', error: 'boom' } } }
    for (let i = 0; i < 4; i++) await dispatchDraftFollowUps({ cfg: ON, provider: bad })
    expect((await q('SELECT follow_up_status, follow_up_attempts FROM booking_drafts'))[0]).toEqual({ follow_up_status: 'failed', follow_up_attempts: 3 })
  })

  it('copy escapes the customer name in HTML', () => {
    const m = renderDraftFollowUp({ firstName: '<b>x</b>', serviceLabels: 'Full Detail' }, CFG, 'https://example.test/book/r/abc')
    expect(m.html).not.toContain('<b>x</b>')
  })
})

describe('staff + retention', () => {
  it('staff status changes are recorded in the append-only history', async () => {
    const { draftId } = await saveDraft(draft(), { cfg: CFG, vehicleFetch })
    await setDraftStaffStatus(draftId, 'contacted', 'Manager Test')
    expect((await listDrafts({ view: 'open' }))[0]).toMatchObject({ staffStatus: 'contacted', staffStatusBy: 'Manager Test' })
    expect(await count('booking_draft_events', `event_type = 'staff_status'`)).toBe(1)
    await expect(setDraftStaffStatus(draftId, 'bogus' as 'new', 'x')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('retention erases contact details only when turned on', async () => {
    await saveDraft(draft(), { cfg: CFG, vehicleFetch }); await age(24 * 100)
    expect(await purgeExpiredDrafts({ cfg: CFG })).toEqual({ enabled: false, purged: 0, recovered: 0 })
    expect(await purgeExpiredDrafts({ cfg: { ...CFG, draftRetentionEnabled: true, draftRetentionDays: 90 } })).toEqual({ enabled: true, purged: 1, recovered: 0 })
    expect((await q('SELECT status, first_name, email, phone, follow_up_status FROM booking_drafts'))[0])
      .toEqual({ status: 'purged', first_name: null, email: null, phone: null, follow_up_status: 'suppressed' })
  })
})

// ── Regressions from the independent review (2026-10-20) ─────────────────────

const RETAIN: BookingConfig = { ...ON, draftRetentionEnabled: true, draftRetentionDays: 90 }
const row = async (where = 'true') => (await q<Record<string, unknown>>(`SELECT * FROM booking_drafts WHERE ${where} ORDER BY created_at LIMIT 1`))[0]
const events = async () => (await q<{ event_type: string; actor: string; meta: Record<string, unknown> }>('SELECT event_type, actor, meta FROM booking_draft_events ORDER BY created_at, id'))
const eventTypes = async () => (await events()).map((e) => e.event_type)
/** Put a draft in the state an interrupted worker leaves behind. */
const stuckSending = (cleared: boolean, minutesAgo = 60) => pg.exec(`UPDATE booking_drafts SET follow_up_status = 'sending',
  follow_up_attempts = follow_up_attempts + 1, follow_up_claimed_at = now() - interval '${minutesAgo} minutes',
  follow_up_cleared_at = ${cleared ? `now() - interval '${minutesAgo} minutes'` : 'NULL'}`)

describe('follow-up: final check against concurrent changes', () => {
  it('permission withdrawn by the customer after a worker claimed the email → not sent', async () => {
    const d = draft()
    await saveDraft(d, { cfg: ON, vehicleFetch }); await age(25)
    const p = capture()
    const t = await dispatchDraftFollowUps({ cfg: ON, provider: p, onClaimed: async () => {
      await saveDraft({ ...d, followUpConsent: false }, { cfg: ON, vehicleFetch }) // the real customer path
    } })
    expect(p.sent).toHaveLength(0)
    expect(t).toMatchObject({ sent: 0, suppressed: 1 })
    expect(await row()).toMatchObject({ follow_up_status: 'not_permitted', follow_up_error: 'permission withdrawn', follow_up_cleared_at: null })
    // And it stays unsent on later runs.
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    expect(p.sent).toHaveLength(0)
  })

  it('permission flag changed underneath the claim (direct write) → not sent', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const p = capture()
    await dispatchDraftFollowUps({ cfg: ON, provider: p, onClaimed: async () => { await pg.exec('UPDATE booking_drafts SET follow_up_consent = false') } })
    expect(p.sent).toHaveLength(0)
  })

  it('customer booked (another session, same email) after the claim → suppressed', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const p = capture()
    await dispatchDraftFollowUps({ cfg: ON, provider: p, onClaimed: async () => { await book({ email: 'dana.lee@example.com' }) } })
    expect(p.sent).toHaveLength(0)
    expect(await row()).toMatchObject({ follow_up_status: 'suppressed', follow_up_error: 'customer has booked' })
  })

  it('customer booked with this draft after the claim → suppressed, draft closed', async () => {
    const d = draft()
    await saveDraft(d, { cfg: ON, vehicleFetch }); await age(25)
    const p = capture()
    await dispatchDraftFollowUps({ cfg: ON, provider: p, onClaimed: async () => { await book({ draftKey: d.draftKey }) } })
    expect(p.sent).toHaveLength(0)
    expect(await row()).toMatchObject({ status: 'booked', follow_up_status: 'suppressed' })
  })

  it('customer came back (or changed their email) after the claim → deferred a full delay, then sent once to the NEW address', async () => {
    const d = draft()
    await saveDraft(d, { cfg: ON, vehicleFetch }); await age(25)
    const p = capture()
    const t = await dispatchDraftFollowUps({ cfg: ON, provider: p, onClaimed: async () => {
      await saveDraft({ ...d, email: 'dana.new@example.com' }, { cfg: ON, vehicleFetch })
    } })
    expect(t).toMatchObject({ sent: 0, deferred: 1 })
    expect(await row()).toMatchObject({ follow_up_status: 'pending', email: 'dana.new@example.com' })
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: p })).sent).toBe(0) // not early: activity just now
    await pg.exec(`UPDATE booking_drafts SET last_activity_at = now() - interval '25 hours'`)
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: p })).sent).toBe(1)
    expect(p.sent.map((m) => m.to)).toEqual(['dana.new@example.com'])
  })

  it('a change that lands while the provider call is in flight is recorded, not silent', async () => {
    const d = draft()
    await saveDraft(d, { cfg: ON, vehicleFetch }); await age(25)
    const sent: EmailMessage[] = []
    const slow: TransactionalEmailProvider = { name: 'fake', live: true, async send(m) {
      await saveDraft({ ...d, followUpConsent: false }, { cfg: ON, vehicleFetch }) // withdrawn mid-send
      sent.push(m); return { status: 'sent', providerMessageId: 'm1' }
    } }
    await dispatchDraftFollowUps({ cfg: ON, provider: slow })
    expect(sent).toHaveLength(1)
    const raced = (await events()).find((e) => e.event_type === 'follow_up_raced_change')
    expect(raced?.meta).toMatchObject({ permissionWithdrawn: true })
    expect(await row()).toMatchObject({ follow_up_status: 'sent', follow_up_consent: false })
  })

  it('two unfinished bookings for the same address, two workers at once → exactly one email', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch })
    await saveDraft(draft(), { cfg: ON, vehicleFetch })
    await age(25)
    const p = capture()
    await Promise.all([dispatchDraftFollowUps({ cfg: ON, provider: p }), dispatchDraftFollowUps({ cfg: ON, provider: p }), dispatchDraftFollowUps({ cfg: ON, provider: p })])
    expect(p.sent).toHaveLength(1)
    expect(await count('booking_drafts', `follow_up_status = 'sent'`)).toBe(1)
    expect(await count('booking_drafts', `follow_up_status = 'suppressed' AND follow_up_error = 'already sent a follow-up'`)).toBe(1)
  })

  it('never early: not at 23 h 59 m, yes at 24 h 01 m after the last activity', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch })
    const [{ t }] = await q<{ t: Date }>('SELECT last_activity_at AS t FROM booking_drafts')
    const at = (ms: number) => new Date(new Date(t).getTime() + ms)
    const p = capture()
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: p, now: at(24 * 3_600_000 - 60_000) })).sent).toBe(0)
    expect((await dispatchDraftFollowUps({ cfg: ON, provider: p, now: at(24 * 3_600_000 + 60_000) })).sent).toBe(1)
  })
})

describe('follow-up: closed leads', () => {
  it('closing a lead suppresses its pending email at once, records both changes, and it is never sent', async () => {
    const { draftId } = await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    await setDraftStaffStatus(draftId, 'closed', 'Owner')
    expect(await row()).toMatchObject({ staff_status: 'closed', follow_up_status: 'suppressed', follow_up_error: LEAD_CLOSED })
    const ev = await events()
    expect(ev.find((e) => e.event_type === 'staff_status')).toMatchObject({ actor: 'Owner', meta: { status: 'closed', from: 'new' } })
    expect(ev.find((e) => e.event_type === 'follow_up_suppressed')).toMatchObject({ actor: 'Owner', meta: { reason: LEAD_CLOSED, from: 'pending' } })
    const p = capture()
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    // Reopening does not resume the automatic email, and it can't be queued again.
    await setDraftStaffStatus(draftId, 'contacted', 'Owner')
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    expect(p.sent).toHaveLength(0)
  })

  it('closed after a worker claimed the email → stopped by the final check', async () => {
    const { draftId } = await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const p = capture()
    await dispatchDraftFollowUps({ cfg: ON, provider: p, onClaimed: async () => { await setDraftStaffStatus(draftId, 'closed', 'Owner') } })
    expect(p.sent).toHaveLength(0)
    expect(await row()).toMatchObject({ follow_up_status: 'suppressed', follow_up_error: LEAD_CLOSED })
  })

  it('a closed lead is never selected, even if the customer later re-ticks permission', async () => {
    const d = draft({ followUpConsent: false })
    const { draftId } = await saveDraft(d, { cfg: ON, vehicleFetch })
    await setDraftStaffStatus(draftId, 'closed', 'Owner')
    await saveDraft({ ...d, followUpConsent: true }, { cfg: ON, vehicleFetch }) // pending again, but closed
    await age(25)
    const p = capture()
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    expect(p.sent).toHaveLength(0)
  })

  it('manual "queue again" refuses a closed lead', async () => {
    const { draftId } = await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const none: TransactionalEmailProvider = { name: 'none', live: false, async send() { return { status: 'not_configured' } } }
    await dispatchDraftFollowUps({ cfg: ON, provider: none })
    expect(await row()).toMatchObject({ follow_up_status: 'not_configured' })
    await setDraftStaffStatus(draftId, 'closed', 'Owner')
    expect(await row()).toMatchObject({ follow_up_status: 'suppressed' })
    expect(await requeueDraftFollowUp(draftId, 'Owner')).toBe(false)
    // An open lead can be queued again (and that is recorded).
    const other = await saveDraft(draft({ email: 'other@example.com', phone: '9795550222' }), { cfg: ON, vehicleFetch })
    await pg.exec(`UPDATE booking_drafts SET last_activity_at = now() - interval '25 hours'`)
    await dispatchDraftFollowUps({ cfg: ON, provider: none })
    expect(await requeueDraftFollowUp(other.draftId, 'Owner')).toBe(true)
    expect(await eventTypes()).toContain('follow_up_requeued')
  })
})

describe('follow-up: interrupted workers + retention', () => {
  it('a stale claim that never passed the final check is provably unsent → retried once, delivered once', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    await stuckSending(false)
    const p = capture()
    const t = await dispatchDraftFollowUps({ cfg: ON, provider: p })
    expect(t).toMatchObject({ recovered: 1, sent: 1 })
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    expect(p.sent).toHaveLength(1)
    expect(await eventTypes()).toContain('follow_up_recovered')
  })

  it('a stale claim that passed the final check may have been sent → "uncertain", never retried', async () => {
    const { draftId } = await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    await stuckSending(true)
    const p = capture()
    expect(await dispatchDraftFollowUps({ cfg: ON, provider: p })).toMatchObject({ recovered: 1, sent: 0 })
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    expect(p.sent).toHaveLength(0)
    expect(await row()).toMatchObject({ follow_up_status: 'uncertain' })
    expect(await requeueDraftFollowUp(draftId, 'Owner')).toBe(false)
    // …and it blocks a second email to the same address from another draft.
    await saveDraft(draft(), { cfg: ON, vehicleFetch })
    await pg.exec(`UPDATE booking_drafts SET last_activity_at = now() - interval '25 hours' WHERE follow_up_status = 'pending'`)
    await dispatchDraftFollowUps({ cfg: ON, provider: p })
    expect(p.sent).toHaveLength(0)
  })

  it('a fresh claim (another worker may still be sending) is left alone', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    await stuckSending(true, 2)
    expect(await recoverInterruptedFollowUps()).toBe(0)
    expect(await row()).toMatchObject({ follow_up_status: 'sending' })
  })

  it('a 100-day-old draft stuck "sending" is still erased (recovered in the same run)', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(24 * 100)
    await stuckSending(false, 24 * 60 * 100)
    expect(await purgeExpiredDrafts({ cfg: RETAIN })).toEqual({ enabled: true, purged: 1, recovered: 1 })
    expect(await row()).toMatchObject({ status: 'purged', email: null, phone: null, first_name: null, follow_up_status: 'suppressed' })
  })

  it('an "uncertain" draft is erased too, keeping the uncertain record', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(24 * 100)
    await stuckSending(true, 24 * 60 * 100)
    await purgeExpiredDrafts({ cfg: RETAIN })
    expect(await row()).toMatchObject({ status: 'purged', email: null, follow_up_status: 'uncertain' })
  })

  it('even a stuck row with no claim time (older code / manual edit) is recovered and erased', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(24 * 100)
    await pg.exec("UPDATE booking_drafts SET follow_up_status = 'sending'")
    expect((await purgeExpiredDrafts({ cfg: RETAIN })).purged).toBe(1)
  })

  it('retention erases a booked draft’s contact copy but never touches the appointment', async () => {
    const d = draft()
    await saveDraft(d, { cfg: CFG, vehicleFetch })
    const { appointment } = await book({ draftKey: d.draftKey })
    await pg.exec(`UPDATE booking_drafts SET last_activity_at = now() - interval '100 days'`)
    const before = await q(`SELECT * FROM appointments WHERE id = '${appointment.id}'`)
    expect((await purgeExpiredDrafts({ cfg: RETAIN })).purged).toBe(1)
    expect(await row()).toMatchObject({ status: 'booked', email: null, appointment_id: appointment.id })
    expect(await q(`SELECT * FROM appointments WHERE id = '${appointment.id}'`)).toEqual(before)
    expect(before[0]).toMatchObject({ email: 'dana.lee@example.com', status: 'confirmed' })
  })

  it('with retention on, an expired draft is never emailed (erased instead)', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(24 * 95)
    const p = capture()
    await dispatchDraftFollowUps({ cfg: RETAIN, provider: p })
    expect(p.sent).toHaveLength(0)
  })
})

// ── Ambiguous delivery (independent review 2026-10-20) ────────────────────────
// A fake Postmark HTTP transport: every call is a request that REACHED Postmark (and may have been accepted);
// what the client then sees is scripted per call.
type Answer = () => Response | Promise<Response>
function postmark(...answers: Answer[]) {
  let calls = 0
  const transport = (async () => { const a = answers[Math.min(calls, answers.length - 1)]; calls++; return a() }) as typeof fetch
  return { provider: new PostmarkEmailProvider('fake-token', 'shop@example.com', transport), calls: () => calls }
}
const accepted: Answer = () => new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-ok' }), { status: 200 })
const lostResponse: Answer = () => { throw new TypeError('fetch failed: response connection lost') }
const reply = (status: number, body: unknown): Answer => () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
const refused: Answer = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }) }

describe('follow-up: uncertain delivery is never sent twice', () => {
  it('Postmark accepts, then the response connection fails → "uncertain", no second send', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const pm = postmark(lostResponse, accepted)
    expect(await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })).toMatchObject({ sent: 0, failed: 0, uncertain: 1 })
    await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
    await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
    expect(pm.calls()).toBe(1)
    expect(await row()).toMatchObject({ follow_up_status: 'uncertain', follow_up_attempts: 1, follow_up_provider: 'postmark' })
    expect(String((await row()).follow_up_error)).toMatch(/may have been delivered/i)
    expect(await eventTypes()).toContain('follow_up_uncertain')
  })

  it('HTTP 200 with missing / unreadable acceptance details → "uncertain", no automatic retry', async () => {
    for (const answer of [reply(200, { ErrorCode: 0 }), reply(200, '<html>gateway</html>')]) {
      await pg.exec('DELETE FROM booking_draft_events; DELETE FROM booking_drafts')
      await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
      const pm = postmark(answer, accepted)
      await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
      await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
      expect(pm.calls()).toBe(1)
      expect(await row()).toMatchObject({ follow_up_status: 'uncertain' })
    }
  })

  it('a definite permanent rejection (422) is recorded as failed and not retried automatically', async () => {
    const { draftId } = await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const pm = postmark(reply(422, { ErrorCode: 406, Message: 'You tried to send to a recipient that has been marked as inactive.' }), accepted)
    expect(await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })).toMatchObject({ failed: 1, uncertain: 0 })
    await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
    expect(pm.calls()).toBe(1)
    expect(await row()).toMatchObject({ follow_up_status: 'failed', follow_up_attempts: 1 })
    expect(String((await row()).follow_up_error)).toContain('inactive')
    // Non-delivery is established, so staff may queue it again (e.g. after the customer fixes the address).
    expect(await requeueDraftFollowUp(draftId, 'Owner')).toBe(true)
  })

  it('a definite temporary failure (rate limit / connection refused) is retried, and delivered once', async () => {
    for (const first of [reply(429, { ErrorCode: 429, Message: 'Rate limit exceeded' }), refused]) {
      await pg.exec('DELETE FROM booking_draft_events; DELETE FROM booking_drafts')
      await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
      const pm = postmark(first, accepted)
      await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
      expect(await row()).toMatchObject({ follow_up_status: 'pending' })
      await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
      await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
      expect(pm.calls()).toBe(2)
      expect(await row()).toMatchObject({ follow_up_status: 'sent', follow_up_attempts: 2 })
    }
  })

  it('"uncertain" blocks another draft for the same address and every manual requeue', async () => {
    const first = await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    const pm = postmark(lostResponse, accepted)
    await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })
    expect(await requeueDraftFollowUp(first.draftId, 'Owner')).toBe(false)
    // A second unfinished booking with the same address (different case/session) is suppressed, not emailed.
    const second = await saveDraft(draft({ email: 'DANA.LEE@example.com' }), { cfg: ON, vehicleFetch })
    await pg.exec(`UPDATE booking_drafts SET last_activity_at = now() - interval '25 hours' WHERE id = '${second.draftId}'`)
    expect(await dispatchDraftFollowUps({ cfg: ON, provider: pm.provider })).toMatchObject({ sent: 0, suppressed: 1 })
    expect(pm.calls()).toBe(1)
    // A definitely-failed draft for that address can't be queued again either while delivery is uncertain.
    await pg.exec(`UPDATE booking_drafts SET follow_up_status = 'failed' WHERE id = '${second.draftId}'`)
    expect(await requeueDraftFollowUp(second.draftId, 'Owner')).toBe(false)
    expect(await row(`follow_up_status = 'uncertain'`)).toMatchObject({ id: first.draftId })
  })

  it('retention still erases an expired "uncertain" draft and leaves appointments untouched', async () => {
    await saveDraft(draft(), { cfg: ON, vehicleFetch }); await age(25)
    await dispatchDraftFollowUps({ cfg: ON, provider: postmark(lostResponse).provider })
    const { appointment } = await book({ email: 'someone.else@example.com', phone: '9795550333' })
    const before = await q(`SELECT * FROM appointments WHERE id = '${appointment.id}'`)
    await pg.exec(`UPDATE booking_drafts SET last_activity_at = now() - interval '100 days'`)
    expect((await purgeExpiredDrafts({ cfg: RETAIN })).purged).toBe(1)
    expect(await row()).toMatchObject({ status: 'purged', email: null, phone: null, first_name: null, follow_up_status: 'uncertain' })
    expect(await q(`SELECT * FROM appointments WHERE id = '${appointment.id}'`)).toEqual(before)
  })
})
