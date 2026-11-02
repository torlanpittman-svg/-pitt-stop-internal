/**
 * Staff booking alerts — enrolment, durable outbox, delivery.
 *
 * SHAPE OF THE GUARANTEE
 *  • NOTHING here is inside the booking transaction. The booking statement in apps/appointments/db.ts
 *    is untouched by this feature, so no notification table, bug or missing migration can fail, delay
 *    or undo a customer's booking — and migration 0068 can be rolled back while this code is live.
 *  • The alert is recorded right after the booking commits (recordNewBookingAlert), best-effort; if
 *    even that is lost, the next dispatch recreates it from the appointment itself (see 1b below).
 *  • A replayed booking submission reuses the same dedupe_key, so it produces no second alert.
 *  • Fan-out is claimed in one atomic statement and each (alert, device) pair is unique, so a retry,
 *    a double-tap or two workers running at once can never notify the same phone twice.
 *  • Nothing in a notification identifies the customer — the lock screen only ever shows the
 *    drop-off time and "tap to open". The details live behind the PIN-gated appointment screen.
 *
 * WHO GETS ALERTED: managers and admins only, for now. Authority is re-checked against the live
 * identity registry at send time, so a person removed from EMPLOYEE_IDENTITIES (or demoted) stops
 * being notified on their next alert — their devices are disabled, not merely skipped.
 */
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { logger } from '@/platform/logger'
import { EMPLOYEE_IDENTITIES, type AuthedActor } from '@/apps/auth/employee-session'
import { isManagerRole } from '@/apps/auth/employee-guard'
import { appointments } from '@/apps/appointments/schema'
import { formatDateLabel, formatTimeLabel } from '@/apps/appointments/policy'
import { staffAlertDeliveries, staffAlerts, staffPushSubscriptions } from './schema'
import { endpointHash, pushConfig, sendPush, type PushConfig, type PushOutcome } from './web-push'

export type StaffPushSubscription = typeof staffPushSubscriptions.$inferSelect
export type StaffAlert = typeof staffAlerts.$inferSelect
export type StaffAlertDelivery = typeof staffAlertDeliveries.$inferSelect

export const ALERT_KIND_NEW_BOOKING = 'new_booking'
/** An alert nobody received within a day is stale operational news — retired, never fired late. */
export const MAX_ALERT_AGE_HOURS = 24
export const MAX_DELIVERY_ATTEMPTS = 5
const RETRY_BACKOFF_MS = 5 * 60_000
/**
 * How many devices one dispatch run will try. Sends are serial inside a serverless invocation with a
 * 60 s budget, so this is deliberately far below what the budget allows: anything not reached is
 * still pending and goes out on the next run, whereas a run killed mid-list burns attempts.
 */
const DEFAULT_SEND_LIMIT = 25
/**
 * A claim older than this means the worker that took it never came back (killed mid-invocation).
 * Such a delivery IS retried: the notification carries the alert id as its `tag`, so a phone that
 * already received the first attempt replaces that notification rather than stacking a second one.
 * The attempt limit still applies, so a repeatedly-dying worker cannot loop forever.
 */
const STUCK_CLAIM_MS = 10 * 60_000

/** One alert per booking, forever: same appointment → same key → the second insert is a no-op. */
export const newBookingDedupeKey = (appointmentId: string) => `${appointmentId}:${ALERT_KIND_NEW_BOOKING}`

// ── Who may be alerted ────────────────────────────────────────────────────────

/**
 * Identity keys allowed to hold a push subscription. Managers/admins from the live registry, plus
 * 'admin' (the ADMIN_PASSWORD Basic-Auth actor, which has no registry row). Pure so the revocation
 * rule is testable without env or DB.
 */
export function allowedRecipientKeys(
  identities: ReadonlyArray<{ key: string; role: string }> = EMPLOYEE_IDENTITIES,
): string[] {
  const keys = identities.filter((i) => isManagerRole(i.role as AuthedActor['role'])).map((i) => i.key)
  return Array.from(new Set(['admin', ...keys]))
}

/** May THIS signed-in person enrol a device? (manager/admin only, for this first version) */
export function mayEnrol(actor: AuthedActor | null): actor is AuthedActor {
  return !!actor && isManagerRole(actor.role) && allowedRecipientKeys().includes(actor.key)
}

// ── Recording an alert ────────────────────────────────────────────────────────

/**
 * Record "a new online booking arrived", once, for an appointment that is ALREADY SAVED.
 *
 * Called from the public booking route after the booking has committed, so it is structurally
 * incapable of affecting the booking. Callers treat a rejection as nothing more than a missing
 * alert: the next dispatch recreates it from the appointment row (step 1b), and the in-app banner
 * on Home never depended on this table at all.
 *
 * Returns the alert id — the existing one if this booking already had an alert (a replayed
 * submission, or a retry of this call), so no caller can create a second one.
 */
export async function recordNewBookingAlert(appointmentId: string): Promise<string> {
  const dedupeKey = newBookingDedupeKey(appointmentId)
  const [inserted] = await getDb().insert(staffAlerts)
    .values({ appointmentId, kind: ALERT_KIND_NEW_BOOKING, dedupeKey })
    .onConflictDoNothing({ target: staffAlerts.dedupeKey })
    .returning({ id: staffAlerts.id })
  if (inserted) return inserted.id
  const [existing] = await getDb().select({ id: staffAlerts.id }).from(staffAlerts)
    .where(eq(staffAlerts.dedupeKey, dedupeKey)).limit(1)
  return existing.id
}

// ── Enrolment ─────────────────────────────────────────────────────────────────

export interface SubscriptionInput { endpoint: string; p256dh: string; auth: string; deviceLabel?: string | null }

/**
 * Record (or re-record) one device for one person. Keyed on the endpoint, so re-enabling on the same
 * device updates the existing row instead of stacking duplicates — including when a DIFFERENT person
 * signs in on a shared shop phone: the row is re-pointed at whoever enrolled it last, and re-enabled.
 */
export async function saveSubscription(input: SubscriptionInput, actor: AuthedActor): Promise<StaffPushSubscription> {
  const [row] = await getDb()
    .insert(staffPushSubscriptions)
    .values({
      endpoint: input.endpoint, endpointHash: endpointHash(input.endpoint), p256dh: input.p256dh, auth: input.auth,
      employeeKey: actor.key, employeeName: actor.name, employeeRole: actor.role,
      deviceLabel: input.deviceLabel?.slice(0, 120) || null,
    })
    .onConflictDoUpdate({
      target: staffPushSubscriptions.endpointHash,
      set: {
        endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth,
        employeeKey: actor.key, employeeName: actor.name, employeeRole: actor.role,
        deviceLabel: input.deviceLabel?.slice(0, 120) || null,
        lastSeenAt: new Date(), disabledAt: null, disabledReason: null,
      },
    })
    .returning()
  return row
}

export type DisableReason = 'signed_out' | 'expired' | 'revoked' | 'replaced' | 'disabled_by_staff'

/**
 * Disabling a device drops the live push credentials but keeps the row: who enrolled what, when, and
 * why it stopped stays auditable, while a disabled device no longer holds a usable address for
 * someone's phone. Re-enrolling the same device writes fresh credentials back.
 */
const CLEARED_KEYS = { endpoint: '', p256dh: '', auth: '' } as const

/**
 * Stop notifying a device. Soft only — the enrolment history is kept. Any work still queued for it
 * is skipped so a disabled device cannot be woken by a retry.
 */
export async function disableSubscription(endpoint: string, reason: DisableReason): Promise<boolean> {
  const db = getDb()
  const rows = await db.update(staffPushSubscriptions)
    .set({ disabledAt: new Date(), disabledReason: reason, ...CLEARED_KEYS })
    .where(and(eq(staffPushSubscriptions.endpointHash, endpointHash(endpoint)), isNull(staffPushSubscriptions.disabledAt)))
    .returning({ id: staffPushSubscriptions.id })
  if (rows.length) await skipPendingFor(rows.map((r) => r.id), `device ${reason}`)
  return rows.length > 0
}

async function skipPendingFor(subscriptionIds: string[], why: string): Promise<void> {
  if (!subscriptionIds.length) return
  await getDb().update(staffAlertDeliveries).set({ status: 'skipped', error: why })
    .where(and(inArray(staffAlertDeliveries.status, ['pending', 'sending']), inArray(staffAlertDeliveries.subscriptionId, subscriptionIds)))
}

/** Is this exact device currently enrolled? (drives the on/off state of the enable button) */
export async function findSubscription(endpoint: string): Promise<StaffPushSubscription | null> {
  const [row] = await getDb().select().from(staffPushSubscriptions)
    .where(eq(staffPushSubscriptions.endpointHash, endpointHash(endpoint))).limit(1)
  return row ?? null
}

export async function listSubscriptions(opts: { employeeKey?: string; includeDisabled?: boolean } = {}): Promise<StaffPushSubscription[]> {
  return getDb().select().from(staffPushSubscriptions)
    .where(and(
      opts.includeDisabled ? undefined : isNull(staffPushSubscriptions.disabledAt),
      opts.employeeKey ? eq(staffPushSubscriptions.employeeKey, opts.employeeKey) : undefined,
    ))
    .orderBy(desc(staffPushSubscriptions.lastSeenAt))
}

// ── Message text (deliberately free of customer details) ──────────────────────

export interface AlertMessage { title: string; body: string; url: string; tag: string }

/**
 * What the phone shows. A lock screen is visible to anyone holding the phone, so this says WHEN the
 * drop-off is and nothing about WHO booked it — no name, phone, email, vehicle or service list.
 */
export function renderAlert(alert: Pick<StaffAlert, 'id' | 'kind' | 'appointmentId'>, appt: { localDate: string; localTime: string } | null): AlertMessage {
  const when = appt ? `${formatDateLabel(appt.localDate)} at ${formatTimeLabel(appt.localTime)}` : null
  return {
    title: 'New online booking',
    body: when ? `Drop-off ${when}. Tap to see the details.` : 'Tap to see the details.',
    url: alert.appointmentId ? `/appointments/${alert.appointmentId}` : '/appointments?view=today',
    tag: alert.id,
  }
}

// ── Delivery ──────────────────────────────────────────────────────────────────

export interface DispatchTally {
  /** Accepted by a push service for delivery (NOT proof the phone displayed it). */
  sent: number
  retrying: number
  failed: number
  /** Devices the push service says no longer exist — disabled here. */
  expired: number
  skipped: number
  /** Alerts retired unsent because nothing could carry them in time. */
  staleAlerts: number
  /** True when VAPID keys are not configured, so nothing was attempted. */
  notConfigured: boolean
}

const EMPTY: DispatchTally = { sent: 0, retrying: 0, failed: 0, expired: 0, skipped: 0, staleAlerts: 0, notConfigured: false }

export interface DispatchOptions {
  now?: Date
  limit?: number
  /** Restrict to one alert (used by the immediate post-booking dispatch). */
  alertId?: string
  config?: PushConfig | null
  fetchImpl?: typeof fetch
  recipientKeys?: string[]
}

/**
 * Fan out and deliver. Safe to call concurrently and as often as you like: every state change is a
 * conditional update, so two workers racing on the same row cannot both send it.
 */
export async function dispatchStaffAlerts(opts: DispatchOptions = {}): Promise<DispatchTally> {
  const db = getDb()
  const now = opts.now ?? new Date()
  const staleBefore = new Date(now.getTime() - MAX_ALERT_AGE_HOURS * 3_600_000)
  const tally: DispatchTally = { ...EMPTY }

  // 1. Revoked people first — a device must never be woken for someone who has lost access.
  await revokeUnauthorizedDevices(opts.recipientKeys ?? allowedRecipientKeys())

  // 1b. Safety net — and, if recordNewBookingAlert never ran, the only creator. It alerts an online
  //     booking that is:
  //       • genuinely from the public page: created_by IS NULL (a staff-entered booking always has an
  //         actor, even when a manager picks "website booking" as its source);
  //       • still unseen: acknowledged_at IS NULL, the same rule the Appointments list uses, so a
  //         booking staff already marked seen is never pushed;
  //       • newer than the oldest enrolled device, so turning notifications on does not immediately
  //         replay the last day of bookings onto a phone that was not enrolled when they arrived.
  await db.execute(sql`
    INSERT INTO staff_alerts (appointment_id, kind, dedupe_key)
    SELECT a.id, ${ALERT_KIND_NEW_BOOKING}, a.id::text || ':' || ${ALERT_KIND_NEW_BOOKING}
    FROM appointments a
    WHERE a.source = 'website_booking' AND a.created_by IS NULL AND a.status = 'confirmed'
      AND a.acknowledged_at IS NULL
      AND a.created_at >= ${staleBefore}
      AND a.created_at >= COALESCE((SELECT min(created_at) FROM staff_push_subscriptions WHERE disabled_at IS NULL), '-infinity'::timestamptz)
    ON CONFLICT (dedupe_key) DO NOTHING`)

  // 1c. Recover claims abandoned by a worker that was killed mid-send, so an alert is not simply
  //     lost. Queued again (within the attempt limit) because the notification's `tag` makes a
  //     second arrival replace the first on the phone instead of stacking another one.
  const stuckBefore = new Date(now.getTime() - STUCK_CLAIM_MS)
  await db.update(staffAlertDeliveries)
    .set({
      status: sql`CASE WHEN ${staffAlertDeliveries.attempts} < ${MAX_DELIVERY_ATTEMPTS} THEN 'pending' ELSE 'failed' END`,
      sendAfter: now,
      error: 'Interrupted while sending — the outcome was never recorded.',
    })
    .where(and(eq(staffAlertDeliveries.status, 'sending'), lte(staffAlertDeliveries.claimedAt, stuckBefore)))

  // 2. Retire alerts nobody can usefully receive any more.
  const stale = await db.execute(sql`
    UPDATE staff_alerts SET fanned_out_at = ${now}, resolved_at = ${now}, resolution = 'expired_unsent'
    WHERE fanned_out_at IS NULL AND created_at < ${staleBefore} RETURNING id`)
  tally.staleAlerts = rowCount(stale)
  await db.execute(sql`
    UPDATE staff_alert_deliveries d SET status = 'skipped', error = 'alert too old to deliver'
    WHERE d.status = 'pending' AND EXISTS (SELECT 1 FROM staff_alerts a WHERE a.id = d.alert_id AND a.created_at < ${staleBefore})`)

  // 3. Fan out: claiming the alert and creating its per-device rows is ONE statement, so a worker
  //    that dies mid-way cannot leave an alert marked fanned-out with nobody to deliver it.
  await db.execute(sql`
    WITH claimed AS (
      UPDATE staff_alerts SET fanned_out_at = ${now}
      WHERE fanned_out_at IS NULL AND created_at >= ${staleBefore}
      ${opts.alertId ? sql`AND id = ${opts.alertId}::uuid` : sql``}
      RETURNING id
    )
    INSERT INTO staff_alert_deliveries (alert_id, subscription_id, send_after)
    -- send_after is THIS run's clock, not the database's: a default of now() lands a few
    -- milliseconds after the clock this same run compares against, and the brand-new alert would
    -- sit unsent until the next cron — exactly the alert that most needs to go out immediately.
    SELECT c.id, s.id, ${now} FROM claimed c CROSS JOIN staff_push_subscriptions s WHERE s.disabled_at IS NULL
    ON CONFLICT (alert_id, subscription_id) DO NOTHING`)
  await db.execute(sql`
    UPDATE staff_alerts SET resolved_at = ${now}, resolution = 'no_devices'
    WHERE fanned_out_at IS NOT NULL AND resolved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM staff_alert_deliveries d WHERE d.alert_id = staff_alerts.id)`)

  // 4. Send. With no VAPID keys the queue simply waits (and ages out) — it never reports a delivery
  //    that did not happen.
  const cfg = opts.config === undefined ? pushConfig() : opts.config
  if (!cfg) {
    tally.notConfigured = true
    return tally
  }

  const due = await db.select({
    delivery: staffAlertDeliveries, sub: staffPushSubscriptions, alert: staffAlerts,
    localDate: appointments.localDate, localTime: appointments.localTime,
  })
    .from(staffAlertDeliveries)
    .innerJoin(staffPushSubscriptions, eq(staffPushSubscriptions.id, staffAlertDeliveries.subscriptionId))
    .innerJoin(staffAlerts, eq(staffAlerts.id, staffAlertDeliveries.alertId))
    .leftJoin(appointments, eq(appointments.id, staffAlerts.appointmentId))
    .where(and(
      eq(staffAlertDeliveries.status, 'pending'),
      lte(staffAlertDeliveries.sendAfter, now),
      ...(opts.alertId ? [eq(staffAlertDeliveries.alertId, opts.alertId)] : []),
    ))
    .orderBy(asc(staffAlertDeliveries.sendAfter))
    .limit(opts.limit ?? DEFAULT_SEND_LIMIT)

  for (const row of due) {
    // Conditional claim: whoever flips pending → sending owns this one send.
    const [claimed] = await db.update(staffAlertDeliveries)
      .set({ status: 'sending', attempts: sql`${staffAlertDeliveries.attempts} + 1`, claimedAt: now })
      .where(and(eq(staffAlertDeliveries.id, row.delivery.id), eq(staffAlertDeliveries.status, 'pending')))
      .returning()
    if (!claimed) continue

    if (row.sub.disabledAt) {
      await settle(row.delivery.id, { status: 'skipped', error: 'device disabled' })
      tally.skipped++
      continue
    }

    const msg = renderAlert(row.alert, row.localDate ? { localDate: row.localDate, localTime: row.localTime! } : null)
    const outcome = await sendPush({
      endpoint: row.sub.endpoint, keys: { p256dh: row.sub.p256dh, auth: row.sub.auth },
      payload: JSON.stringify(msg), vapid: cfg.vapid, subject: cfg.subject,
      // TTL: the push service itself holds the message for an offline/asleep phone and keeps trying,
      // which is what actually covers "the phone was off", not our own retry pass.
      topic: msg.tag.replace(/-/g, '').slice(0, 32), ttl: MAX_ALERT_AGE_HOURS * 3600, now, fetchImpl: opts.fetchImpl,
    })
    await applyOutcome(row.delivery.id, row.sub.id, claimed.attempts, outcome, now, tally)
  }

  await resolveFinishedAlerts(now)
  return tally
}

async function applyOutcome(deliveryId: string, subscriptionId: string, attempts: number, outcome: PushOutcome, now: Date, tally: DispatchTally): Promise<void> {
  const db = getDb()
  if (outcome.status === 'sent') {
    await settle(deliveryId, { status: 'sent', sentAt: now, httpStatus: outcome.httpStatus, error: null })
    await db.update(staffPushSubscriptions).set({ lastSuccessAt: now, lastSeenAt: now }).where(eq(staffPushSubscriptions.id, subscriptionId))
    tally.sent++
    return
  }
  if (outcome.status === 'expired') {
    // The device unsubscribed or the app was removed. Disable it rather than retrying forever.
    await settle(deliveryId, { status: 'expired', httpStatus: outcome.httpStatus, error: outcome.error })
    await db.update(staffPushSubscriptions).set({ disabledAt: now, disabledReason: 'expired', ...CLEARED_KEYS })
      .where(and(eq(staffPushSubscriptions.id, subscriptionId), isNull(staffPushSubscriptions.disabledAt)))
    await skipPendingFor([subscriptionId], 'device expired')
    tally.expired++
    return
  }
  const retry = outcome.status === 'retry' && attempts < MAX_DELIVERY_ATTEMPTS
  if (retry) {
    await settle(deliveryId, { status: 'pending', sendAfter: new Date(now.getTime() + RETRY_BACKOFF_MS * attempts), httpStatus: outcome.httpStatus, error: outcome.error })
    tally.retrying++
    return
  }
  await settle(deliveryId, { status: 'failed', httpStatus: outcome.httpStatus, error: outcome.error })
  tally.failed++
}

type Settlement = Partial<Pick<StaffAlertDelivery, 'status' | 'sentAt' | 'httpStatus' | 'error' | 'sendAfter' | 'claimedAt'>>
const settle = (id: string, set: Settlement) => getDb().update(staffAlertDeliveries).set(set).where(eq(staffAlertDeliveries.id, id))

/** Close out alerts whose deliveries have all reached a final state. */
async function resolveFinishedAlerts(now: Date): Promise<void> {
  await getDb().execute(sql`
    UPDATE staff_alerts a SET resolved_at = ${now},
      resolution = CASE WHEN EXISTS (SELECT 1 FROM staff_alert_deliveries d WHERE d.alert_id = a.id AND d.status = 'sent')
                        THEN 'delivered' ELSE 'all_failed' END
    WHERE a.resolved_at IS NULL AND a.fanned_out_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM staff_alert_deliveries d WHERE d.alert_id = a.id AND d.status IN ('pending', 'sending'))`)
}

/** Disable every device belonging to somebody who is no longer an authorized recipient. */
export async function revokeUnauthorizedDevices(allowedKeys: string[]): Promise<number> {
  // An empty allow-list would mean "nobody may be notified" — revoke everything rather than, by an
  // empty NOT IN (...), silently revoke nothing.
  const revoked = await getDb().update(staffPushSubscriptions)
    .set({ disabledAt: new Date(), disabledReason: 'revoked', ...CLEARED_KEYS })
    .where(and(
      isNull(staffPushSubscriptions.disabledAt),
      allowedKeys.length ? notInArray(staffPushSubscriptions.employeeKey, allowedKeys) : undefined,
    ))
    .returning({ id: staffPushSubscriptions.id })
  if (revoked.length) {
    await skipPendingFor(revoked.map((r) => r.id), 'recipient no longer authorized')
    logger.warn('staff-alerts', 'revoked_devices', { count: revoked.length })
  }
  return revoked.length
}

function rowCount(result: unknown): number {
  const r = result as { rows?: unknown[]; rowCount?: number }
  return r?.rows?.length ?? r?.rowCount ?? 0
}

// ── Surfacing trouble to the person who relies on it ─────────────────────────

export interface DeliveryProblem { deviceLabel: string | null; error: string | null; at: Date }

/**
 * Alerts that could NOT be delivered to this person's devices recently.
 *
 * Without this, a phone that has gone quiet looks identical to a quiet week — the exact failure mode
 * that matters, because the whole point of the feature is that nobody has to check. The common cause
 * is a rotated VAPID key: every push then comes back 400/403 while the device still says "ON".
 */
export async function recentDeliveryProblems(employeeKey: string, opts: { now?: Date; hours?: number } = {}): Promise<DeliveryProblem[]> {
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.hours ?? 48) * 3_600_000)
  return getDb().select({
    deviceLabel: staffPushSubscriptions.deviceLabel,
    error: staffAlertDeliveries.error,
    at: staffAlertDeliveries.createdAt,
  })
    .from(staffAlertDeliveries)
    .innerJoin(staffPushSubscriptions, eq(staffPushSubscriptions.id, staffAlertDeliveries.subscriptionId))
    .where(and(
      eq(staffPushSubscriptions.employeeKey, employeeKey),
      inArray(staffAlertDeliveries.status, ['failed', 'expired']),
      sql`${staffAlertDeliveries.createdAt} >= ${since}`,
    ))
    .orderBy(desc(staffAlertDeliveries.createdAt))
    .limit(5)
}

// ── One-off test notification (staff-initiated, their own device only) ────────

/**
 * Sends a single confirmation notification to ONE device, on that device owner's explicit tap. It is
 * not queued and never retried — it exists so a person can prove the phone works before relying on it.
 */
export async function sendTestNotification(subscriptionId: string, opts: { config?: PushConfig | null; fetchImpl?: typeof fetch; now?: Date } = {}): Promise<PushOutcome | { status: 'not_configured' }> {
  const cfg = opts.config === undefined ? pushConfig() : opts.config
  if (!cfg) return { status: 'not_configured' }
  const [sub] = await getDb().select().from(staffPushSubscriptions)
    .where(and(eq(staffPushSubscriptions.id, subscriptionId), isNull(staffPushSubscriptions.disabledAt))).limit(1)
  if (!sub) return { status: 'failed', httpStatus: null, error: 'This device is no longer enrolled.' }
  const outcome = await sendPush({
    endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth }, vapid: cfg.vapid, subject: cfg.subject,
    payload: JSON.stringify({ title: 'Pitt Stop notifications are on', body: 'This is a test. New online bookings will arrive like this.', url: '/appointments?view=today', tag: 'staff-alert-test' } satisfies AlertMessage),
    topic: 'staffalerttest', ttl: 600, now: opts.now, fetchImpl: opts.fetchImpl,
  })
  const now = opts.now ?? new Date()
  if (outcome.status === 'sent') await getDb().update(staffPushSubscriptions).set({ lastSuccessAt: now, lastSeenAt: now }).where(eq(staffPushSubscriptions.id, sub.id))
  if (outcome.status === 'expired') await getDb().update(staffPushSubscriptions).set({ disabledAt: now, disabledReason: 'expired', ...CLEARED_KEYS }).where(eq(staffPushSubscriptions.id, sub.id))
  return outcome
}
