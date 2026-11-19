/**
 * Cancelled-appointment recovery ("Lead Recovery").
 *
 * WHAT IT IS: when a confirmed appointment is cancelled, the cancellation becomes a row in appointment_recoveries
 * (one per appointment, unique — a cancellation can never get a second sequence). Managers see it in the Lead
 * Recovery queue; when the owner has switched recovery emails on, up to three follow-up emails go out through the
 * EXISTING outbox and provider (appointment_notifications → dispatchDue → Postmark) as kinds recovery_1..3.
 *
 * WHAT IT IS NOT: a CRM, a second email system or a second queue. No new provider, no new dependency.
 *
 * SAFETY, in order of authority:
 *   1. booking_config.recoveryEmailsEnabled is the master switch (default OFF). While it is off nothing can be
 *      queued, and anything already queued is held back and the sequence paused.
 *   2. The send-time GATE (recoveryGate) re-checks everything on the CURRENT rows immediately before the provider
 *      call: sequence still active, customer has not opted out, has not booked again, link window still open. The
 *      stop functions also retire unsent emails in the same statement, but the gate is what makes a stop safe
 *      against an email that was already claimed.
 *   3. Pitt Stop-cancelled appointments are never enrolled automatically and can never be emailed by this module.
 *   4. A cancellation whose origin is unknown waits for a manager — it is never assumed to be the customer's choice.
 *
 * REVENUE: a later booking is credited to at most ONE cancellation (unique rebooked_appointment_id), and money only
 * counts once the new appointment's job is completed AND QuickBooks reports it paid. A booking is not revenue.
 *
 * ATTRIBUTION: recovery never writes marketing_attribution. The customer's original source stays on the original
 * lead; "recovery email" is recorded here (rebook_match) as a separate rebooking influence.
 */
import { sql, type SQL } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getDb } from '@/platform/db'
import { addDays, localParts, zonedToUtc, type BookingConfig, type BookingService } from './policy'
import { hashToken, isTokenShape, recoveryToken, recoveryUrl, publicBaseUrl } from './tokens'
import { isValidEmail } from './contact'
import { BookingError, getAppointment, getBookingConfig, type Appointment } from './db'
import { brandedHtml, isRecoveryKind } from './notify'

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : ((r as { rows?: Record<string, unknown>[] })?.rows ?? [])
const exec = async (q: SQL) => rowsOf(await getDb().execute(q))
const iso = (d: Date) => d.toISOString()
const uuid = (v: string) => z.uuid().safeParse(v).success

export const RECOVERY_KINDS = ['recovery_1', 'recovery_2', 'recovery_3'] as const
export type RecoveryStep = 1 | 2 | 3
export const recoveryStep = (kind: string): RecoveryStep => Number(kind.slice(-1)) as RecoveryStep
const KINDS_SQL = sql`('recovery_1', 'recovery_2', 'recovery_3')`

export type CancelOrigin = 'customer' | 'shop' | 'unknown'
export type RecoveryStatus = 'review' | 'active' | 'paused' | 'stopped' | 'rebooked' | 'finished'
export type StaffOutcome = 'contacted' | 'not_interested' | 'recovered'
export const STAFF_OUTCOMES: readonly StaffOutcome[] = ['contacted', 'not_interested', 'recovered']

/** Marker on emails held back by a pause, so Resume can tell them from emails retired for good. */
export const PAUSED_NOTE = 'Follow-ups paused'
export const REASONS = {
  unknownOrigin: 'It is not recorded who cancelled — confirm it was the customer before following up.',
  shopCancelled: 'Pitt Stop cancelled this appointment, so it is never followed up automatically.',
  noEmail: 'No valid email address — follow up by phone.',
  optedOut: 'The customer opted out of marketing email — no recovery emails will be sent.',
  noConsent: 'No email-marketing permission is on record for this customer — follow up by phone, or record their permission first.',
  noCustomer: 'No customer record is linked, so email preferences cannot be checked — follow up by phone.',
  emailsOff: 'Recovery emails are turned off in Booking settings.',
  manualStart: 'Waiting for a manager to start follow-ups.',
  otherAppointment: 'The customer already has another appointment.',
  rebooked: 'The customer booked again.',
  windowEnded: 'The recovery window ended.',
  undeliverable: 'The email address was rejected as undeliverable.',
  addedByManager: 'Added by a manager — follow-ups not started.',
  historical: 'Imported from before Lead Recovery existed — review before any follow-up.',
} as const

// ── Pure rules ────────────────────────────────────────────────────────────────

/** Who cancelled. Online cancels are the customer's. A staff cancel is only "customer" or "shop" when the staff
 *  member said so; otherwise it stays unknown and goes to review. */
export function cancelOrigin(by: unknown, initiator?: unknown): CancelOrigin {
  if (by === 'customer') return 'customer'
  return initiator === 'customer' ? 'customer' : initiator === 'shop' ? 'shop' : 'unknown'
}

export interface RecoveryFacts {
  appointmentStatus: string
  origin: CancelOrigin
  email: string | null
  hasCustomer: boolean
  optedOut: boolean
  /** An email-marketing opt-in is on record (booking-form checkbox, or permission a manager recorded) and not withdrawn. */
  emailConsent: boolean
  /** The same customer (email or phone) has another live appointment. */
  otherAppointment: boolean
  alreadyEnrolled: boolean
}
export type RecoveryVerdict =
  | { enroll: false; reason: string }
  /** `start` = the email sequence may begin now; otherwise the row waits in the queue for the stated reason. */
  | { enroll: true; start: boolean; reason: string | null }

/** Why this cancellation can never be emailed by this module, whatever the settings (null = it can). */
export function emailBlocker(f: Pick<RecoveryFacts, 'appointmentStatus' | 'origin' | 'email' | 'hasCustomer' | 'optedOut' | 'otherAppointment' | 'emailConsent'>): string | null {
  if (f.appointmentStatus !== 'cancelled') return 'This appointment is not cancelled.'
  if (f.origin === 'shop') return REASONS.shopCancelled
  if (f.otherAppointment) return REASONS.otherAppointment
  if (!f.email || !isValidEmail(f.email)) return REASONS.noEmail
  if (f.optedOut) return REASONS.optedOut
  if (!f.hasCustomer) return REASONS.noCustomer
  // Being a past customer is not permission: only a recorded opt-in makes someone eligible for recovery email.
  if (!f.emailConsent) return REASONS.noConsent
  return null
}

export function evaluateRecovery(f: RecoveryFacts, cfg: Pick<BookingConfig, 'recoveryEmailsEnabled' | 'recoveryAutoStart'>): RecoveryVerdict {
  if (f.alreadyEnrolled) return { enroll: false, reason: 'Already in the Lead Recovery queue.' }
  if (f.appointmentStatus !== 'cancelled') return { enroll: false, reason: 'This appointment is not cancelled.' }
  if (f.origin === 'shop') return { enroll: false, reason: REASONS.shopCancelled }
  if (f.otherAppointment) return { enroll: false, reason: REASONS.otherAppointment }
  // From here the cancellation is a recovery opportunity; the only question is whether email may start by itself.
  if (f.origin === 'unknown') return { enroll: true, start: false, reason: REASONS.unknownOrigin }
  const blocker = emailBlocker(f)
  if (blocker) return { enroll: true, start: false, reason: blocker }
  if (!cfg.recoveryEmailsEnabled) return { enroll: true, start: false, reason: REASONS.emailsOff }
  if (!cfg.recoveryAutoStart) return { enroll: true, start: false, reason: REASONS.manualStart }
  return { enroll: true, start: true, reason: null }
}

type WindowCfg = Pick<BookingConfig, 'timezone' | 'recoverySendStartHour' | 'recoverySendEndHour'>
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

/** The first moment at or after `at` that is inside the shop-local send window (no 11 PM follow-ups). */
export function nextSendTime(at: Date, cfg: WindowCfg): Date {
  const { date, minutes } = localParts(at, cfg.timezone)
  if (minutes < cfg.recoverySendStartHour * 60) return zonedToUtc(date, hh(cfg.recoverySendStartHour), cfg.timezone)
  if (minutes >= cfg.recoverySendEndHour * 60) return zonedToUtc(addDays(date, 1), hh(cfg.recoverySendStartHour), cfg.timezone)
  return at
}

/** When emails 1–3 become due, counted from `start` (the cancellation, or the moment a manager started it). */
export function recoverySchedule(start: Date, cfg: WindowCfg & Pick<BookingConfig, 'recoveryDelayHours'>): [Date, Date, Date] {
  const at = (h: number) => nextSendTime(new Date(start.getTime() + h * 3_600_000), cfg)
  return [at(cfg.recoveryDelayHours[0]), at(cfg.recoveryDelayHours[1]), at(cfg.recoveryDelayHours[2])]
}

/** Booking services with no single catalog item: the lowest real catalog price is shown as a "from" price. */
export const STARTING_PRICE_SLUGS: Record<string, string[]> = {
  ceramic_coating: ['ceramic_coating_1yr', 'ceramic_coating_3yr'],
  paint_correction: ['paint_correction_1step'],
}
export interface ValueEstimate {
  /** Sum of the prices that ARE known — a floor, never a guess. Null when no requested service has a catalog price. */
  minCents: number | null
  priced: { label: string; cents: number; from: boolean }[]
  unpriced: string[]
}
/** Estimated booking value from real catalog prices only. Size-tiered or unpriced services are listed, not guessed. */
export function estimateValue(serviceKeys: string[], services: Pick<BookingService, 'key' | 'label' | 'catalogSlug'>[], prices: Map<string, number | null>): ValueEstimate {
  const out: ValueEstimate = { minCents: null, priced: [], unpriced: [] }
  for (const key of serviceKeys) {
    const svc = services.find((s) => s.key === key)
    const label = svc?.label ?? key
    const slugs = svc?.catalogSlug ? [svc.catalogSlug] : STARTING_PRICE_SLUGS[key] ?? []
    const known = slugs.map((s) => prices.get(s)).filter((c): c is number => typeof c === 'number' && c > 0)
    if (!known.length) { out.unpriced.push(label); continue }
    out.priced.push({ label, cents: Math.min(...known), from: !svc?.catalogSlug })
  }
  if (out.priced.length) out.minCents = out.priced.reduce((s, p) => s + p.cents, 0)
  return out
}

const TIERS: Record<string, number> = { ceramic_coating: 3, paint_correction: 3, premium_detail: 2, complete_detail: 2 }
/** Higher = worked first. Ceramic coating and paint correction lead, then the larger detail packages. */
export const priorityTier = (serviceKeys: string[]): number => Math.max(1, ...serviceKeys.map((k) => TIERS[k] ?? 1))

// ── Email copy (owner wording, 2026-11-19) ────────────────────────────────────

const SHOP = 'Pitt Stop Detail & Auto Sales'
type CopyAppt = Pick<Appointment, 'firstName' | 'vehicleYear' | 'vehicleMake' | 'vehicleModel' | 'serviceLabels'>
const vehicleOf = (a: CopyAppt) => [a.vehicleYear, a.vehicleMake === 'Trailer' ? null : a.vehicleMake, a.vehicleModel].filter(Boolean).join(' ')

export interface RecoveryEmail { subject: string; text: string; html: string; headers: { name: string; value: string }[] }

/** Cancelled this soon after booking, the customer most likely hit a snag or changed their mind on the spot. */
export const QUICK_CANCEL_MINUTES = 5
export function isQuickCancel(a: { createdAt: Date | string; cancelledAt: Date | string | null }): boolean {
  if (!a.cancelledAt) return false
  const gap = new Date(a.cancelledAt).getTime() - new Date(a.createdAt).getTime()
  return gap >= 0 && gap <= QUICK_CANCEL_MINUTES * 60_000
}

/** `quick` = cancelled within QUICK_CANCEL_MINUTES of booking: email 1 offers help with the booking instead of a reschedule. */
export function renderRecoveryEmail(step: RecoveryStep, a: CopyAppt, cfg: Pick<BookingConfig, 'phone' | 'address'>, links: { rebook: string; unsubscribe: string | null }, opts: { quick?: boolean } = {}): RecoveryEmail {
  const vehicle = vehicleOf(a)
  const yourVehicle = vehicle ? `your ${vehicle}` : 'your vehicle'
  const hi = a.firstName ? `Hi ${a.firstName},` : 'Hi,'
  const copy = step === 1 && opts.quick ? {
    subject: 'Need a hand with your booking?',
    lines: [`We saw that your appointment for ${yourVehicle} was canceled shortly after you booked it.`,
      `If something didn’t look right, or you have a question about the service, timing or pricing, we’re glad to help — just reply to this email or call us at ${cfg.phone}.`,
      'If you’d simply like a different time, you can pick one here:'],
    heading: 'Need a hand with your booking?', button: 'Pick a time',
  } : step === 1 ? {
    subject: 'Need to reschedule your appointment?',
    lines: [`We noticed your appointment for ${yourVehicle} was canceled.`, 'If the timing didn’t work out, we’d be happy to help you find another day.', 'You can reschedule here:'],
    heading: 'Need to reschedule?', button: 'Reschedule',
  } : step === 2 ? {
    subject: `Still interested in getting ${yourVehicle} taken care of?`,
    lines: [`Just following up about the ${a.serviceLabels || 'service'} you had scheduled for ${yourVehicle}.`, 'If you’re still interested, we’d be happy to get you back on the schedule.'],
    heading: 'Still interested?', button: 'Reschedule',
  } : {
    subject: 'We’re here whenever you’re ready',
    lines: ['Just wanted to reach out one last time about your canceled appointment.', `Whenever you’re ready to get ${yourVehicle} taken care of, we’d be happy to help.`],
    heading: 'We’re here whenever you’re ready', button: 'Book a time',
  }
  // Required sender identification + a working opt-out on every recovery email.
  const why = 'You’re receiving this because you booked an appointment with us.'
  const footer = [SHOP, cfg.address, cfg.phone].filter(Boolean).join(' · ')
  const text = [
    hi, ...copy.lines, links.rebook, `Thanks,\n${SHOP}`,
    `—\n${footer}\n${why}${links.unsubscribe ? `\nUnsubscribe from marketing email: ${links.unsubscribe}` : ''}`,
  ].join('\n\n')
  const html = brandedHtml({
    preheader: copy.lines[0], heading: copy.heading, intro: `${hi} ${copy.lines[0]}`,
    note: copy.lines.slice(1).filter((l) => !l.endsWith(':')).join(' '),
    button: { label: copy.button, href: links.rebook }, footnote: why,
    footerLink: links.unsubscribe ? { label: 'Unsubscribe from marketing email', href: links.unsubscribe } : undefined, cfg,
  })
  return { subject: copy.subject, text, html, headers: links.unsubscribe ? [{ name: 'List-Unsubscribe', value: `<${links.unsubscribe}>` }] : [] }
}

/** The customer-facing opt-out link: the EXISTING marketing unsubscribe page, keyed by the customer's own token. */
export async function unsubscribeUrlFor(customerId: string | null): Promise<string | null> {
  if (!customerId || !uuid(customerId)) return null
  const [row] = await exec(sql`INSERT INTO marketing_preferences (customer_id) VALUES (${customerId}::uuid)
    ON CONFLICT (customer_id) DO UPDATE SET updated_at = marketing_preferences.updated_at RETURNING unsubscribe_token`)
  return row?.unsubscribe_token ? `${publicBaseUrl()}/unsubscribe/${String(row.unsubscribe_token)}` : null
}

/** Render one recovery email for a real cancellation — used by the dispatcher AND the staff preview. Sends nothing. */
export async function buildRecoveryEmail(step: RecoveryStep, appt: Appointment, recoveryId: string, cfg: BookingConfig): Promise<RecoveryEmail> {
  return renderRecoveryEmail(step, appt, cfg, { rebook: recoveryUrl(recoveryId), unsubscribe: await unsubscribeUrlFor(appt.customerId) }, { quick: isQuickCancel(appt) })
}

// ── Facts ─────────────────────────────────────────────────────────────────────

export interface RecoveryRow {
  id: string; appointmentId: string; origin: CancelOrigin; status: RecoveryStatus; reason: string | null
  cancelledAt: Date; sequenceStartedAt: Date | null; lastContactAt: Date | null
  staffOutcome: StaffOutcome | null; rebookedAppointmentId: string | null; rebookMatch: string | null; rebookReview: string | null
}
const dt = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)))
const toRow = (r: Record<string, unknown>): RecoveryRow => ({
  id: String(r.id), appointmentId: String(r.appointment_id), origin: r.origin as CancelOrigin, status: r.status as RecoveryStatus,
  reason: (r.reason as string | null) ?? null, cancelledAt: dt(r.cancelled_at)!, sequenceStartedAt: dt(r.sequence_started_at),
  lastContactAt: dt(r.last_contact_at), staffOutcome: (r.staff_outcome as StaffOutcome | null) ?? null,
  rebookedAppointmentId: (r.rebooked_appointment_id as string | null) ?? null, rebookMatch: (r.rebook_match as string | null) ?? null,
  rebookReview: (r.rebook_review as string | null) ?? null,
})

export async function getRecovery(id: string): Promise<RecoveryRow | null> {
  if (!uuid(id)) return null
  const [r] = await exec(sql`SELECT * FROM appointment_recoveries WHERE id = ${id}::uuid`)
  return r ? toRow(r) : null
}
export async function getRecoveryForAppointment(appointmentId: string): Promise<RecoveryRow | null> {
  if (!uuid(appointmentId)) return null
  const [r] = await exec(sql`SELECT * FROM appointment_recoveries WHERE appointment_id = ${appointmentId}::uuid`)
  return r ? toRow(r) : null
}
export async function getRecoveryByToken(token: string): Promise<RecoveryRow | null> {
  if (!isTokenShape(token)) return null
  const [r] = await exec(sql`SELECT * FROM appointment_recoveries WHERE token_hash = ${hashToken(token)}`)
  return r ? toRow(r) : null
}

/** The customer's private link (and credit for a later booking) lasts recoveryLinkDays from the cancellation. */
export function recoveryWindowOpen(rec: Pick<RecoveryRow, 'cancelledAt'>, cfg: Pick<BookingConfig, 'recoveryLinkDays'>, now: Date = new Date()): boolean {
  return now.getTime() <= rec.cancelledAt.getTime() + cfg.recoveryLinkDays * 86_400_000
}

/** Opted out of marketing email — on the linked customer OR any customer record sharing the address. */
export async function emailOptedOut(appt: Pick<Appointment, 'customerId' | 'email'>): Promise<boolean> {
  const email = (appt.email ?? '').trim().toLowerCase()
  const [r] = await exec(sql`SELECT EXISTS (
      SELECT 1 FROM marketing_preferences p JOIN customers c ON c.id = p.customer_id
      WHERE (c.id = ${appt.customerId}::uuid OR (${email} <> '' AND c.normalized_email = ${email}))
        AND (p.email_eligible = false OR (p.unsubscribed_at IS NOT NULL AND p.unsubscribe_scope <> 'sms'))
    ) AS out`)
  return r?.out === true
}

const customerMatch = (appt: Pick<Appointment, 'customerId' | 'email'>) => {
  const email = (appt.email ?? '').trim().toLowerCase()
  return sql`(c.id = ${appt.customerId}::uuid OR (${email} <> '' AND c.normalized_email = ${email}))`
}

/**
 * Is an email-marketing opt-in on record and still standing? The LATEST email consent event for the customer (or
 * any customer record sharing the address) must be an opt-in. Past business alone never counts.
 */
export async function hasEmailConsent(appt: Pick<Appointment, 'customerId' | 'email'>): Promise<boolean> {
  const [r] = await exec(sql`SELECT e.event FROM marketing_consent_events e JOIN customers c ON c.id = e.customer_id
    WHERE e.channel = 'email' AND e.event IN ('opt_in', 'opt_out') AND ${customerMatch(appt)} ORDER BY e.created_at DESC, e.id DESC LIMIT 1`)
  return r?.event === 'opt_in'
}

/**
 * A manager records that the customer gave permission for follow-up email (in person or by phone). Appended to the
 * same consent trail as the booking-form checkbox, with who recorded it and when — never inferred, never bulk.
 */
export async function recordManagerEmailConsent(recoveryId: string, actor: string): Promise<void> {
  const rec = await getRecovery(recoveryId)
  const appt = rec ? await getAppointment(rec.appointmentId) : null
  if (!rec || !appt) throw new BookingError('not_found', 'Recovery record not found.')
  if (!appt.customerId) throw new BookingError('conflict', REASONS.noCustomer)
  if (await emailOptedOut(appt)) throw new BookingError('conflict', 'This customer unsubscribed. Their permission can’t be recorded here.')
  await exec(sql`INSERT INTO marketing_consent_events (customer_id, channel, event, source, wording_version, consent_text, actor, meta)
    VALUES (${appt.customerId}::uuid, 'email', 'opt_in', 'manager', 'manager-recorded-v1', 'Customer told staff they agree to follow-up email from Pitt Stop.', ${actor},
      ${JSON.stringify({ recoveryId, appointmentId: appt.id })}::jsonb)`)
  // The review note is refreshed so the queue stops saying permission is missing.
  await exec(sql`UPDATE appointment_recoveries SET reason = CASE WHEN reason = ${REASONS.noConsent} THEN ${REASONS.manualStart} ELSE reason END, updated_at = now() WHERE id = ${recoveryId}::uuid`)
  await logEvent(recoveryId, 'email_consent_recorded', actor, {})
}

/** Does the same customer (email or phone) hold another live appointment — still confirmed, or made after this cancellation? */
async function hasOtherAppointment(appt: Appointment): Promise<boolean> {
  const email = (appt.email ?? '').trim().toLowerCase()
  const phone = appt.normalizedPhone ?? ''
  const since = iso(appt.cancelledAt ?? appt.updatedAt)
  const [r] = await exec(sql`SELECT EXISTS (
      SELECT 1 FROM appointments b WHERE b.id <> ${appt.id}::uuid
        AND ((${email} <> '' AND lower(b.email) = ${email}) OR (${phone} <> '' AND b.normalized_phone = ${phone}))
        AND (b.status = 'confirmed' OR (b.created_at > ${since}::timestamptz AND b.status <> 'cancelled'))
    ) AS other`)
  return r?.other === true
}

export async function recoveryFacts(appt: Appointment, origin: CancelOrigin): Promise<RecoveryFacts> {
  const [existing, optedOut, otherAppointment, emailConsent] = await Promise.all([getRecoveryForAppointment(appt.id), emailOptedOut(appt), hasOtherAppointment(appt), hasEmailConsent(appt)])
  return { appointmentStatus: appt.status, origin, email: appt.email, hasCustomer: !!appt.customerId, optedOut, emailConsent, otherAppointment, alreadyEnrolled: !!existing }
}

/** Who cancelled, from the append-only history (used for cancellations made before this module existed). */
export async function recordedOrigin(appointmentId: string): Promise<{ origin: CancelOrigin; reason: string | null }> {
  const [e] = await exec(sql`SELECT meta FROM appointment_events WHERE appointment_id = ${appointmentId}::uuid AND event_type = 'cancelled' ORDER BY created_at DESC LIMIT 1`)
  const meta = (e?.meta ?? {}) as { by?: unknown; initiator?: unknown; reason?: unknown }
  return { origin: e ? cancelOrigin(meta.by, meta.initiator) : 'unknown', reason: typeof meta.reason === 'string' && meta.reason ? meta.reason : null }
}

const logEvent = (recoveryId: string, eventType: string, actor: string | null, meta: Record<string, unknown> = {}) =>
  exec(sql`INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta) VALUES (${recoveryId}::uuid, ${eventType}, ${actor}, ${JSON.stringify(meta)}::jsonb)`)

// ── Enrolment ─────────────────────────────────────────────────────────────────

export interface EnrollResult { recoveryId: string | null; verdict: RecoveryVerdict; started: boolean }

/**
 * Put one cancellation in the queue. Called right after a cancel commits (best-effort — a problem here never
 * undoes or blocks the cancellation), and by the manager "Add to queue" action for older cancellations.
 * Idempotent: the unique appointment_id means a retry or a double-tap returns the existing row untouched.
 * `manual` never starts emails by itself — a manager-added row always waits for an explicit start.
 */
export async function enrollCancellation(appt: Appointment, origin: CancelOrigin, opts: {
  actor?: string | null; manual?: boolean; now?: Date; cfg?: BookingConfig
  /** One-off import of cancellations made before this feature (scripts/recovery-backfill.ts): always lands in the
   *  manager review queue, never starts emails, and is recorded as an import. */
  historical?: boolean
} = {}): Promise<EnrollResult> {
  const cfg = opts.cfg ?? await getBookingConfig()
  const facts = await recoveryFacts(appt, origin)
  let verdict = evaluateRecovery(facts, cfg)
  if (opts.historical && !facts.alreadyEnrolled && facts.appointmentStatus === 'cancelled' && facts.origin !== 'shop') {
    verdict = { enroll: true, start: false, reason: `${REASONS.historical}${verdict.reason && verdict.reason !== REASONS.emailsOff && verdict.reason !== REASONS.manualStart ? ` ${verdict.reason}` : ''}` }
  }
  if (opts.manual) {
    // A manager may queue a Pitt Stop-cancelled appointment for a PERSONAL follow-up; it still can never be emailed.
    if (!verdict.enroll && facts.origin === 'shop' && !facts.alreadyEnrolled && !facts.otherAppointment && facts.appointmentStatus === 'cancelled') {
      verdict = { enroll: true, start: false, reason: REASONS.shopCancelled }
    } else if (verdict.enroll && verdict.start) {
      verdict = { enroll: true, start: false, reason: REASONS.addedByManager }
    }
  }
  if (!verdict.enroll) return { recoveryId: null, verdict, started: false }

  const id = randomUUID()
  const actor = opts.actor ?? 'system'
  const cancelledAt = appt.cancelledAt ?? opts.now ?? new Date()
  const rows = await exec(sql`WITH ins AS (
      INSERT INTO appointment_recoveries (id, appointment_id, token_hash, origin, status, reason, cancelled_at, enrolled_by)
      VALUES (${id}::uuid, ${appt.id}::uuid, ${hashToken(recoveryToken(id))}, ${origin}, 'review', ${verdict.reason}, ${iso(cancelledAt)}::timestamptz, ${actor})
      ON CONFLICT (appointment_id) DO NOTHING RETURNING id
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta)
      SELECT id, 'enrolled', ${actor}, ${JSON.stringify({ origin, reason: verdict.reason, manual: !!opts.manual, ...(opts.historical ? { historical: true } : {}) })}::jsonb FROM ins
    ) SELECT id FROM ins`)
  if (!rows.length) return { recoveryId: (await getRecoveryForAppointment(appt.id))?.id ?? null, verdict: { enroll: false, reason: 'Already in the Lead Recovery queue.' }, started: false }
  if (!verdict.start) return { recoveryId: id, verdict, started: false }
  await startSequence(id, 'system', { now: opts.now, cfg, from: cancelledAt })
  return { recoveryId: id, verdict, started: true }
}

/** Manager "Add to queue" for a cancellation that is not enrolled (older cancellations are never enrolled in bulk). */
export async function enrollManually(appointmentId: string, actor: string): Promise<EnrollResult> {
  const appt = await getAppointment(appointmentId)
  if (!appt) throw new BookingError('not_found', 'Appointment not found.')
  if (appt.status !== 'cancelled') throw new BookingError('conflict', 'Only a cancelled appointment can be added to Lead Recovery.')
  const { origin } = await recordedOrigin(appt.id)
  const res = await enrollCancellation(appt, origin, { actor, manual: true })
  if (!res.recoveryId) throw new BookingError('conflict', res.verdict.reason ?? 'This cancellation can’t be added.')
  return res
}

// ── Sequence control (each ONE statement: state + unsent emails + append-only event) ──

/**
 * Start the three-email sequence. Refuses unless the master switch is on and nothing blocks email for this
 * customer. The three outbox rows are written in the same statement as the status change, keyed
 * `<appointment>:recovery_N` under the outbox's unique dedupe_key — so however many times this runs, each of
 * the three emails can exist at most once.
 */
export async function startSequence(recoveryId: string, actor: string, opts: { now?: Date; cfg?: BookingConfig; from?: Date } = {}): Promise<void> {
  const cfg = opts.cfg ?? await getBookingConfig()
  if (!cfg.recoveryEmailsEnabled) throw new BookingError('conflict', REASONS.emailsOff)
  const rec = await getRecovery(recoveryId)
  if (!rec) throw new BookingError('not_found', 'Recovery record not found.')
  if (rec.status !== 'review') throw new BookingError('conflict', rec.status === 'active' ? 'Follow-ups are already running.' : `Follow-ups can’t be started — this one is ${rec.status}.`)
  const appt = await getAppointment(rec.appointmentId)
  if (!appt) throw new BookingError('not_found', 'Appointment not found.')
  const facts = await recoveryFacts(appt, rec.origin)
  const blocker = emailBlocker(facts)
  if (blocker) throw new BookingError('conflict', blocker)

  const now = opts.now ?? new Date()
  const start = opts.from ?? now
  const [t1, t2, t3] = recoverySchedule(start, cfg)
  const rows = await exec(sql`WITH r AS (
      UPDATE appointment_recoveries SET status = 'active', reason = NULL, sequence_started_at = ${iso(now)}::timestamptz, started_by = ${actor}, updated_at = now()
      WHERE id = ${recoveryId}::uuid AND status = 'review' AND origin <> 'shop' RETURNING id, appointment_id
    ), a AS (
      SELECT ap.id, lower(ap.email) AS email FROM appointments ap JOIN r ON ap.id = r.appointment_id WHERE ap.email IS NOT NULL AND ap.status = 'cancelled'
    ), nt AS (
      INSERT INTO appointment_notifications (appointment_id, kind, to_address, dedupe_key, send_after)
      SELECT a.id, v.k, a.email, a.id::text || ':' || v.k, v.s
      FROM a CROSS JOIN (VALUES ('recovery_1', ${iso(t1)}::timestamptz), ('recovery_2', ${iso(t2)}::timestamptz), ('recovery_3', ${iso(t3)}::timestamptz)) v(k, s)
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta)
      SELECT id, 'sequence_started', ${actor}, ${JSON.stringify({ sendAt: [iso(t1), iso(t2), iso(t3)] })}::jsonb FROM r
    ) SELECT id FROM r`)
  if (!rows.length) throw new BookingError('conflict', 'This recovery changed while starting. Refresh and try again.')
}

/** Retire every recovery email that has not been sent, in the same statement as the status change. */
const retireUnsent = (from: SQL, note: string) => sql`, sk AS (
    UPDATE appointment_notifications SET status = 'skipped', error = ${note}
    WHERE appointment_id IN (SELECT appointment_id FROM ${from}) AND status = 'pending' AND kind IN ${KINDS_SQL})`

async function moveTo(recoveryId: string, from: RecoveryStatus[], to: RecoveryStatus, opts: { actor: string | null; reason: string | null; event: string; note: string; outcome?: StaffOutcome; meta?: Record<string, unknown> }): Promise<boolean> {
  if (!uuid(recoveryId)) return false
  const outcome = opts.outcome ? sql`, staff_outcome = ${opts.outcome}, staff_outcome_by = ${opts.actor}, staff_outcome_at = now()` : sql``
  const rows = await exec(sql`WITH r AS (
      UPDATE appointment_recoveries SET status = ${to}, reason = ${opts.reason}, updated_at = now()${outcome}
      WHERE id = ${recoveryId}::uuid AND status IN (${sql.join(from.map((f) => sql`${f}`), sql`, `)}) RETURNING id, appointment_id
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta)
      SELECT id, ${opts.event}, ${opts.actor}, ${JSON.stringify({ reason: opts.reason, ...(opts.meta ?? {}) })}::jsonb FROM r
    )${retireUnsent(sql`r`, opts.note)}
    SELECT id FROM r`)
  return rows.length > 0
}

const OPEN: RecoveryStatus[] = ['review', 'active', 'paused', 'finished']

/** Hold the sequence. Unsent emails are held back (marked, so Resume can release exactly those). */
export async function pauseSequence(recoveryId: string, actor: string | null, reason: string = 'Paused by staff.'): Promise<boolean> {
  return moveTo(recoveryId, ['active'], 'paused', { actor, reason, event: 'paused', note: PAUSED_NOTE })
}

/** Stop for good: no further emails for this cancellation, ever. */
export async function stopSequence(recoveryId: string, actor: string | null, reason: string, outcome?: StaffOutcome): Promise<boolean> {
  return moveTo(recoveryId, OPEN, 'stopped', { actor, reason, event: 'stopped', note: reason, outcome })
}

/** Release a paused sequence: the held emails are re-timed from now, keeping the gaps between them. */
export async function resumeSequence(recoveryId: string, actor: string, opts: { now?: Date; cfg?: BookingConfig } = {}): Promise<void> {
  const cfg = opts.cfg ?? await getBookingConfig()
  if (!cfg.recoveryEmailsEnabled) throw new BookingError('conflict', REASONS.emailsOff)
  const rec = await getRecovery(recoveryId)
  if (!rec) throw new BookingError('not_found', 'Recovery record not found.')
  if (rec.status !== 'paused') throw new BookingError('conflict', 'Only paused follow-ups can be resumed.')
  const appt = await getAppointment(rec.appointmentId)
  const blocker = appt ? emailBlocker(await recoveryFacts(appt, rec.origin)) : 'Appointment not found.'
  if (blocker) throw new BookingError('conflict', blocker)
  const now = opts.now ?? new Date()
  const held = await exec(sql`SELECT kind FROM appointment_notifications WHERE appointment_id = ${rec.appointmentId}::uuid
    AND kind IN ${KINDS_SQL} AND status = 'skipped' AND error = ${PAUSED_NOTE} ORDER BY kind`)
  const steps = held.map((h) => recoveryStep(String(h.kind)))
  const base = steps.length ? cfg.recoveryDelayHours[steps[0] - 1] : 0
  const times = steps.map((s) => nextSendTime(new Date(now.getTime() + (cfg.recoveryDelayHours[s - 1] - base) * 3_600_000), cfg))
  const retime = steps.length
    ? sql`, nt AS (UPDATE appointment_notifications n SET status = 'pending', error = NULL, send_after = v.s
        FROM (VALUES ${sql.join(steps.map((s, i) => sql`(${`recovery_${s}`}, ${iso(times[i])}::timestamptz)`), sql`, `)}) v(k, s)
        WHERE n.appointment_id IN (SELECT appointment_id FROM r) AND n.kind = v.k AND n.status = 'skipped' AND n.error = ${PAUSED_NOTE})`
    : sql``
  const rows = await exec(sql`WITH r AS (
      UPDATE appointment_recoveries SET status = ${steps.length ? 'active' : 'finished'}, reason = NULL, updated_at = now()
      WHERE id = ${recoveryId}::uuid AND status = 'paused' RETURNING id, appointment_id
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta)
      SELECT id, 'resumed', ${actor}, ${JSON.stringify({ sendAt: times.map(iso) })}::jsonb FROM r
    )${retime}
    SELECT id FROM r`)
  if (!rows.length) throw new BookingError('conflict', 'This recovery changed while resuming. Refresh and try again.')
}

/**
 * Staff outcome. "Contacted" is a note (it does not stop the emails); "Not interested" and "Recovered" resolve the
 * lead and stop the sequence in the same statement. "Recovered" here is the staff's word — money is only ever
 * counted from a linked, completed, paid job.
 */
export async function setStaffOutcome(recoveryId: string, outcome: StaffOutcome, actor: string): Promise<void> {
  if (!STAFF_OUTCOMES.includes(outcome)) throw new BookingError('invalid', 'Choose a valid outcome.')
  if (outcome === 'contacted') {
    if (!uuid(recoveryId)) throw new BookingError('not_found', 'Recovery record not found.')
    const rows = await exec(sql`WITH r AS (
        UPDATE appointment_recoveries SET staff_outcome = 'contacted', staff_outcome_by = ${actor}, staff_outcome_at = now(), last_contact_at = now(), updated_at = now()
        WHERE id = ${recoveryId}::uuid AND status <> 'rebooked' RETURNING id
      ), ev AS (
        INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta) SELECT id, 'staff_outcome', ${actor}, '{"outcome":"contacted"}'::jsonb FROM r
      ) SELECT id FROM r`)
    if (!rows.length) throw new BookingError('conflict', 'This lead is already rebooked.')
    return
  }
  const reason = outcome === 'not_interested' ? 'Marked not interested by staff.' : 'Marked recovered by staff.'
  const ok = await moveTo(recoveryId, [...OPEN, 'stopped'], 'stopped', { actor, reason, event: 'staff_outcome', note: reason, outcome, meta: { outcome } })
  if (!ok) throw new BookingError('conflict', 'This lead can’t be changed (it may already be rebooked).')
}

/**
 * Manager "Send next email now": makes the next unsent recovery email due immediately (starting the sequence
 * first when it has not started). It still passes through the same gate as an automatic send — a manual send
 * can never reach someone who opted out or has booked again. Returns the appointment to dispatch.
 */
export async function sendNextNow(recoveryId: string, actor: string, opts: { now?: Date; cfg?: BookingConfig } = {}): Promise<{ appointmentId: string; kind: string }> {
  const cfg = opts.cfg ?? await getBookingConfig()
  if (!cfg.recoveryEmailsEnabled) throw new BookingError('conflict', REASONS.emailsOff)
  let rec = await getRecovery(recoveryId)
  if (!rec) throw new BookingError('not_found', 'Recovery record not found.')
  if (rec.status === 'review') { await startSequence(recoveryId, actor, opts); rec = (await getRecovery(recoveryId))! }
  if (rec.status !== 'active') throw new BookingError('conflict', `No email can be sent — this lead is ${rec.status}.`)
  const now = opts.now ?? new Date()
  const rows = await exec(sql`WITH nxt AS (
      SELECT id, kind FROM appointment_notifications WHERE appointment_id = ${rec.appointmentId}::uuid AND kind IN ${KINDS_SQL} AND status = 'pending'
      ORDER BY kind LIMIT 1
    ), u AS (
      UPDATE appointment_notifications n SET send_after = ${iso(now)}::timestamptz FROM nxt WHERE n.id = nxt.id AND n.status = 'pending' RETURNING n.kind
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta) SELECT ${recoveryId}::uuid, 'manual_send', ${actor}, jsonb_build_object('kind', kind) FROM u
    ) SELECT kind FROM u`)
  if (!rows.length) throw new BookingError('conflict', 'There is no unsent recovery email left for this lead.')
  return { appointmentId: rec.appointmentId, kind: String(rows[0].kind) }
}

// ── Rebooking ─────────────────────────────────────────────────────────────────

/**
 * Credit a new appointment to a cancellation with CERTAINTY: the customer used their private recovery link
 * ('link'), or staff rebooked them from the queue ('staff'). Stops the sequence and retires unsent emails in the
 * same statement. One booking credits at most one cancellation (unique index), and one cancellation is credited
 * at most once — so recovered revenue can never be counted twice.
 */
export async function linkRebooking(input: { token?: string; recoveryId?: string; newAppointmentId: string; match: 'link' | 'staff'; actor?: string | null }): Promise<string | null> {
  const key = input.token && isTokenShape(input.token) ? sql`r.token_hash = ${hashToken(input.token)}`
    : input.recoveryId && uuid(input.recoveryId) ? sql`r.id = ${input.recoveryId}::uuid` : null
  if (!key || !uuid(input.newAppointmentId)) return null
  const rows = await exec(sql`WITH r AS (
      UPDATE appointment_recoveries r SET status = 'rebooked', reason = NULL, rebooked_appointment_id = n.id, rebook_match = ${input.match}, rebook_review = NULL,
        rebook_same_vehicle = ${sameVehicle}, rebooked_at = now(), updated_at = now()
      FROM appointments n, appointments a
      WHERE ${key} AND a.id = r.appointment_id AND n.id = ${input.newAppointmentId}::uuid AND n.id <> a.id AND n.status <> 'cancelled'
        AND r.rebooked_appointment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM appointment_recoveries x WHERE x.rebooked_appointment_id = n.id)
      RETURNING r.id, r.appointment_id
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta)
      SELECT id, 'rebooked', ${input.actor ?? 'customer'}, ${JSON.stringify({ match: input.match, appointmentId: input.newAppointmentId })}::jsonb FROM r
    )${retireUnsent(sql`r`, REASONS.rebooked)}
    SELECT id FROM r`)
  return rows.length ? String(rows[0].id) : null
}

const sameVehicle = sql`(coalesce(n.vehicle_year, '') = coalesce(a.vehicle_year, '') AND lower(coalesce(n.vehicle_make, '')) = lower(coalesce(a.vehicle_make, ''))
  AND lower(coalesce(n.vehicle_model, '')) = lower(coalesce(a.vehicle_model, '')) AND coalesce(a.vehicle_model, '') <> '')`

/**
 * Find later bookings by the same customer (email or phone) that did NOT come through a recovery link. The
 * customer has booked again, so the sequence stops at once — but whether the recovery emails had anything to do
 * with it is not known, so the match is recorded as 'contact' / review 'pending' and counts toward recovered
 * results only after a manager confirms it. Each booking is offered to its most recent cancellation only.
 */
export async function detectRebookings(opts: { appointmentId?: string; cfg?: BookingConfig } = {}): Promise<number> {
  const cfg = opts.cfg ?? await getBookingConfig()
  const scope = opts.appointmentId && uuid(opts.appointmentId) ? sql`AND r.appointment_id = ${opts.appointmentId}::uuid` : sql``
  const rows = await exec(sql`WITH cand AS (
      SELECT DISTINCT ON (n.id) r.id AS rid, n.id AS nid, n.created_at AS n_created, ${sameVehicle} AS same_vehicle
      FROM appointment_recoveries r
      JOIN appointments a ON a.id = r.appointment_id
      JOIN appointments n ON n.id <> a.id AND n.status <> 'cancelled' AND n.created_at > r.cancelled_at
        AND n.created_at <= r.cancelled_at + make_interval(days => ${cfg.recoveryLinkDays})
        AND ((a.email IS NOT NULL AND a.email <> '' AND lower(n.email) = lower(a.email))
          OR (coalesce(a.normalized_phone, '') <> '' AND n.normalized_phone = a.normalized_phone))
      WHERE r.status IN ('review', 'active', 'paused', 'finished') AND r.rebooked_appointment_id IS NULL ${scope}
        AND NOT EXISTS (SELECT 1 FROM appointment_recoveries x WHERE x.rebooked_appointment_id = n.id)
      ORDER BY n.id, r.cancelled_at DESC
    ), pick AS (
      SELECT DISTINCT ON (rid) rid, nid, same_vehicle FROM cand ORDER BY rid, n_created
    ), r AS (
      UPDATE appointment_recoveries r SET status = 'rebooked', reason = NULL, rebooked_appointment_id = pick.nid, rebook_match = 'contact', rebook_review = 'pending',
        rebook_same_vehicle = pick.same_vehicle, rebooked_at = now(), updated_at = now()
      FROM pick WHERE r.id = pick.rid AND r.rebooked_appointment_id IS NULL
      RETURNING r.id, r.appointment_id, r.rebooked_appointment_id, r.rebook_same_vehicle
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta)
      SELECT id, 'rebooked', 'system', jsonb_build_object('match', 'contact', 'appointmentId', rebooked_appointment_id::text, 'sameVehicle', rebook_same_vehicle) FROM r
    )${retireUnsent(sql`r`, REASONS.rebooked)}
    SELECT id FROM r`)
  return rows.length
}

/** Manager decision on an uncertain (contact) match. Rejecting keeps the sequence stopped — the customer did book. */
export async function reviewRebookMatch(recoveryId: string, decision: 'confirmed' | 'rejected', actor: string): Promise<void> {
  if (!uuid(recoveryId)) throw new BookingError('not_found', 'Recovery record not found.')
  const rows = await exec(sql`WITH r AS (
      UPDATE appointment_recoveries SET rebook_review = ${decision}, updated_at = now()
      WHERE id = ${recoveryId}::uuid AND status = 'rebooked' AND rebook_match = 'contact' AND rebook_review = 'pending' RETURNING id
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta) SELECT id, 'match_reviewed', ${actor}, ${JSON.stringify({ decision })}::jsonb FROM r
    ) SELECT id FROM r`)
  if (!rows.length) throw new BookingError('conflict', 'This match has already been reviewed.')
}

// ── Send-time gate (called by dispatchDue for recovery kinds only) ────────────

export type GateResult =
  | { action: 'send'; recoveryId: string }
  | { action: 'skip'; reason: string }
  | { action: 'defer'; until: Date; reason: string }

/**
 * The last word before a recovery email reaches the provider. Runs on the CURRENT rows for the notice this
 * worker has already claimed, so it is safe against a stop, an opt-out or a new booking that landed after the
 * email was queued — including one that landed while the email sat claimed.
 */
export async function recoveryGate(n: { id: string; kind: string; appointmentId: string }, appt: Appointment, now: Date, cfg: BookingConfig): Promise<GateResult> {
  const rec = await getRecoveryForAppointment(appt.id)
  if (!rec) return { action: 'skip', reason: 'no recovery record' }
  // Timestamped claim: lets a later run tell how long this email has been in a worker's hands (see recoverInterruptedEmails).
  await logEvent(rec.id, 'email_claimed', 'system', { notificationId: n.id, step: recoveryStep(n.kind) })
  if (!cfg.recoveryEmailsEnabled) {
    // Kill switch: hold everything and pause, so turning it back on never releases a burst of stale emails.
    await pauseSequence(rec.id, 'system', REASONS.emailsOff)
    return { action: 'skip', reason: PAUSED_NOTE }
  }
  if (rec.status === 'paused') return { action: 'skip', reason: PAUSED_NOTE }
  if (rec.status !== 'active') return { action: 'skip', reason: rec.reason ?? `sequence ${rec.status}` }
  const stop = async (reason: string): Promise<GateResult> => { await stopSequence(rec.id, 'system', reason); return { action: 'skip', reason } }
  if (appt.status !== 'cancelled') return stop('The appointment is no longer cancelled.')
  if (rec.origin === 'shop') return stop(REASONS.shopCancelled)
  if (!appt.email || !isValidEmail(appt.email)) return stop(REASONS.noEmail)
  if (await emailOptedOut(appt)) return stop(REASONS.optedOut)
  if (!(await hasEmailConsent(appt))) return stop(REASONS.noConsent)
  if (await detectRebookings({ appointmentId: appt.id, cfg })) return { action: 'skip', reason: REASONS.rebooked }
  if (await hasOtherAppointment(appt)) return stop(REASONS.otherAppointment)
  if (!recoveryWindowOpen(rec, cfg, now)) return stop(REASONS.windowEnded)

  // Never two recovery emails at once: an email whose successor is already due gives way to it, and an email
  // whose predecessor is still on its way waits.
  const step = recoveryStep(n.kind)
  const siblings = await exec(sql`SELECT kind, status, send_after FROM appointment_notifications WHERE appointment_id = ${appt.id}::uuid AND kind IN ${KINDS_SQL} AND id <> ${n.id}::uuid`)
  const sib = (s: number) => siblings.find((x) => x.kind === `recovery_${s}`)
  const next = sib(step + 1)
  if (next && next.status === 'pending' && dt(next.send_after)!.getTime() <= now.getTime()) return { action: 'skip', reason: 'superseded by the next follow-up' }
  const prev = sib(step - 1)
  if (prev && (prev.status === 'pending' || prev.status === 'sending')) return { action: 'defer', until: new Date(now.getTime() + 3_600_000), reason: 'waiting for the previous follow-up' }
  return { action: 'send', recoveryId: rec.id }
}

/** Record what happened to a recovery email. `rejected` = the provider refused the address (not a temporary fault). */
export async function recordRecoveryDelivery(n: { id: string; kind: string; appointmentId: string }, outcome: 'sent' | 'uncertain' | 'failed', opts: { rejected?: boolean; provider?: string } = {}): Promise<void> {
  if (!isRecoveryKind(n.kind)) return
  const rec = await getRecoveryForAppointment(n.appointmentId)
  if (!rec) return
  const step = recoveryStep(n.kind)
  await logEvent(rec.id, `email_${outcome}`, 'system', { step, notificationId: n.id, provider: opts.provider ?? null })
  if (outcome === 'sent') {
    // The third email is the end of the sequence; a later booking can still be credited while the link window is open.
    await exec(sql`UPDATE appointment_recoveries SET last_contact_at = now(), updated_at = now(),
      status = CASE WHEN ${step} = 3 AND status = 'active' THEN 'finished' ELSE status END WHERE id = ${rec.id}::uuid`)
  } else if (outcome === 'failed' && opts.rejected) {
    await stopSequence(rec.id, 'system', REASONS.undeliverable)
  }
}

/** Cron pass: catch customers who booked again without the link, before anything is sent. */
export async function reconcileRecoveries(opts: { cfg?: BookingConfig; now?: Date } = {}): Promise<{ enabled: boolean; rebooked: number; recovered: number; suppressions: unknown }> {
  const cfg = opts.cfg ?? await getBookingConfig()
  const recovered = await recoverInterruptedEmails({ now: opts.now })
  // Unsubscribes / bounces / complaints recorded by Postmark on the broadcast stream → our email preferences, BEFORE
  // anything is dispatched. A Postmark outage never blocks the run: the send-time gate and Postmark itself still hold.
  const suppressions = await (await import('./postmark-sync')).syncPostmarkSuppressions()
    .catch((err) => ({ enabled: true, problem: err instanceof Error ? err.name : 'error' }))
  return { enabled: cfg.recoveryEmailsEnabled, rebooked: await detectRebookings({ cfg }), recovered, suppressions }
}

/** Called by the dispatcher immediately before the provider call. */
export async function markRecoverySending(n: { id: string; kind: string; appointmentId: string }): Promise<void> {
  const rec = await getRecoveryForAppointment(n.appointmentId)
  if (rec) await logEvent(rec.id, 'email_sending', 'system', { notificationId: n.id, step: recoveryStep(n.kind) })
}

/** A worker's own limit is 60 s, so a claim this old was left by an interrupted run (crash, timeout, deploy). */
export const STALE_SEND_MINUTES = 15

/**
 * Recover recovery emails left 'sending' by an interrupted worker, without ever risking a duplicate:
 *   • the provider call had begun ('email_sending' logged after the claim) → it MAY have been delivered →
 *     'uncertain', which is never resent; the sequence simply moves on to the next email;
 *   • the claim died before the provider was called → provably not sent → back to 'pending'.
 * Without this a stuck email would hold the rest of the sequence behind it forever.
 */
export async function recoverInterruptedEmails(opts: { now?: Date } = {}): Promise<number> {
  const stale = new Date((opts.now ?? new Date()).getTime() - STALE_SEND_MINUTES * 60_000)
  const rows = await exec(sql`WITH stuck AS (
      SELECT n.id, n.appointment_id, r.id AS rid,
        (SELECT max(e.created_at) FROM appointment_recovery_events e WHERE e.recovery_id = r.id AND e.event_type = 'email_claimed' AND e.meta->>'notificationId' = n.id::text) AS claimed_at,
        (SELECT max(e.created_at) FROM appointment_recovery_events e WHERE e.recovery_id = r.id AND e.event_type = 'email_sending' AND e.meta->>'notificationId' = n.id::text) AS sending_at
      FROM appointment_notifications n JOIN appointment_recoveries r ON r.appointment_id = n.appointment_id
      WHERE n.status = 'sending' AND n.kind IN ${KINDS_SQL}
    ), fix AS (
      UPDATE appointment_notifications n SET
        status = CASE WHEN s.sending_at IS NOT NULL AND s.sending_at >= s.claimed_at THEN 'uncertain' ELSE 'pending' END,
        error = CASE WHEN s.sending_at IS NOT NULL AND s.sending_at >= s.claimed_at THEN 'Interrupted after sending started — it may have been delivered, so it is not resent.' ELSE 'Interrupted before sending.' END
      FROM stuck s WHERE n.id = s.id AND n.status = 'sending'
        -- No claim record at all = it died in the instant between the claim and the gate; give it a day before assuming so.
        AND ((s.claimed_at IS NOT NULL AND s.claimed_at < ${iso(stale)}::timestamptz) OR (s.claimed_at IS NULL AND n.send_after < ${iso(stale)}::timestamptz - interval '1 day'))
      RETURNING n.id, n.status, s.rid
    ), ev AS (
      INSERT INTO appointment_recovery_events (recovery_id, event_type, actor, meta)
      SELECT rid, 'email_interrupted', 'system', jsonb_build_object('notificationId', id::text, 'to', status) FROM fix
    ) SELECT id FROM fix`)
  return rows.length
}

/**
 * Payments taken DIRECTLY in QuickBooks (online invoice link, or entered there by hand) only reach this app when
 * someone opens Record Payment on the job. This asks the existing, authoritative read path
 * (previewRetailPayment — verifies the invoice, reads QuickBooks, adopts a zero balance; it never writes to
 * QuickBooks) to re-check the few recovered jobs that are completed, invoiced and not yet marked paid, so
 * recovered revenue does not wait on a click. Production only in practice: QuickBooks is unreachable locally.
 */
export async function refreshRecoveredPayments(opts: { limit?: number; check?: (orderId: string) => Promise<unknown> } = {}): Promise<{ checked: number; failed: number }> {
  const jobs = await exec(sql`SELECT DISTINCT so.id FROM appointment_recoveries r
    JOIN appointments b ON b.id = r.rebooked_appointment_id AND b.status <> 'cancelled'
    JOIN service_orders so ON so.id = b.service_order_id AND so.status IN ('ready', 'delivered') AND so.completed_at IS NOT NULL AND so.cancelled_at IS NULL
    JOIN job_estimates je ON je.service_order_id = so.id AND je.qb_invoice_id IS NOT NULL
    WHERE (r.rebook_match IN ('link', 'staff') OR r.rebook_review = 'confirmed') AND je.qb_payment_status <> 'paid' AND coalesce(je.qb_payment_balance_state, '') <> 'paid'
      AND so.completed_at > now() - interval '180 days'
    LIMIT ${opts.limit ?? 20}`)
  const check = opts.check ?? (async (orderId: string) => (await import('@/apps/quickbooks/retail-payment-service')).previewRetailPayment({ orderId, actor: 'system' }))
  let failed = 0
  for (const { id } of jobs) { try { await check(String(id)) } catch { failed++ } }
  return { checked: jobs.length, failed }
}

// ── Queue (staff) ─────────────────────────────────────────────────────────────

export interface RecoveryEmailState { kind: string; status: string; sendAfter: string; sentAt: string | null; error: string | null }
export interface QueueItem {
  id: string; status: RecoveryStatus; origin: CancelOrigin; reason: string | null; staffOutcome: StaffOutcome | null
  cancelledAt: Date; lastContactAt: Date | null; cancelReason: string | null
  appointmentId: string; reference: string; customerName: string; phone: string; email: string | null; customerId: string | null
  vehicle: string; serviceKeys: string[]; serviceLabels: string; localDate: string; localTime: string
  emails: RecoveryEmailState[]
  /** Email-marketing permission on record. */
  emailConsent: boolean
  /** Cancelled within QUICK_CANCEL_MINUTES of booking. */
  quickCancel: boolean
  rebooked: { appointmentId: string; reference: string; status: string; localDate: string; match: string; review: string | null; sameVehicle: boolean | null; orderId: string | null } | null
  value: ValueEstimate; tier: number
}
export type QueueView = 'attention' | 'running' | 'rebooked' | 'closed'
const VIEW_SQL: Record<QueueView, SQL> = {
  attention: sql`(r.status = 'review' OR (r.status = 'rebooked' AND r.rebook_review = 'pending'))`,
  running: sql`r.status IN ('active', 'paused')`,
  rebooked: sql`r.status = 'rebooked'`,
  closed: sql`r.status IN ('stopped', 'finished')`,
}
const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10))

export async function catalogPrices(): Promise<Map<string, number | null>> {
  const rows = await exec(sql`SELECT slug, default_price_cents FROM service_catalog WHERE active`)
  return new Map(rows.map((r) => [String(r.slug), r.default_price_cents == null ? null : Number(r.default_price_cents)]))
}

export async function listRecoveries(view: QueueView, opts: { cfg?: BookingConfig; limit?: number } = {}): Promise<QueueItem[]> {
  const cfg = opts.cfg ?? await getBookingConfig()
  const [rows, prices] = await Promise.all([exec(sql`
    SELECT r.id, r.status, r.origin, r.reason, r.staff_outcome, r.cancelled_at, r.last_contact_at, r.rebook_match, r.rebook_review, r.rebook_same_vehicle,
      a.id AS appointment_id, a.reference, a.first_name, a.last_name, a.phone, a.email, a.customer_id, a.vehicle_year, a.vehicle_make, a.vehicle_model,
      a.service_keys, a.service_labels, a.local_date, a.local_time, a.created_at AS a_created,
      coalesce((SELECT e.event FROM marketing_consent_events e JOIN customers c ON c.id = e.customer_id WHERE e.channel = 'email' AND e.event IN ('opt_in', 'opt_out')
        AND (c.id = a.customer_id OR (coalesce(a.email, '') <> '' AND c.normalized_email = lower(a.email))) ORDER BY e.created_at DESC, e.id DESC LIMIT 1), '') = 'opt_in' AS email_consent,
      (SELECT e.meta->>'reason' FROM appointment_events e WHERE e.appointment_id = a.id AND e.event_type = 'cancelled' ORDER BY e.created_at DESC LIMIT 1) AS cancel_reason,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', n.kind, 'status', n.status, 'sendAfter', n.send_after, 'sentAt', n.sent_at, 'error', n.error) ORDER BY n.kind), '[]'::jsonb)
        FROM appointment_notifications n WHERE n.appointment_id = a.id AND n.kind IN ${KINDS_SQL}) AS emails,
      b.id AS b_id, b.reference AS b_reference, b.status AS b_status, b.local_date AS b_date, b.service_order_id AS b_order
    FROM appointment_recoveries r JOIN appointments a ON a.id = r.appointment_id LEFT JOIN appointments b ON b.id = r.rebooked_appointment_id
    WHERE ${VIEW_SQL[view]} ORDER BY r.cancelled_at DESC LIMIT ${opts.limit ?? 300}`), catalogPrices()])
  const items = rows.map((r): QueueItem => {
    const serviceKeys = Array.isArray(r.service_keys) ? (r.service_keys as string[]) : []
    const emails = (typeof r.emails === 'string' ? JSON.parse(r.emails) : r.emails ?? []) as RecoveryEmailState[]
    return {
      id: String(r.id), status: r.status as RecoveryStatus, origin: r.origin as CancelOrigin, reason: (r.reason as string | null) ?? null,
      staffOutcome: (r.staff_outcome as StaffOutcome | null) ?? null, cancelledAt: dt(r.cancelled_at)!, lastContactAt: dt(r.last_contact_at),
      cancelReason: (r.cancel_reason as string | null) || null, appointmentId: String(r.appointment_id), reference: String(r.reference),
      customerName: [r.first_name, r.last_name].filter(Boolean).join(' '), phone: String(r.phone ?? ''), email: (r.email as string | null) ?? null,
      customerId: (r.customer_id as string | null) ?? null,
      vehicle: [r.vehicle_year, r.vehicle_make === 'Trailer' ? null : r.vehicle_make, r.vehicle_model].filter(Boolean).join(' '),
      serviceKeys, serviceLabels: String(r.service_labels ?? ''), localDate: ymd(r.local_date), localTime: String(r.local_time ?? ''), emails,
      emailConsent: r.email_consent === true, quickCancel: isQuickCancel({ createdAt: dt(r.a_created)!, cancelledAt: dt(r.cancelled_at) }),
      rebooked: r.b_id ? { appointmentId: String(r.b_id), reference: String(r.b_reference), status: String(r.b_status), localDate: ymd(r.b_date),
        match: String(r.rebook_match ?? ''), review: (r.rebook_review as string | null) ?? null, sameVehicle: (r.rebook_same_vehicle as boolean | null) ?? null,
        orderId: (r.b_order as string | null) ?? null } : null,
      value: estimateValue(serviceKeys, cfg.services, prices), tier: priorityTier(serviceKeys),
    }
  })
  // Highest-value opportunities first: service tier, then the known price floor, then the most recent cancellation.
  return items.sort((x, y) => y.tier - x.tier || (y.value.minCents ?? 0) - (x.value.minCents ?? 0) || y.cancelledAt.getTime() - x.cancelledAt.getTime())
}

export async function countRecoveryAttention(): Promise<number> {
  const [r] = await exec(sql`SELECT count(*)::int AS n FROM appointment_recoveries r WHERE ${VIEW_SQL.attention}`)
  return Number(r?.n ?? 0)
}

export interface Candidate {
  appointment: Appointment; origin: CancelOrigin; cancelReason: string | null
  verdict: RecoveryVerdict; value: ValueEstimate; tier: number
}
/**
 * Cancelled appointments that are NOT in the queue (older cancellations, Pitt Stop cancellations, customers who
 * already rebooked) with the verdict each would get. READ-ONLY: nothing is enrolled by looking at this list.
 */
export async function listCandidates(opts: { days?: number; cfg?: BookingConfig; now?: Date } = {}): Promise<Candidate[]> {
  const cfg = opts.cfg ?? await getBookingConfig()
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.days ?? 90) * 86_400_000)
  const ids = await exec(sql`SELECT a.id FROM appointments a WHERE a.status = 'cancelled' AND coalesce(a.cancelled_at, a.updated_at) >= ${iso(since)}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM appointment_recoveries r WHERE r.appointment_id = a.id) ORDER BY a.cancelled_at DESC NULLS LAST LIMIT 100`)
  const prices = await catalogPrices()
  const out: Candidate[] = []
  for (const { id } of ids) {
    const appointment = await getAppointment(String(id))
    if (!appointment) continue
    const { origin, reason } = await recordedOrigin(appointment.id)
    const keys = appointment.serviceKeys ?? []
    out.push({ appointment, origin, cancelReason: reason, verdict: evaluateRecovery(await recoveryFacts(appointment, origin), cfg),
      value: estimateValue(keys, cfg.services, prices), tier: priorityTier(keys) })
  }
  return out
}

export async function listRecoveryEvents(recoveryId: string) {
  if (!uuid(recoveryId)) return []
  return exec(sql`SELECT event_type, actor, meta, created_at FROM appointment_recovery_events WHERE recovery_id = ${recoveryId}::uuid ORDER BY created_at`)
}

// ── Reporting ─────────────────────────────────────────────────────────────────

export interface RecoveryReport {
  /** Cancellations in the window that were the customer's own, or that a manager chose to follow up. */
  eligible: number
  /** In the queue, not started, and not a Pitt Stop cancellation — includes ones whose origin still needs confirming. */
  awaitingReview: number
  contacted: number
  emailsSent: number
  /** Accepted by the email provider. Inbox delivery, opens and replies are not tracked. */
  emailsUncertain: number
  emailsFailed: number
  /** Credited rebookings: recovery link, staff rebooking, or a manager-confirmed customer match. */
  rebooked: number
  rebookedUnconfirmed: number
  completed: number
  completedAndPaid: number
  /** Quoted value of the credited rebookings' jobs, where a job exists. Not revenue. */
  recoveredValueCents: number
  /** Completed jobs QuickBooks reports paid. The only number here that is money earned. */
  recoveredRevenueCents: number
}

/** The report for the trailing N days (cancellations made in that window). */
export async function recoveryReportLastDays(days: number, now: Date = new Date()): Promise<RecoveryReport> {
  return recoveryReport({ from: new Date(now.getTime() - days * 86_400_000), to: now })
}

/** Recovery results for cancellations made in the window. Every number is a count or sum of stored rows. */
export async function recoveryReport(range: { from: Date; to: Date }): Promise<RecoveryReport> {
  const [r] = await exec(sql`
    WITH base AS (
      SELECT r.id, r.status, r.origin, r.sequence_started_at, r.rebook_review, r.appointment_id,
        (r.rebooked_appointment_id IS NOT NULL AND b.status <> 'cancelled' AND (r.rebook_match IN ('link', 'staff') OR r.rebook_review = 'confirmed')) AS credited,
        (so.id IS NOT NULL AND so.status IN ('ready', 'delivered') AND so.completed_at IS NOT NULL AND so.cancelled_at IS NULL) AS completed,
        je.total_cents, COALESCE(NULLIF(je.total_cents, 0), so.approved_price_cents) AS quoted_cents,
        (je.qb_payment_status = 'paid' OR je.qb_payment_balance_state = 'paid') AS paid
      FROM appointment_recoveries r
      LEFT JOIN appointments b ON b.id = r.rebooked_appointment_id
      LEFT JOIN service_orders so ON so.id = b.service_order_id
      LEFT JOIN LATERAL (SELECT e.total_cents, e.qb_payment_status, e.qb_payment_balance_state FROM job_estimates e WHERE e.service_order_id = so.id ORDER BY e.created_at DESC LIMIT 1) je ON true
      WHERE r.cancelled_at >= ${iso(range.from)}::timestamptz AND r.cancelled_at <= ${iso(range.to)}::timestamptz
    ), mail AS (
      SELECT n.appointment_id, count(*) FILTER (WHERE n.status = 'sent') AS sent, count(*) FILTER (WHERE n.status = 'uncertain') AS uncertain,
        count(*) FILTER (WHERE n.status = 'failed') AS failed
      FROM appointment_notifications n WHERE n.kind IN ${KINDS_SQL} AND n.appointment_id IN (SELECT appointment_id FROM base) GROUP BY 1
    )
    SELECT
      count(*) FILTER (WHERE base.origin = 'customer' OR base.sequence_started_at IS NOT NULL)::int AS eligible,
      count(*) FILTER (WHERE base.status = 'review' AND base.origin <> 'shop')::int AS awaiting_review,
      count(*) FILTER (WHERE coalesce(mail.sent, 0) > 0)::int AS contacted,
      coalesce(sum(mail.sent), 0)::int AS emails_sent, coalesce(sum(mail.uncertain), 0)::int AS emails_uncertain, coalesce(sum(mail.failed), 0)::int AS emails_failed,
      count(*) FILTER (WHERE base.credited)::int AS rebooked,
      count(*) FILTER (WHERE base.rebook_review = 'pending')::int AS rebooked_unconfirmed,
      count(*) FILTER (WHERE base.credited AND base.completed)::int AS completed,
      count(*) FILTER (WHERE base.credited AND base.completed AND base.paid)::int AS completed_and_paid,
      coalesce(sum(base.quoted_cents) FILTER (WHERE base.credited), 0)::int AS recovered_value_cents,
      coalesce(sum(base.total_cents) FILTER (WHERE base.credited AND base.completed AND base.paid), 0)::int AS recovered_revenue_cents
    FROM base LEFT JOIN mail ON mail.appointment_id = base.appointment_id`)
  const n = (k: string) => Number(r?.[k] ?? 0)
  return {
    eligible: n('eligible'), awaitingReview: n('awaiting_review'), contacted: n('contacted'), emailsSent: n('emails_sent'),
    emailsUncertain: n('emails_uncertain'), emailsFailed: n('emails_failed'), rebooked: n('rebooked'), rebookedUnconfirmed: n('rebooked_unconfirmed'),
    completed: n('completed'), completedAndPaid: n('completed_and_paid'), recoveredValueCents: n('recovered_value_cents'), recoveredRevenueCents: n('recovered_revenue_cents'),
  }
}
