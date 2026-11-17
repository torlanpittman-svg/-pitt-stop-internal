/**
 * Appointments data layer.
 *
 * ATOMICITY: every booking / reschedule runs as ONE transaction (Neon batch): a per-day advisory lock,
 * then a single INSERT/UPDATE whose WHERE clause re-checks capacity, with its append-only event and its
 * outbox notifications written in the same statement (data-modifying CTEs). Two customers racing for the
 * last opening serialize on the lock; the second sees the first's committed row and gets "full".
 * Nothing is written when capacity is gone, so a failed booking leaves no partial state.
 *
 * IDEMPOTENCY: the client sends one idempotency key per submission; a retry/double-tap returns the same
 * appointment (unique index), never a second one.
 *
 * Customer/directory linking, SMS consent and the Marketing lead run AFTER the booking commits and are
 * best-effort: a directory hiccup never loses a confirmed appointment (check-in links it again anyway).
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { getDb } from '@/platform/db'
import { appSettings } from '@/apps/settings/schema'
import { SETTINGS, updateSetting } from '@/apps/settings/db'
import { findOrCreateIntakeCustomer } from '@/apps/directory/intake-customer'
import { normalizePhone } from '@/apps/directory/customer-profile'
import { grantSmsConsent } from '@/apps/marketing/consent'
import { createLead, updateLead } from '@/apps/marketing/leads'
import { recordAttribution } from '@/apps/marketing/attribution'
import { appointments, appointmentEvents, appointmentBlocks, appointmentNotifications } from './schema'
import {
  type BookingConfig, type Block, type BookedLoad, type Need, mergeBookingConfig, publicBookingOpen, resolveServices,
  validatePublicSlot, zonedToUtc, localParts, addDays, isIsoDate, isHHMM, computeAvailability,
} from './policy'
import { appointmentToken, hashToken, newReference, isTokenShape } from './tokens'
import { cleanAttribution, classifySource, attributionConfidence, campaignIdFrom, type BookingAttribution } from './attribution'
import { normalizeBookingReferral, validateBookingReferral, type BookingReferral } from './referral'
import { validateContact } from './contact'
import { validateVehicle } from './vehicles'

export type Appointment = typeof appointments.$inferSelect
export type AppointmentEvent = typeof appointmentEvents.$inferSelect
export type AppointmentNotification = typeof appointmentNotifications.$inferSelect

export const ACTIVE_STATUSES = ['confirmed', 'arrived'] as const
export const APPOINTMENT_SOURCES = ['website_booking', 'phone', 'walk_in', 'facebook', 'google_ads', 'marketing', 'autoleap_import', 'other'] as const
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number]

export class BookingError extends Error {
  constructor(public code: 'invalid' | 'closed' | 'full' | 'rate_limited' | 'not_found' | 'conflict' | 'too_late', message: string) { super(message) }
}

// ── Config ────────────────────────────────────────────────────────────────────

export const BOOKING_CONFIG_KEY = 'booking_config'

export async function getBookingConfig(): Promise<BookingConfig> {
  const [row] = await getDb().select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, BOOKING_CONFIG_KEY)).limit(1)
  return mergeBookingConfig(row?.value ?? process.env.BOOKING_CONFIG ?? SETTINGS[BOOKING_CONFIG_KEY]?.def ?? '{}')
}

export async function saveBookingConfig(cfg: BookingConfig, actor: string): Promise<void> {
  await updateSetting(BOOKING_CONFIG_KEY, mergeBookingConfig(cfg), actor)
}

// ── Transaction helper ────────────────────────────────────────────────────────

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : ((r as { rows?: Record<string, unknown>[] })?.rows ?? [])

/** Run raw statements in ONE transaction: Neon batch in production, a real transaction elsewhere (tests). */
export async function runAtomic(stmts: SQL[]): Promise<Record<string, unknown>[][]> {
  const db = getDb() as unknown as {
    batch?: (q: unknown[]) => Promise<unknown[]>
    execute: (s: SQL) => unknown
    transaction: <T>(fn: (tx: { execute: (s: SQL) => Promise<unknown> }) => Promise<T>) => Promise<T>
  }
  if (typeof db.batch === 'function') return (await db.batch(stmts.map((s) => db.execute(s)))).map(rowsOf)
  return db.transaction(async (tx) => {
    const out: Record<string, unknown>[][] = []
    for (const s of stmts) out.push(rowsOf(await tx.execute(s)))
    return out
  })
}

const dayLock = (date: string) => sql`SELECT pg_advisory_xact_lock(hashtext(${`appointments:${date}`}))`

/** SQL predicate: the date/time still has room for `need` (active bookings only, optionally excluding one). */
function capacitySql(cfg: BookingConfig, date: string, time: string, need: Need, excludeId: string | null): SQL {
  const active = sql`status IN ('confirmed', 'arrived')`
  const ex = excludeId ? sql` AND id <> ${excludeId}::uuid` : sql``
  const parts: SQL[] = []
  if (cfg.slotCapacity != null) {
    parts.push(sql`(SELECT count(*) FROM appointments WHERE local_date = ${date}::date AND local_time = ${time} AND ${active}${ex}) < ${cfg.slotCapacity}`)
  }
  if (cfg.dailyAppointmentLimit != null) {
    parts.push(sql`(SELECT count(*) FROM appointments WHERE local_date = ${date}::date AND ${active}${ex}) < ${cfg.dailyAppointmentLimit}`)
  }
  // Workload units (service weights) only count when a manager has turned workload limits on.
  if (!cfg.workloadLimitsEnabled) return parts.length ? sql.join(parts, sql` AND `) : sql`true`
  if (cfg.dailyUnits != null) {
    parts.push(sql`(SELECT coalesce(sum(units_detail + units_mechanic), 0) FROM appointments WHERE local_date = ${date}::date AND ${active}${ex}) + ${need.detail + need.mechanic} <= ${cfg.dailyUnits}`)
  }
  if (cfg.categoryLimits.detail != null && need.detail > 0) {
    parts.push(sql`(SELECT coalesce(sum(units_detail), 0) FROM appointments WHERE local_date = ${date}::date AND ${active}${ex}) + ${need.detail} <= ${cfg.categoryLimits.detail}`)
  }
  if (cfg.categoryLimits.mechanic != null && need.mechanic > 0) {
    parts.push(sql`(SELECT coalesce(sum(units_mechanic), 0) FROM appointments WHERE local_date = ${date}::date AND ${active}${ex}) + ${need.mechanic} <= ${cfg.categoryLimits.mechanic}`)
  }
  return parts.length ? sql.join(parts, sql` AND `) : sql`true`
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function activeLoads(fromDate: string, toDate: string, excludeId: string | null = null): Promise<BookedLoad[]> {
  const rows = await getDb().select({
    id: appointments.id, localDate: appointments.localDate, localTime: appointments.localTime,
    unitsDetail: appointments.unitsDetail, unitsMechanic: appointments.unitsMechanic,
  }).from(appointments).where(and(
    gte(appointments.localDate, fromDate), sql`${appointments.localDate} <= ${toDate}::date`,
    inArray(appointments.status, [...ACTIVE_STATUSES]),
  ))
  return rows.filter((r) => r.id !== excludeId)
}

export async function activeBlocks(fromDate: string, toDate: string): Promise<Block[]> {
  const rows = await getDb().select().from(appointmentBlocks).where(and(
    isNull(appointmentBlocks.removedAt), gte(appointmentBlocks.localDate, fromDate), sql`${appointmentBlocks.localDate} <= ${toDate}::date`,
  ))
  return rows.map((b) => ({ kind: b.kind === 'open' ? 'open' : 'close', localDate: b.localDate, localTime: b.localTime, reason: b.reason }))
}

/** Availability for the public page / staff form. Exposes only per-slot yes/no — never other bookings. */
export async function getAvailability(input: { cfg?: BookingConfig; serviceKeys: string[]; fromDate?: string; days?: number; now?: Date; excludeId?: string | null; publicOnly?: boolean }) {
  const cfg = input.cfg ?? await getBookingConfig()
  const now = input.now ?? new Date()
  const today = localParts(now, cfg.timezone).date
  const fromDate = input.fromDate && isIsoDate(input.fromDate) && input.fromDate >= today ? input.fromDate : today
  const days = Math.min(Math.max(input.days ?? 14, 1), cfg.maxAdvanceDays + 1)
  const toDate = addDays(fromDate, days - 1)
  const resolved = resolveServices(cfg, input.serviceKeys, { publicOnly: input.publicOnly ?? true })
  const need = resolved.ok ? resolved.need : { detail: 1, mechanic: 0 }
  const [loads, blocks] = await Promise.all([activeLoads(fromDate, toDate, input.excludeId ?? null), activeBlocks(fromDate, toDate)])
  return { cfg, today, days: computeAvailability({ cfg, now, fromDate, days, loads, blocks, need }) }
}

export async function getAppointment(id: string): Promise<Appointment | null> {
  if (!z.uuid().safeParse(id).success) return null
  const [row] = await getDb().select().from(appointments).where(eq(appointments.id, id)).limit(1)
  return row ?? null
}

export async function getAppointmentByToken(token: string): Promise<Appointment | null> {
  if (!isTokenShape(token)) return null
  const [row] = await getDb().select().from(appointments).where(eq(appointments.tokenHash, hashToken(token))).limit(1)
  return row ?? null
}

export async function getAppointmentByIdempotencyKey(key: string): Promise<Appointment | null> {
  const [row] = await getDb().select().from(appointments).where(eq(appointments.idempotencyKey, key)).limit(1)
  return row ?? null
}

export async function listAppointments(opts: { view: 'today' | 'upcoming' | 'past' | 'search' | 'new'; q?: string; now?: Date; tz?: string; limit?: number }): Promise<Appointment[]> {
  const db = getDb()
  const today = localParts(opts.now ?? new Date(), opts.tz ?? 'America/Chicago').date
  const limit = opts.limit ?? 200
  if (opts.view === 'today') {
    return db.select().from(appointments).where(eq(appointments.localDate, today)).orderBy(asc(appointments.localTime), asc(appointments.createdAt)).limit(limit)
  }
  if (opts.view === 'upcoming') {
    return db.select().from(appointments).where(and(sql`${appointments.localDate} > ${today}::date`, inArray(appointments.status, ['confirmed'])))
      .orderBy(asc(appointments.localDate), asc(appointments.localTime)).limit(limit)
  }
  if (opts.view === 'past') {
    return db.select().from(appointments).where(lt(appointments.localDate, today)).orderBy(desc(appointments.localDate), desc(appointments.localTime)).limit(limit)
  }
  if (opts.view === 'new') {
    return db.select().from(appointments).where(and(eq(appointments.source, 'website_booking'), isNull(appointments.acknowledgedAt), inArray(appointments.status, ['confirmed'])))
      .orderBy(asc(appointments.createdAt)).limit(limit)
  }
  const q = (opts.q ?? '').trim().slice(0, 80)
  if (q.length < 2) return []
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const digits = q.replace(/\D/g, '')
  return db.select().from(appointments).where(or(
    ilike(appointments.firstName, like), ilike(appointments.lastName, like), ilike(appointments.email, like),
    ilike(appointments.reference, like), ilike(appointments.vehicleMake, like), ilike(appointments.vehicleModel, like),
    sql`(${appointments.firstName} || ' ' || ${appointments.lastName}) ILIKE ${like}`,
    ...(digits.length >= 4 ? [ilike(appointments.normalizedPhone, `%${digits}%`)] : []),
  )).orderBy(desc(appointments.localDate), desc(appointments.localTime)).limit(limit)
}

export async function listEvents(appointmentId: string): Promise<AppointmentEvent[]> {
  return getDb().select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, appointmentId)).orderBy(asc(appointmentEvents.createdAt))
}

export async function listNotifications(appointmentId: string): Promise<AppointmentNotification[]> {
  return getDb().select().from(appointmentNotifications).where(eq(appointmentNotifications.appointmentId, appointmentId)).orderBy(asc(appointmentNotifications.createdAt))
}

export async function countUnacknowledged(): Promise<number> {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(appointments)
    .where(and(eq(appointments.source, 'website_booking'), isNull(appointments.acknowledgedAt), eq(appointments.status, 'confirmed')))
  return r?.n ?? 0
}

// ── Create ────────────────────────────────────────────────────────────────────

const trimmed = (max: number) => z.string().trim().max(max)
export const bookingInput = z.object({
  idempotencyKey: z.string().trim().min(8).max(80).regex(/^[\w-]+$/),
  date: z.string().refine(isIsoDate, 'Choose a valid date.'),
  time: z.string().refine(isHHMM, 'Choose a valid time.'),
  serviceKeys: z.array(z.string().max(40)).min(1).max(12),
  firstName: trimmed(120).min(1, 'First name is required.'),
  lastName: trimmed(120).default(''),
  phone: trimmed(40).default(''),
  email: z.union([z.email().max(240), z.literal('')]).default(''),
  vehicleType: z.union([z.enum(['car', 'motorcycle', 'trailer']), z.literal('')]).default(''),
  vehicleYear: z.union([z.string().regex(/^(19|20)\d{2}$/, 'Enter a 4-digit year.'), z.literal('')]).default(''),
  vehicleMake: trimmed(100).default(''),
  vehicleModel: trimmed(100).default(''),
  vehicleColor: trimmed(60).default(''),
  vehiclePlate: trimmed(20).default(''),
  vehicleVin: z.union([z.string().trim().toUpperCase().regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'A VIN is 17 letters and numbers.'), z.literal('')]).default(''),
  notes: trimmed(2000).default(''),
  internalNotes: trimmed(2000).default(''),
  smsMarketingOptIn: z.boolean().default(false),
  attribution: z.record(z.string(), z.unknown()).default({}),
  /** "How did you hear about us?" — the customer's own answer. REQUIRED for public bookings, optional for staff
   *  entries (decided in createAppointment, where the mode is known); "other" always needs a short explanation. */
  referralSource: z.string().trim().max(40).default(''),
  referralDetail: trimmed(120).default(''),
  externalRef: z.string().trim().max(120).optional(),
  /** The public page's unfinished-booking key: the draft is marked booked in the same transaction. */
  draftKey: z.string().trim().min(8).max(80).regex(/^[\w-]+$/).optional(),
})
export type BookingInput = z.input<typeof bookingInput>

export interface CreateOptions {
  mode: 'public' | 'staff'
  source: AppointmentSource
  actor: string | null
  /** Manager override: bypasses the public window, closures and capacity (recorded on the appointment). */
  override?: boolean
  ipHash?: string | null
  now?: Date
  cfg?: BookingConfig
  /** Exact wording + version shown next to the optional SMS marketing checkbox (stored with consent). */
  smsConsent?: { text: string; version: string; ip?: string | null; userAgent?: string | null }
  /** Test hook for the NHTSA model lookup used by public vehicle validation. */
  vehicleFetch?: typeof fetch
}

export interface CreateResult { appointment: Appointment; token: string; replayed: boolean }

export const PUBLIC_HOURLY_LIMIT = 6

export function hashIp(ip: string | null | undefined): string | null {
  return ip ? createHash('sha256').update(`appt-ip:${ip}`).digest('hex') : null
}

export async function createAppointment(raw: BookingInput, opts: CreateOptions): Promise<CreateResult> {
  const parsed = bookingInput.safeParse(raw)
  if (!parsed.success) throw new BookingError('invalid', parsed.error.issues[0]?.message ?? 'Check the form and try again.')
  const input = parsed.data
  const cfg = opts.cfg ?? await getBookingConfig()
  const now = opts.now ?? new Date()
  const override = opts.mode === 'staff' && !!opts.override

  const existing = await getAppointmentByIdempotencyKey(input.idempotencyKey)
  if (existing) return { appointment: existing, token: appointmentToken(existing.id), replayed: true }

  const phoneDigits = normalizePhone(input.phone)
  if (opts.mode === 'public') {
    if (!publicBookingOpen(cfg)) throw new BookingError('closed', 'Online booking is not available right now. Please call the shop.')
    // First name, last name, phone and email are all required online (format checks only — not proof of ownership).
    const contactErrors = validateContact({ firstName: input.firstName, lastName: input.lastName, phone: input.phone, email: input.email })
    const firstError = Object.values(contactErrors)[0]
    if (firstError) throw new BookingError('invalid', firstError)
    // The vehicle must come from the dropdown lists (never a typed-in name).
    const badVehicle = await validateVehicle({ type: input.vehicleType, year: input.vehicleYear, make: input.vehicleType === 'trailer' ? 'Trailer' : input.vehicleMake, model: input.vehicleModel }, { fetchImpl: opts.vehicleFetch })
    if (badVehicle) throw new BookingError('invalid', badVehicle)
    if (opts.ipHash) {
      const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(appointments)
        .where(and(eq(appointments.ipHash, opts.ipHash), gte(appointments.createdAt, new Date(now.getTime() - 3_600_000))))
      if ((r?.n ?? 0) >= PUBLIC_HOURLY_LIMIT) throw new BookingError('rate_limited', 'Too many bookings from this connection. Please call the shop.')
    }
  } else if (!input.phone && !input.email) {
    throw new BookingError('invalid', 'Enter a phone number or email for the customer.')
  }
  // Self-reported source: required online (the form cannot skip it, and neither can a hand-made request); staff
  // phone entries may leave it blank. Stored beside — never merged into — `attribution` (utm_* / gclid / fbclid).
  const referral = normalizeBookingReferral({ source: input.referralSource, detail: input.referralDetail })
  const referralError = Object.values(validateBookingReferral(referral, { required: opts.mode === 'public' }))[0]
  if (referralError) throw new BookingError('invalid', referralError)

  const services = resolveServices(cfg, input.serviceKeys, { publicOnly: opts.mode === 'public' })
  if (!services.ok) throw new BookingError('invalid', services.error)

  if (!override) {
    const blocks = await activeBlocks(input.date, input.date)
    // Staff entering a phone booking follow the same window/closures/capacity, minus the online lead time.
    const rules = opts.mode === 'staff' ? { ...cfg, sameDayLeadMinutes: 0 } : cfg
    const bad = validatePublicSlot(rules, input.date, input.time, now, blocks)
    if (bad) throw new BookingError('closed', bad)
  }

  const id = randomUUID()
  const token = appointmentToken(id)
  const reference = newReference()
  const startsAt = zonedToUtc(input.date, input.time, cfg.timezone)
  const attribution = cleanAttribution(input.attribution)
  const email = input.email ? input.email.toLowerCase() : null

  const notices: SQL[] = []
  if (email && cfg.confirmationEnabled) {
    notices.push(sql`(SELECT id FROM ins), 'confirmation', ${email}, ${`${id}:confirmation`}, now()`)
  }
  const reminderAt = new Date(startsAt.getTime() - cfg.reminderHoursBefore * 3_600_000)
  // No reminder when the booking is already inside the reminder window (a same-day booking gets its
  // confirmation only — never an immediate "reminder").
  if (email && cfg.reminderEnabled && reminderAt.getTime() > now.getTime()) {
    notices.push(sql`(SELECT id FROM ins), 'reminder', ${email}, ${`${id}:reminder:${startsAt.toISOString()}`}, ${reminderAt.toISOString()}::timestamptz`)
  }
  const noticeCte = notices.length
    ? sql`, nt AS (INSERT INTO appointment_notifications (appointment_id, kind, to_address, dedupe_key, send_after)
        SELECT * FROM (VALUES ${sql.join(notices.map((n) => sql`(${n})`), sql`, `)}) v(a, k, t, d, s) WHERE EXISTS (SELECT 1 FROM ins)
        ON CONFLICT (dedupe_key) DO NOTHING)`
    : sql``
  // Completing the booking closes its unfinished-booking draft atomically: marked booked and any pending
  // follow-up suppressed, so no "finish your booking" email can follow a confirmed appointment.
  const draftCte = input.draftKey && opts.mode === 'public'
    ? sql`, dr AS (
        UPDATE booking_drafts SET status = 'booked', appointment_id = (SELECT id FROM ins), completed_at = now(), last_activity_at = now(),
          follow_up_status = CASE WHEN follow_up_status = 'pending' THEN 'suppressed' ELSE follow_up_status END
        WHERE client_key = ${input.draftKey} AND status = 'open' AND EXISTS (SELECT 1 FROM ins)
        RETURNING id
      ), dre AS (
        INSERT INTO booking_draft_events (draft_id, event_type, actor, meta) SELECT id, 'booked', 'customer', jsonb_build_object('appointment_id', (SELECT id FROM ins)) FROM dr
      )`
    : sql``

  const insert = sql`WITH ins AS (
      INSERT INTO appointments (id, reference, token_hash, idempotency_key, status, local_date, local_time, starts_at,
        service_keys, service_labels, units_detail, units_mechanic, first_name, last_name, phone, normalized_phone, email,
        vehicle_type, vehicle_year, vehicle_make, vehicle_model, vehicle_color, vehicle_plate, vehicle_vin, customer_notes, internal_notes,
        source, attribution, external_ref, sms_marketing_opt_in, capacity_override, ip_hash, created_by, referral_source, referral_detail)
      SELECT ${id}::uuid, ${reference}, ${hashToken(token)}, ${input.idempotencyKey}, 'confirmed', ${input.date}::date, ${input.time},
        ${startsAt.toISOString()}::timestamptz, ${JSON.stringify(services.services.map((s) => s.key))}::jsonb, ${services.labels},
        ${services.need.detail}, ${services.need.mechanic}, ${input.firstName}, ${input.lastName}, ${input.phone},
        ${phoneDigits || null}, ${email}, ${input.vehicleType || null}, ${input.vehicleYear || null},
        ${input.vehicleType === 'trailer' ? 'Trailer' : input.vehicleMake || null}, ${input.vehicleModel || null},
        ${input.vehicleColor || null}, ${input.vehiclePlate.toUpperCase() || null}, ${input.vehicleVin || null}, ${input.notes || null},
        ${input.internalNotes || null}, ${opts.source}, ${JSON.stringify(attribution)}::jsonb, ${input.externalRef ?? null},
        ${input.smsMarketingOptIn}, ${override}, ${opts.ipHash ?? null}, ${opts.actor}, ${referral.source}, ${referral.detail || null}
      WHERE ${override ? sql`true` : capacitySql(cfg, input.date, input.time, services.need, null)}
      ON CONFLICT DO NOTHING
      RETURNING id
    ), ev AS (
      INSERT INTO appointment_events (appointment_id, event_type, actor, meta)
      SELECT id, 'booked', ${opts.actor}, ${JSON.stringify({ source: opts.source, mode: opts.mode, override, date: input.date, time: input.time, services: services.labels })}::jsonb FROM ins
    )${noticeCte}${draftCte}
    SELECT id FROM ins`

  const [, inserted] = await runAtomic([dayLock(input.date), insert])
  if (!inserted.length) {
    const raced = await getAppointmentByIdempotencyKey(input.idempotencyKey)
    if (raced) return { appointment: raced, token: appointmentToken(raced.id), replayed: true }
    if (input.externalRef) {
      const [dup] = await getDb().select().from(appointments).where(eq(appointments.externalRef, input.externalRef)).limit(1)
      if (dup) return { appointment: dup, token: appointmentToken(dup.id), replayed: true }
    }
    throw new BookingError('full', 'That time was just taken. Please pick another time.')
  }

  await linkAfterBooking(id, input, opts, attribution, referral).catch((err) => console.error('[appointments] post-booking link failed (booking kept):', err))
  const appointment = await getAppointment(id)
  return { appointment: appointment!, token, replayed: false }
}

/** Best-effort, post-commit: canonical customer, explicit SMS marketing consent, Marketing lead. */
async function linkAfterBooking(id: string, input: z.infer<typeof bookingInput>, opts: CreateOptions, attribution: BookingAttribution, referral: BookingReferral): Promise<void> {
  const name = `${input.firstName} ${input.lastName}`.trim()
  let customerId: string | null = null
  try {
    const link = await findOrCreateIntakeCustomer({ name, phone: input.phone || null, email: input.email || null }, null, 'appointment')
    customerId = link?.id ?? null
  } catch (err) { console.error('[appointments] customer link failed:', err) }

  // Promotional SMS consent ONLY when the customer ticked the (unchecked-by-default) box. Booking itself
  // never creates marketing consent.
  if (customerId && input.smsMarketingOptIn && opts.smsConsent && normalizePhone(input.phone).length >= 10) {
    try {
      await grantSmsConsent(customerId, {
        source: 'website_form', wordingVersion: opts.smsConsent.version, consentText: opts.smsConsent.text,
        phone: input.phone, ip: opts.smsConsent.ip ?? null, userAgent: opts.smsConsent.userAgent ?? null,
      })
    } catch (err) { console.error('[appointments] sms consent record failed:', err) }
  }

  let leadId: string | null = null
  try {
    const source = classifySource(attribution)
    const vehicle = [input.vehicleYear, input.vehicleMake, input.vehicleModel].filter(Boolean).join(' ') || null
    const campaignId = campaignIdFrom(attribution)
    const validCampaign = campaignId
      ? rowsOf(await getDb().execute(sql`SELECT id FROM marketing_campaigns WHERE id = ${campaignId}::uuid LIMIT 1`)).length > 0
      : false
    const lead = await createLead({
      name, phone: input.phone || null, email: input.email || null, vehicle, source,
      requestedService: input.serviceKeys[0]?.slice(0, 40) ?? null, campaignId: validCampaign ? campaignId : null,
      customerId, notes: `Appointment ${input.date} ${input.time} (${opts.source})`,
      // The customer's own answer rides along on the lead's OWN columns; `source` above stays the click-derived one.
      referralSource: referral.source, referralDetail: referral.detail || null,
    }, opts.actor)
    leadId = lead.id
    await updateLead(lead.id, { status: 'booked' }, opts.actor)
    await recordAttribution({
      source, medium: attribution.utm_medium ?? null, campaign: attribution.utm_campaign ?? null,
      utmSource: attribution.utm_source ?? null, utmMedium: attribution.utm_medium ?? null, utmCampaign: attribution.utm_campaign ?? null,
      clickId: attribution.gclid ?? attribution.fbclid ?? null, touchType: 'first', confidence: attributionConfidence(attribution),
      customerId, leadId: lead.id, campaignId: validCampaign ? campaignId : null,
    }, opts.actor)
  } catch (err) { console.error('[appointments] marketing lead failed:', err) }

  if (customerId || leadId) {
    await getDb().update(appointments).set({ customerId, marketingLeadId: leadId, updatedAt: new Date() }).where(eq(appointments.id, id))
  }
}

// ── Status changes (each ONE conditional statement + its append-only event) ───

async function transition(id: string, from: string[], set: SQL, event: string, actor: string | null, meta: Record<string, unknown>, extra: SQL = sql``): Promise<boolean> {
  const rows = rowsOf(await getDb().execute(sql`WITH u AS (
      UPDATE appointments SET ${set}, updated_at = now() WHERE id = ${id}::uuid AND status IN (${sql.join(from.map((f) => sql`${f}`), sql`, `)}) RETURNING id, email
    ), ev AS (
      INSERT INTO appointment_events (appointment_id, event_type, actor, meta) SELECT id, ${event}, ${actor}, ${JSON.stringify(meta)}::jsonb FROM u
    )${extra}
    SELECT id FROM u`))
  return rows.length > 0
}

const skipPending = (kinds: string[]) => sql`, sk AS (
    UPDATE appointment_notifications SET status = 'skipped' WHERE appointment_id IN (SELECT id FROM u) AND status = 'pending'
      AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}))`

export async function cancelAppointment(id: string, opts: { actor: string | null; by: 'customer' | 'staff'; reason?: string | null; now?: Date; cfg?: BookingConfig }): Promise<Appointment> {
  const appt = await getAppointment(id)
  if (!appt) throw new BookingError('not_found', 'Appointment not found.')
  if (appt.status === 'cancelled') return appt
  if (appt.status !== 'confirmed') throw new BookingError('conflict', 'Only a confirmed appointment can be cancelled.')
  if (opts.by === 'customer') {
    const cfg = opts.cfg ?? await getBookingConfig()
    const now = opts.now ?? new Date()
    if (appt.startsAt.getTime() - cfg.cancelCutoffMinutes * 60_000 < now.getTime()) {
      throw new BookingError('too_late', `It is too close to your drop-off time to cancel online. Please call ${cfg.phone}.`)
    }
  }
  const notice = appt.email
    ? sql`, nt AS (INSERT INTO appointment_notifications (appointment_id, kind, to_address, dedupe_key)
        SELECT id, 'cancellation', email, ${`${id}:cancellation`} FROM u WHERE email IS NOT NULL ON CONFLICT (dedupe_key) DO NOTHING)`
    : sql``
  await transition(id, ['confirmed'], sql`status = 'cancelled', cancelled_at = now()`, 'cancelled', opts.actor,
    { by: opts.by, reason: opts.reason ?? null }, sql`${skipPending(['reminder', 'confirmation', 'reschedule'])}${notice}`)
  return (await getAppointment(id))!
}

export async function markNoShow(id: string, actor: string | null, now = new Date()): Promise<Appointment> {
  const appt = await getAppointment(id)
  if (!appt) throw new BookingError('not_found', 'Appointment not found.')
  if (appt.status === 'no_show') return appt
  if (appt.status !== 'confirmed') throw new BookingError('conflict', 'Only a confirmed appointment can be marked no-show.')
  if (appt.startsAt.getTime() > now.getTime()) throw new BookingError('conflict', 'The drop-off time has not passed yet.')
  await transition(id, ['confirmed'], sql`status = 'no_show'`, 'no_show', actor, {}, skipPending(['reminder']))
  return (await getAppointment(id))!
}

/** What happened to the linked marketing lead when the estimate was declined. */
export type DeclineLeadOutcome =
  | 'lost'      // linked lead marked Lost — in the SAME statement as the decline, or not at all
  | 'none'      // no lead was ever linked — stated honestly, nothing claimed
  | 'already'   // retry: the appointment was already declined; the lead was NOT touched again

export interface DeclineResult { appointment: Appointment; lead: DeclineLeadOutcome }

/** The appointment-side decline conditions, with a clear error per refusal. Mirrors the SQL gate. */
function apptBlocksDecline(a: Appointment): void {
  if (a.serviceOrderId) throw new BookingError('conflict', 'This appointment already has a Work Board job — handle the estimate on the Job instead.')
  if (a.checkinStartedAt) throw new BookingError('conflict', 'A check-in was started for this appointment, so a Job may exist. Finish the check-in and handle the estimate on the Job.')
  if (a.status !== 'confirmed') throw new BookingError('conflict', `Only a confirmed appointment can be marked estimate-declined — this one is ${a.status.replace('_', '-')}.`)
}

/** The lead-side decline conditions. A dangling reference REFUSES: it must be fixed, never papered over. */
async function leadBlocksDecline(leadId: string): Promise<void> {
  const [lead] = rowsOf(await getDb().execute(sql`SELECT status, service_order_id FROM marketing_leads WHERE id = ${leadId}::uuid LIMIT 1`)) as { status: string; service_order_id: string | null }[]
  if (!lead) throw new BookingError('conflict', 'This appointment points at a marketing lead record that no longer exists — fix the lead link on the Marketing leads screen, then decline.')
  if (lead.status === 'won' || lead.service_order_id) throw new BookingError('conflict', 'The linked marketing lead is already Won or linked to a job — update it on the Marketing leads screen instead.')
}

/**
 * "Attended — estimate declined": the customer CAME to the drop-off, got an estimate, and said no.
 * Not a cancellation or a no-show, and never a check-in — no Job, no invoice, no customer email.
 *
 * FAIL-CLOSED ATOMICITY. One statement, consistent lock order (appointment, then lead):
 *   1. `appt` locks the appointment row FOR UPDATE with every eligibility condition in its WHERE;
 *   2. `lead` locks the linked lead row FOR UPDATE (not Won, not job-linked) — joined off the LOCKED
 *      appointment row's marketing_lead_id, never off the preflight read, so a re-linked lead can
 *      never cause the wrong row to be updated;
 *   3. both UPDATEs and both append-only audits run only when the appointment is locked AND its lead
 *      (when linked) is locked-and-eligible — so the decline and the lead's move to Lost commit
 *      together or nothing is written at all.
 * In READ COMMITTED, FOR UPDATE waits for a concurrent writer and re-evaluates its conditions on the
 * newest row version; a row that no longer qualifies drops out, the gate comes up empty, and the whole
 * statement writes nothing. The acquired locks are held to commit, so the later UPDATEs cannot be
 * raced after the gate passed. A lead that turns Won/job-linked concurrently, or a dangling lead
 * reference, therefore refuses the WHOLE decline and leaves the appointment confirmed.
 *
 * The preflight reads below exist only for clear error messages — they protect nothing; the statement
 * is the guard. The event's created_at is the recorded-at time; arrived_at is never fabricated.
 * Idempotent: a retry on an already-declined appointment returns 'already' with no second audit and no
 * lead write, so it can never clobber a lead a manager has since changed.
 */
export async function declineEstimate(id: string, opts: { actor: string | null; reason?: string | null }): Promise<DeclineResult> {
  const appt = await getAppointment(id)
  if (!appt) throw new BookingError('not_found', 'Appointment not found.')
  if (appt.status === 'declined') return { appointment: appt, lead: 'already' }
  apptBlocksDecline(appt)
  if (appt.marketingLeadId) await leadBlocksDecline(appt.marketingLeadId)
  const reason = (opts.reason ?? '').trim().slice(0, 300) || null

  const rows = rowsOf(await getDb().execute(sql`WITH appt AS MATERIALIZED (
      SELECT id, marketing_lead_id FROM appointments
      WHERE id = ${id}::uuid AND status = 'confirmed' AND service_order_id IS NULL AND checkin_started_at IS NULL
      FOR UPDATE
    ), lead AS MATERIALIZED (
      SELECT l.id FROM marketing_leads l JOIN appt ON l.id = appt.marketing_lead_id
      WHERE l.status <> 'won' AND l.service_order_id IS NULL
      FOR UPDATE OF l
    ), ok AS (
      SELECT appt.id, appt.marketing_lead_id FROM appt
      WHERE appt.marketing_lead_id IS NULL OR EXISTS (SELECT 1 FROM lead)
    ), u AS (
      UPDATE appointments a SET status = 'declined', updated_at = now()
      FROM ok WHERE a.id = ok.id
      RETURNING a.id, a.marketing_lead_id
    ), ld AS (
      UPDATE marketing_leads l SET status = 'lost', updated_at = now()
      FROM u WHERE l.id = u.marketing_lead_id
      RETURNING l.id
    ), ev AS (
      INSERT INTO appointment_events (appointment_id, event_type, actor, meta)
      SELECT u.id, 'estimate_declined', ${opts.actor}, jsonb_build_object(
        'reason', ${reason}::text, 'marketingLeadId', u.marketing_lead_id::text,
        'lead', CASE WHEN u.marketing_lead_id IS NULL THEN 'none' ELSE 'lost' END)
      FROM u
    ), mev AS (
      INSERT INTO marketing_events (event_type, entity_type, entity_id, actor, meta)
      SELECT 'lead_updated', 'lead', ld.id, ${opts.actor}, jsonb_build_object(
        'status', 'lost', 'reason', ${reason}::text,
        'appointmentId', ${id}::text, 'appointmentReference', ${appt.reference}::text,
        'via', 'appointment_estimate_declined')
      FROM ld
    )${skipPending(['reminder', 'confirmation', 'reschedule'])}
    SELECT u.id AS appt_id, u.marketing_lead_id AS lead_id FROM u`))

  if (rows.length && rows[0].appt_id) {
    return { appointment: (await getAppointment(id))!, lead: rows[0].lead_id ? 'lost' : 'none' }
  }
  // Refused — nothing was written. Diagnose against FRESH reads (the preflight is stale by definition):
  // a parallel decline that already landed is a harmless retry; everything else is a conflict.
  const again = await getAppointment(id)
  if (!again) throw new BookingError('not_found', 'Appointment not found.')
  if (again.status === 'declined') return { appointment: again, lead: 'already' }
  apptBlocksDecline(again)
  if (again.marketingLeadId) await leadBlocksDecline(again.marketingLeadId)
  throw new BookingError('conflict', 'This appointment changed while declining. Refresh and try again.')
}

export async function rescheduleAppointment(id: string, to: { date: string; time: string }, opts: { actor: string; override?: boolean; now?: Date; cfg?: BookingConfig }): Promise<Appointment> {
  const appt = await getAppointment(id)
  if (!appt) throw new BookingError('not_found', 'Appointment not found.')
  if (appt.status !== 'confirmed') throw new BookingError('conflict', 'Only a confirmed appointment can be rescheduled.')
  if (!isIsoDate(to.date) || !isHHMM(to.time)) throw new BookingError('invalid', 'Choose a valid date and time.')
  if (appt.localDate === to.date && appt.localTime === to.time) return appt
  const cfg = opts.cfg ?? await getBookingConfig()
  const now = opts.now ?? new Date()
  if (!opts.override) {
    const bad = validatePublicSlot({ ...cfg, sameDayLeadMinutes: 0 }, to.date, to.time, now, await activeBlocks(to.date, to.date))
    if (bad) throw new BookingError('closed', bad)
  }
  const need: Need = { detail: appt.unitsDetail, mechanic: appt.unitsMechanic }
  const startsAt = zonedToUtc(to.date, to.time, cfg.timezone)
  const reminderAt = new Date(startsAt.getTime() - cfg.reminderHoursBefore * 3_600_000)
  const notices: SQL[] = []
  if (appt.email) {
    notices.push(sql`(SELECT id FROM u), 'reschedule', ${appt.email}, ${`${id}:reschedule:${startsAt.toISOString()}`}, now()`)
    if (cfg.reminderEnabled && reminderAt.getTime() > now.getTime()) {
      notices.push(sql`(SELECT id FROM u), 'reminder', ${appt.email}, ${`${id}:reminder:${startsAt.toISOString()}`}, ${reminderAt.toISOString()}::timestamptz`)
    }
  }
  const noticeCte = notices.length
    ? sql`, nt AS (INSERT INTO appointment_notifications (appointment_id, kind, to_address, dedupe_key, send_after)
        SELECT * FROM (VALUES ${sql.join(notices.map((n) => sql`(${n})`), sql`, `)}) v(a, k, t, d, s) WHERE EXISTS (SELECT 1 FROM u)
        ON CONFLICT (dedupe_key) DO NOTHING)`
    : sql``
  const update = sql`WITH u AS (
      UPDATE appointments SET local_date = ${to.date}::date, local_time = ${to.time}, starts_at = ${startsAt.toISOString()}::timestamptz,
        capacity_override = capacity_override OR ${!!opts.override}, updated_at = now()
      WHERE id = ${id}::uuid AND status = 'confirmed'
        AND ${opts.override ? sql`true` : capacitySql(cfg, to.date, to.time, need, id)}
      RETURNING id
    ), ev AS (
      INSERT INTO appointment_events (appointment_id, event_type, actor, meta)
      SELECT id, 'rescheduled', ${opts.actor}, ${JSON.stringify({ from: { date: appt.localDate, time: appt.localTime }, to, override: !!opts.override })}::jsonb FROM u
    ), sk AS (
      UPDATE appointment_notifications SET status = 'skipped'
      WHERE appointment_id IN (SELECT id FROM u) AND status = 'pending' AND kind IN ('reminder', 'reschedule')
    )${noticeCte}
    SELECT id FROM u`
  const locks = [...new Set([appt.localDate, to.date])].sort().map(dayLock)
  const res = await runAtomic([...locks, update])
  if (!res[res.length - 1].length) throw new BookingError('full', 'That time is full. Pick another time or use manager override.')
  return (await getAppointment(id))!
}

export async function acknowledgeAppointments(ids: string[], actor: string): Promise<void> {
  const valid = ids.filter((x) => z.uuid().safeParse(x).success)
  if (!valid.length) return
  await getDb().update(appointments).set({ acknowledgedAt: new Date(), acknowledgedBy: actor })
    .where(and(inArray(appointments.id, valid), isNull(appointments.acknowledgedAt)))
}

export async function addInternalNote(id: string, note: string, actor: string): Promise<void> {
  const text = note.trim().slice(0, 1000)
  if (!text) return
  await transition(id, ['confirmed', 'arrived', 'cancelled', 'no_show', 'declined'],
    sql`internal_notes = trim(both from coalesce(internal_notes, '') || ${`\n${text}`})`, 'note_added', actor, { note: text })
}

// ── Blocks ────────────────────────────────────────────────────────────────────

export async function addBlock(input: { kind: 'close' | 'open'; date: string; time?: string | null; reason?: string | null }, actor: string): Promise<void> {
  if (!isIsoDate(input.date)) throw new BookingError('invalid', 'Choose a valid date.')
  if (input.time && !isHHMM(input.time)) throw new BookingError('invalid', 'Choose a valid time.')
  if (input.kind === 'open' && input.time) throw new BookingError('invalid', 'Re-open applies to a whole day.')
  await getDb().insert(appointmentBlocks).values({
    kind: input.kind, localDate: input.date, localTime: input.time || null, reason: (input.reason ?? '').trim().slice(0, 200) || null, createdBy: actor,
  })
}

export async function removeBlock(id: string, actor: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) return
  await getDb().update(appointmentBlocks).set({ removedAt: new Date(), removedBy: actor }).where(and(eq(appointmentBlocks.id, id), isNull(appointmentBlocks.removedAt)))
}

export async function listUpcomingBlocks(fromDate: string) {
  return getDb().select().from(appointmentBlocks).where(and(isNull(appointmentBlocks.removedAt), gte(appointmentBlocks.localDate, fromDate)))
    .orderBy(asc(appointmentBlocks.localDate), asc(appointmentBlocks.localTime))
}
