/**
 * Unfinished online bookings ("booking leads").
 *
 * CAPTURE: nothing is stored while the customer types. A draft is saved only when they submit the completed
 * contact step with "Continue to review", next to a notice that the details are saved even if they don't finish
 * (SAVE_NOTICE_*). The same browser session re-uses one client key, so going back and forth updates one draft.
 *
 * PERMISSION: a separate, optional, unchecked box (FOLLOW_UP_CONSENT_TEXT) is the only thing that allows the
 * follow-up email. The exact wording, its version and the timestamp are stored. It is unrelated to promotional
 * (SMS marketing) consent, which stays its own optional box.
 *
 * CAPACITY: a draft never holds a time. Availability is computed from `appointments` only; a customer who
 * resumes picks from live availability again.
 *
 * FOLLOW-UP: at most ONE email per draft, only with permission, only when the owner has turned automation on
 * (booking_config.draftFollowUpEnabled), never before draftFollowUpDelayHours since the customer's LAST activity.
 * Claimed with a conditional update (pending → sending) so concurrent runs can't double-send; then a FINAL check on
 * the current row, under a per-email lock, immediately before the provider call: suppressed if the customer booked
 * (this draft or any appointment with the same email/phone since the draft started), withdrew permission, staff
 * closed the lead, or the address already got a follow-up; deferred if the customer was active again. Interrupted
 * workers are recovered without ever risking a second email (see recoverInterruptedFollowUps).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getDb } from '@/platform/db'
import { bookingDrafts, bookingDraftEvents } from './schema'
import { type BookingConfig, isIsoDate, isHHMM, publicBookingOpen, resolveServices } from './policy'
import { validateContact, phoneDigits } from './contact'
import { validateVehicle } from './vehicles'
import { draftToken, hashToken, isTokenShape, resumeUrl } from './tokens'
import { cleanAttribution } from './attribution'
import { BookingError, getBookingConfig, runAtomic } from './db'
import { brandedHtml, transactionalEmailProvider, type TransactionalEmailProvider } from './notify'

export type BookingDraft = typeof bookingDrafts.$inferSelect
export type BookingDraftEvent = typeof bookingDraftEvents.$inferSelect

export const SAVE_NOTICE_VERSION = 'draft-save-v1-2026-10-20'
export const SAVE_NOTICE_TEXT = 'When you continue, Pitt Stop saves these details and your choices so far, even if you don’t finish booking. Your appointment isn’t booked until you confirm on the next step.'
export const FOLLOW_UP_CONSENT_VERSION = 'draft-follow-up-v1-2026-10-20'
export const FOLLOW_UP_CONSENT_TEXT = 'If I don’t finish booking, Pitt Stop may email me to help me schedule.'

export const DRAFT_HOURLY_LIMIT = 20
const MAX_FOLLOW_UP_ATTEMPTS = 3

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : ((r as { rows?: Record<string, unknown>[] })?.rows ?? [])

export const draftInput = z.object({
  draftKey: z.string().trim().min(8).max(80).regex(/^[\w-]+$/),
  serviceKeys: z.array(z.string().max(40)).min(1).max(12),
  vehicleType: z.string().max(16),
  vehicleYear: z.string().max(4),
  vehicleMake: z.string().trim().max(100).default(''),
  vehicleModel: z.string().trim().max(100),
  firstName: z.string().trim().max(120),
  lastName: z.string().trim().max(120),
  phone: z.string().trim().max(40),
  email: z.string().trim().max(240),
  preferredDate: z.string().optional().default(''),
  preferredTime: z.string().optional().default(''),
  notes: z.string().trim().max(2000).default(''),
  followUpConsent: z.boolean().default(false),
  attribution: z.record(z.string(), z.unknown()).default({}),
})
export type DraftInput = z.input<typeof draftInput>

export interface SaveDraftResult { draftId: string; token: string }

/** Save (or update) the draft for this browser session. Called only from "Continue to review". */
export async function saveDraft(raw: DraftInput, opts: { ipHash?: string | null; cfg?: BookingConfig; vehicleFetch?: typeof fetch } = {}): Promise<SaveDraftResult> {
  const parsed = draftInput.safeParse(raw)
  if (!parsed.success) throw new BookingError('invalid', parsed.error.issues[0]?.message ?? 'Check the form and try again.')
  const input = parsed.data
  const cfg = opts.cfg ?? await getBookingConfig()
  if (!publicBookingOpen(cfg)) throw new BookingError('closed', 'Online booking is not available right now. Please call the shop.')

  const contactError = Object.values(validateContact(input))[0]
  if (contactError) throw new BookingError('invalid', contactError)
  const services = resolveServices(cfg, input.serviceKeys, { publicOnly: true })
  if (!services.ok) throw new BookingError('invalid', services.error)
  const make = input.vehicleType === 'trailer' ? 'Trailer' : input.vehicleMake
  const badVehicle = await validateVehicle({ type: input.vehicleType, year: input.vehicleYear, make, model: input.vehicleModel }, { fetchImpl: opts.vehicleFetch })
  if (badVehicle) throw new BookingError('invalid', badVehicle)

  const db = getDb()
  if (opts.ipHash) {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(bookingDrafts)
      .where(and(eq(bookingDrafts.ipHash, opts.ipHash), sql`${bookingDrafts.createdAt} >= now() - interval '1 hour'`))
    if ((r?.n ?? 0) >= DRAFT_HOURLY_LIMIT) throw new BookingError('rate_limited', 'Too many requests from this connection. Please call the shop.')
  }

  // A preferred time is remembered for convenience only — it is NOT held. Unvalidated values are dropped.
  const prefDate = isIsoDate(input.preferredDate) ? input.preferredDate : null
  const prefTime = prefDate && isHHMM(input.preferredTime) ? input.preferredTime : null
  const id = randomUUID()
  const consent = input.followUpConsent
  const email = input.email.trim().toLowerCase()

  const rows = rowsOf(await db.execute(sql`
    INSERT INTO booking_drafts (id, client_key, token_hash, status, first_name, last_name, phone, normalized_phone, email,
      service_keys, service_labels, vehicle_type, vehicle_year, vehicle_make, vehicle_model, preferred_date, preferred_time, notes,
      attribution, save_notice_version, follow_up_consent, follow_up_consent_at, follow_up_consent_text, follow_up_consent_version,
      follow_up_status, ip_hash)
    VALUES (${id}::uuid, ${input.draftKey}, ${hashToken(draftToken(id))}, 'open', ${input.firstName}, ${input.lastName}, ${input.phone},
      ${phoneDigits(input.phone)}, ${email}, ${JSON.stringify(services.services.map((s) => s.key))}::jsonb, ${services.labels},
      ${input.vehicleType}, ${input.vehicleYear}, ${make}, ${input.vehicleModel}, ${prefDate}::date, ${prefTime}, ${input.notes || null},
      ${JSON.stringify(cleanAttribution(input.attribution))}::jsonb, ${SAVE_NOTICE_VERSION}, ${consent},
      ${consent ? sql`now()` : sql`NULL`}, ${consent ? FOLLOW_UP_CONSENT_TEXT : null}, ${consent ? FOLLOW_UP_CONSENT_VERSION : null},
      ${consent ? 'pending' : 'not_permitted'}, ${opts.ipHash ?? null})
    ON CONFLICT (client_key) DO UPDATE SET
      first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, phone = EXCLUDED.phone, normalized_phone = EXCLUDED.normalized_phone,
      email = EXCLUDED.email, service_keys = EXCLUDED.service_keys, service_labels = EXCLUDED.service_labels,
      vehicle_type = EXCLUDED.vehicle_type, vehicle_year = EXCLUDED.vehicle_year, vehicle_make = EXCLUDED.vehicle_make,
      vehicle_model = EXCLUDED.vehicle_model, preferred_date = EXCLUDED.preferred_date, preferred_time = EXCLUDED.preferred_time,
      notes = EXCLUDED.notes, save_notice_version = EXCLUDED.save_notice_version, last_activity_at = now(),
      follow_up_consent = EXCLUDED.follow_up_consent,
      -- Keep the original grant time while permission stays given; record a new one when it is given again.
      follow_up_consent_at = CASE WHEN EXCLUDED.follow_up_consent AND booking_drafts.follow_up_consent THEN booking_drafts.follow_up_consent_at
                                  WHEN EXCLUDED.follow_up_consent THEN now() ELSE NULL END,
      follow_up_consent_text = EXCLUDED.follow_up_consent_text, follow_up_consent_version = EXCLUDED.follow_up_consent_version,
      -- Only an email that has not gone out yet can be switched on or off by the customer.
      follow_up_status = CASE
        WHEN booking_drafts.follow_up_status IN ('not_permitted', 'pending') THEN EXCLUDED.follow_up_status
        WHEN NOT EXCLUDED.follow_up_consent AND booking_drafts.follow_up_status IN ('not_configured', 'failed') THEN 'not_permitted'
        ELSE booking_drafts.follow_up_status END
    WHERE booking_drafts.status = 'open'
    RETURNING id, (xmax = 0) AS inserted, follow_up_status`))

  const row = rows[0]
  if (!row) throw new BookingError('conflict', 'This booking was already completed. Start a new booking to choose another time.')
  const draftId = String(row.id)
  await db.insert(bookingDraftEvents).values({
    draftId, eventType: row.inserted ? 'saved' : 'updated', actor: 'customer',
    meta: { followUpConsent: consent, followUpConsentVersion: consent ? FOLLOW_UP_CONSENT_VERSION : null, saveNoticeVersion: SAVE_NOTICE_VERSION, followUpStatus: row.follow_up_status },
  })
  return { draftId, token: draftToken(draftId) }
}

export async function getDraftByToken(token: string): Promise<BookingDraft | null> {
  if (!isTokenShape(token)) return null
  const [row] = await getDb().select().from(bookingDrafts).where(eq(bookingDrafts.tokenHash, hashToken(token))).limit(1)
  return row ?? null
}

/** The customer opened their resume link. Counts as activity (pushes a pending follow-up back). */
export async function recordResume(draftId: string): Promise<void> {
  const db = getDb()
  const [u] = await db.update(bookingDrafts).set({ lastActivityAt: new Date() })
    .where(and(eq(bookingDrafts.id, draftId), eq(bookingDrafts.status, 'open'))).returning({ id: bookingDrafts.id })
  if (u) await db.insert(bookingDraftEvents).values({ draftId, eventType: 'resumed', actor: 'customer', meta: {} })
}

// ── Staff ─────────────────────────────────────────────────────────────────────

export const STAFF_STATUSES = ['new', 'contacted', 'closed'] as const
export type StaffStatus = (typeof STAFF_STATUSES)[number]

/** follow_up_error recorded when staff close a lead; closing is final for the automatic email (reopening does not resume it). */
export const LEAD_CLOSED = 'lead closed by staff'

export async function listDrafts(opts: { view: 'open' | 'booked' | 'all'; limit?: number }): Promise<BookingDraft[]> {
  const db = getDb()
  const where = opts.view === 'open' ? eq(bookingDrafts.status, 'open')
    : opts.view === 'booked' ? eq(bookingDrafts.status, 'booked')
    : inArray(bookingDrafts.status, ['open', 'booked', 'purged'])
  return db.select().from(bookingDrafts).where(where).orderBy(desc(bookingDrafts.lastActivityAt)).limit(opts.limit ?? 200)
}

export async function getDraft(id: string): Promise<BookingDraft | null> {
  if (!z.uuid().safeParse(id).success) return null
  const [row] = await getDb().select().from(bookingDrafts).where(eq(bookingDrafts.id, id)).limit(1)
  return row ?? null
}

export async function listDraftEvents(draftId: string): Promise<BookingDraftEvent[]> {
  return getDb().select().from(bookingDraftEvents).where(eq(bookingDraftEvents.draftId, draftId)).orderBy(bookingDraftEvents.createdAt)
}

/**
 * Staff status. "Closed" also suppresses any automatic follow-up that has not gone out (pending / not set up /
 * failed) in the SAME statement, so no worker can pick it up afterwards; a send already claimed is stopped by the
 * final check in dispatchDraftFollowUps. Both changes are written to the append-only history.
 */
export async function setDraftStaffStatus(id: string, status: StaffStatus, actor: string): Promise<void> {
  if (!z.uuid().safeParse(id).success || !STAFF_STATUSES.includes(status)) throw new BookingError('invalid', 'Choose a valid status.')
  const closing = status === 'closed'
  const rows = rowsOf(await getDb().execute(sql`
    WITH prev AS (SELECT id, staff_status, follow_up_status FROM booking_drafts WHERE id = ${id}::uuid FOR UPDATE)
    UPDATE booking_drafts d SET staff_status = ${status}, staff_status_by = ${actor}, staff_status_at = now(),
      follow_up_status = CASE WHEN ${closing} AND prev.follow_up_status IN ('pending', 'not_configured', 'failed') THEN 'suppressed' ELSE d.follow_up_status END,
      follow_up_error  = CASE WHEN ${closing} AND prev.follow_up_status IN ('pending', 'not_configured', 'failed') THEN ${LEAD_CLOSED} ELSE d.follow_up_error END
    FROM prev WHERE d.id = prev.id
    RETURNING prev.staff_status AS staff_before, prev.follow_up_status AS follow_up_before, d.follow_up_status AS follow_up_after`))
  const r = rows[0]
  if (!r) throw new BookingError('not_found', 'Lead not found.')
  const events: (typeof bookingDraftEvents.$inferInsert)[] = [{ draftId: id, eventType: 'staff_status', actor, meta: { status, from: r.staff_before } }]
  if (r.follow_up_before !== r.follow_up_after) {
    events.push({ draftId: id, eventType: 'follow_up_suppressed', actor, meta: { reason: LEAD_CLOSED, from: r.follow_up_before } })
  }
  await getDb().insert(bookingDraftEvents).values(events)
}

// ── Follow-up email ───────────────────────────────────────────────────────────

export function renderDraftFollowUp(d: Pick<BookingDraft, 'firstName' | 'serviceLabels'>, cfg: Pick<BookingConfig, 'phone' | 'address'>, link: string): { subject: string; text: string; html: string } {
  const hi = d.firstName ? `Hi ${d.firstName},` : 'Hi,'
  const intro = `${hi} you started booking a drop-off with Pitt Stop Detail & Auto Sales${d.serviceLabels ? ` (${d.serviceLabels})` : ''} but didn’t finish. No appointment is booked yet.`
  const how = 'Your answers are saved. Open the link to pick a drop-off time from what is open now — the time you looked at before may have been taken.'
  const why = 'You asked us to email you if you didn’t finish booking. This is the only reminder we will send about it.'
  return {
    subject: 'Finish booking your Pitt Stop drop-off',
    text: `${intro}\n\n${how}\n\nFinish booking: ${link}\n\nQuestions? Call ${cfg.phone}.\n\n${why}\n\n— Pitt Stop Detail & Auto Sales\n${cfg.address}`,
    html: brandedHtml({
      preheader: 'No appointment is booked yet. Your answers are saved.',
      heading: 'Finish booking your drop-off', intro, note: how,
      button: { label: 'Choose a drop-off time', href: link }, footnote: why, cfg,
    }),
  }
}

/** A claim older than this was left by an interrupted worker (the cron function itself is limited to 60 s). */
export const STALE_CLAIM_MINUTES = 15

/** Conditions a follow-up must meet at the moment it is cleared to send — evaluated on the CURRENT row `d`. */
const eligibleNow = (dueBefore: Date) => sql`
  d.status = 'open' AND d.staff_status <> 'closed' AND d.follow_up_consent AND d.email IS NOT NULL AND d.purged_at IS NULL
  AND d.last_activity_at <= ${dueBefore.toISOString()}::timestamptz
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.created_at >= d.created_at
    AND (lower(a.email) = d.email OR (coalesce(d.normalized_phone, '') <> '' AND a.normalized_phone = d.normalized_phone)))
  AND NOT EXISTS (SELECT 1 FROM booking_drafts o WHERE o.id <> d.id AND o.email = d.email
    AND (o.follow_up_status IN ('sent', 'uncertain') OR (o.follow_up_status = 'sending' AND o.follow_up_cleared_at IS NOT NULL)))`

type Cleared = { firstName: string | null; serviceLabels: string; email: string }
type Hold = { followUpStatus: string; reason: string }

/**
 * The final check, immediately before the provider is called. Runs in one transaction holding a per-email
 * advisory lock, against the CURRENT row (not the claimed snapshot), and only for the claim this worker owns
 * (status 'sending' with the attempt number it set). Passing stamps follow_up_cleared_at — from then on the
 * send is treated as possibly delivered. The lock serialises two drafts for the same address, so only the
 * first can be cleared; the other sees it and is suppressed.
 */
async function clearForSending(claimed: BookingDraft, dueBefore: Date): Promise<{ ok: true; row: Cleared } | { ok: false; hold: Hold }> {
  const [, rows] = await runAtomic([
    sql`SELECT pg_advisory_xact_lock(hashtext(${`booking-draft-follow-up:${claimed.email}`}))`,
    sql`UPDATE booking_drafts d SET follow_up_cleared_at = now()
        WHERE d.id = ${claimed.id}::uuid AND d.follow_up_status = 'sending' AND d.follow_up_attempts = ${claimed.followUpAttempts}
          AND d.email = ${claimed.email} AND ${eligibleNow(dueBefore)}
        RETURNING d.first_name, d.service_labels, d.email`,
  ])
  const ok = rows[0]
  if (ok) return { ok: true, row: { firstName: (ok.first_name as string | null) ?? null, serviceLabels: String(ok.service_labels ?? ''), email: String(ok.email) } }

  // Not cleared: work out why (for staff and the tally). Nothing here can lead to a send.
  const [w] = rowsOf(await getDb().execute(sql`
    SELECT d.status, d.staff_status, d.follow_up_consent, d.email, d.follow_up_status, d.follow_up_attempts,
      d.last_activity_at > ${dueBefore.toISOString()}::timestamptz AS active_again,
      EXISTS (SELECT 1 FROM appointments a WHERE a.created_at >= d.created_at
        AND (lower(a.email) = d.email OR (coalesce(d.normalized_phone, '') <> '' AND a.normalized_phone = d.normalized_phone))) AS booked,
      EXISTS (SELECT 1 FROM booking_drafts o WHERE o.id <> d.id AND o.email = d.email
        AND (o.follow_up_status IN ('sent', 'uncertain') OR (o.follow_up_status = 'sending' AND o.follow_up_cleared_at IS NOT NULL))) AS emailed
    FROM booking_drafts d WHERE d.id = ${claimed.id}::uuid`))
  if (!w || w.follow_up_status !== 'sending' || Number(w.follow_up_attempts) !== claimed.followUpAttempts) return { ok: false, hold: { followUpStatus: '', reason: 'claim no longer held' } }
  if (w.status !== 'open' || w.booked) return { ok: false, hold: { followUpStatus: 'suppressed', reason: 'customer has booked' } }
  if (w.staff_status === 'closed') return { ok: false, hold: { followUpStatus: 'suppressed', reason: LEAD_CLOSED } }
  if (!w.follow_up_consent) return { ok: false, hold: { followUpStatus: 'not_permitted', reason: 'permission withdrawn' } }
  if (!w.email) return { ok: false, hold: { followUpStatus: 'suppressed', reason: 'no email address' } }
  if (w.emailed) return { ok: false, hold: { followUpStatus: 'suppressed', reason: 'already sent a follow-up' } }
  // The customer came back (or changed their details) after the claim: wait a full delay from that activity.
  if (w.active_again || w.email !== claimed.email) return { ok: false, hold: { followUpStatus: 'pending', reason: 'customer active again' } }
  return { ok: false, hold: { followUpStatus: 'pending', reason: 'not eligible yet' } }
}

/**
 * Recover claims left 'sending' by an interrupted worker (crash, timeout, deploy). Bounded and duplicate-safe:
 *  • never cleared → the provider was provably never called → back to 'pending' (or 'failed' after the attempt cap);
 *  • cleared → it may have been sent → 'uncertain', which is NEVER retried automatically (staff can see it).
 */
export async function recoverInterruptedFollowUps(opts: { now?: Date } = {}): Promise<number> {
  const stale = new Date((opts.now ?? new Date()).getTime() - STALE_CLAIM_MINUTES * 60_000)
  const rows = rowsOf(await getDb().execute(sql`WITH r AS (
      UPDATE booking_drafts SET
        follow_up_status = CASE WHEN follow_up_cleared_at IS NOT NULL THEN 'uncertain'
                                WHEN follow_up_attempts < ${MAX_FOLLOW_UP_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
        follow_up_error  = CASE WHEN follow_up_cleared_at IS NOT NULL THEN 'Interrupted after sending started — it may have been delivered, so it is not retried.'
                                ELSE 'Interrupted before sending.' END
      WHERE follow_up_status = 'sending'
        -- No claim time = left by older code or a manual edit; never cleared either, so treated as stale.
        AND (follow_up_claimed_at IS NULL OR follow_up_claimed_at < ${stale.toISOString()}::timestamptz)
      RETURNING id, follow_up_status
    ), ev AS (
      INSERT INTO booking_draft_events (draft_id, event_type, actor, meta)
      SELECT id, 'follow_up_recovered', 'system', jsonb_build_object('to', follow_up_status) FROM r
    ) SELECT count(*)::int AS n FROM r`))
  return Number(rows[0]?.n ?? 0)
}

export interface FollowUpTally { enabled: boolean; sent: number; notConfigured: number; failed: number; uncertain: number; suppressed: number; deferred: number; recovered: number }

export async function dispatchDraftFollowUps(opts: {
  now?: Date; limit?: number; provider?: TransactionalEmailProvider; cfg?: BookingConfig
  /** Test seam: runs after a draft is claimed and before the final check (simulates a concurrent change). */
  onClaimed?: (draftId: string) => Promise<void>
} = {}): Promise<FollowUpTally> {
  const cfg = opts.cfg ?? await getBookingConfig()
  const tally: FollowUpTally = { enabled: cfg.draftFollowUpEnabled, sent: 0, notConfigured: 0, failed: 0, uncertain: 0, suppressed: 0, deferred: 0, recovered: 0 }
  if (!cfg.draftFollowUpEnabled) return tally
  const db = getDb()
  const now = opts.now ?? new Date()
  tally.recovered = await recoverInterruptedFollowUps({ now })
  const provider = opts.provider ?? transactionalEmailProvider()
  // Never early: due only once the full delay has passed since the customer's LAST activity.
  const dueBefore = new Date(now.getTime() - cfg.draftFollowUpDelayHours * 3_600_000)
  // Never email a draft that retention is about to erase.
  const keepAfter = cfg.draftRetentionEnabled ? new Date(now.getTime() - cfg.draftRetentionDays * 24 * 3_600_000) : null
  const selectable = and(
    eq(bookingDrafts.status, 'open'), eq(bookingDrafts.followUpStatus, 'pending'), eq(bookingDrafts.followUpConsent, true),
    sql`${bookingDrafts.staffStatus} <> 'closed'`, sql`${bookingDrafts.email} IS NOT NULL`,
    sql`${bookingDrafts.lastActivityAt} <= ${dueBefore.toISOString()}::timestamptz`,
    keepAfter ? sql`${bookingDrafts.lastActivityAt} > ${keepAfter.toISOString()}::timestamptz` : undefined,
  )
  const due = await db.select({ id: bookingDrafts.id }).from(bookingDrafts).where(selectable)
    .orderBy(bookingDrafts.lastActivityAt).limit(opts.limit ?? 50)

  for (const { id } of due) {
    // Claim: pending → sending, conditional on the same eligibility, so concurrent runs can't both claim.
    const [claimed] = await db.update(bookingDrafts).set({
      followUpStatus: 'sending', followUpAttempts: sql`${bookingDrafts.followUpAttempts} + 1`,
      followUpClaimedAt: now, followUpClearedAt: null,
    }).where(and(eq(bookingDrafts.id, id), selectable)).returning()
    if (!claimed) continue
    if (opts.onClaimed) await opts.onClaimed(id)

    const check = await clearForSending(claimed, dueBefore)
    if (!check.ok) {
      const { followUpStatus, reason } = check.hold
      if (!followUpStatus) continue // someone else now owns this row
      await db.update(bookingDrafts).set({ followUpStatus, followUpError: reason })
        .where(and(eq(bookingDrafts.id, id), eq(bookingDrafts.followUpStatus, 'sending'), eq(bookingDrafts.followUpAttempts, claimed.followUpAttempts)))
      await db.insert(bookingDraftEvents).values({ draftId: id, eventType: followUpStatus === 'pending' ? 'follow_up_deferred' : 'follow_up_suppressed', actor: 'system', meta: { reason } })
      if (followUpStatus === 'pending') tally.deferred++
      else tally.suppressed++
      continue
    }

    // Render from the row as it was when cleared (current details), never the claim-time snapshot.
    const msg = renderDraftFollowUp(check.row, cfg, resumeUrl(id))
    const res = await provider.send({ to: check.row.email, subject: msg.subject, text: msg.text, html: msg.html })
    const mine = and(eq(bookingDrafts.id, id), inArray(bookingDrafts.followUpStatus, ['sending', 'uncertain']), eq(bookingDrafts.followUpAttempts, claimed.followUpAttempts))
    let after: { consent: boolean; staffStatus: string; status: string } | undefined
    if (res.status === 'sent') {
      ;[after] = await db.update(bookingDrafts).set({ followUpStatus: 'sent', followUpSentAt: new Date(), followUpProvider: provider.name, followUpMessageId: res.providerMessageId, followUpError: null })
        .where(mine).returning({ consent: bookingDrafts.followUpConsent, staffStatus: bookingDrafts.staffStatus, status: bookingDrafts.status })
      tally.sent++
    } else if (res.status === 'blocked') {
      await db.update(bookingDrafts).set({ followUpStatus: 'suppressed', followUpProvider: provider.name, followUpError: res.reason }).where(mine)
      tally.suppressed++
    } else if (res.status === 'not_configured') {
      await db.update(bookingDrafts).set({ followUpStatus: 'not_configured', followUpProvider: provider.name, followUpError: 'No transactional email provider is configured.' }).where(mine)
      tally.notConfigured++
    } else if (res.status === 'uncertain') {
      // It may have been delivered: never retried, never re-queueable, and it blocks other drafts for this address.
      await db.update(bookingDrafts).set({ followUpStatus: 'uncertain', followUpProvider: provider.name, followUpError: res.error }).where(mine)
      tally.uncertain++
    } else {
      // Definitely not delivered: retry a temporary failure; a permanent rejection waits for staff.
      const retry = res.retryable !== false && claimed.followUpAttempts < MAX_FOLLOW_UP_ATTEMPTS
      await db.update(bookingDrafts).set({ followUpStatus: retry ? 'pending' : 'failed', followUpProvider: provider.name, followUpError: res.error }).where(mine)
      tally.failed++
    }
    await db.insert(bookingDraftEvents).values({ draftId: id, eventType: `follow_up_${res.status}`, actor: 'system', meta: { provider: provider.name } })
    // A change that landed while the provider call was in flight can't un-send the email, but it is never silent.
    if (after && (!after.consent || after.staffStatus === 'closed' || after.status !== 'open')) {
      await db.insert(bookingDraftEvents).values({ draftId: id, eventType: 'follow_up_raced_change', actor: 'system',
        meta: { permissionWithdrawn: !after.consent, leadClosed: after.staffStatus === 'closed', booked: after.status === 'booked' } })
    }
  }
  return tally
}

/**
 * Erase contact details from drafts idle longer than the retention period (only when the owner turns it on).
 * Interrupted sends are recovered first, so a stuck 'sending' row can delay erasure by at most one run; only a
 * claim younger than STALE_CLAIM_MINUTES is skipped. Appointments are never touched — only the draft's copy.
 */
export async function purgeExpiredDrafts(opts: { now?: Date; cfg?: BookingConfig } = {}): Promise<{ enabled: boolean; purged: number; recovered: number }> {
  const cfg = opts.cfg ?? await getBookingConfig()
  if (!cfg.draftRetentionEnabled) return { enabled: false, purged: 0, recovered: 0 }
  const now = opts.now ?? new Date()
  const recovered = await recoverInterruptedFollowUps({ now })
  const cutoff = new Date(now.getTime() - cfg.draftRetentionDays * 24 * 3_600_000)
  const rows = rowsOf(await getDb().execute(sql`WITH p AS (
      UPDATE booking_drafts SET first_name = NULL, last_name = NULL, phone = NULL, normalized_phone = NULL, email = NULL, notes = NULL,
        ip_hash = NULL, attribution = '{}'::jsonb, purged_at = now(),
        status = CASE WHEN status = 'open' THEN 'purged' ELSE status END,
        follow_up_status = CASE WHEN follow_up_status IN ('pending', 'not_configured', 'failed') THEN 'suppressed' ELSE follow_up_status END
      WHERE purged_at IS NULL AND last_activity_at < ${cutoff.toISOString()}::timestamptz AND follow_up_status <> 'sending'
      RETURNING id
    ), ev AS (
      INSERT INTO booking_draft_events (draft_id, event_type, actor, meta) SELECT id, 'purged', 'system', ${JSON.stringify({ retentionDays: cfg.draftRetentionDays })}::jsonb FROM p
    ) SELECT count(*)::int AS n FROM p`))
  return { enabled: true, purged: Number(rows[0]?.n ?? 0), recovered }
}

/**
 * Staff "send again" after a provider is set up: only a not-set-up / definitely-failed email on an open, permitted,
 * NOT closed lead, and only while no draft for that address was sent, is uncertain ("may have been delivered") or is
 * mid-send. An 'uncertain' email itself can never be re-queued.
 */
export async function requeueDraftFollowUp(id: string, actor: string): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false
  const db = getDb()
  const [u] = await db.update(bookingDrafts).set({ followUpStatus: 'pending', followUpError: null })
    .where(and(eq(bookingDrafts.id, id), eq(bookingDrafts.status, 'open'), eq(bookingDrafts.followUpConsent, true),
      sql`${bookingDrafts.staffStatus} <> 'closed'`, sql`${bookingDrafts.followUpStatus} IN ('not_configured', 'failed')`,
      sql`NOT EXISTS (SELECT 1 FROM booking_drafts o WHERE o.id <> ${bookingDrafts.id} AND o.email = ${bookingDrafts.email}
        AND (o.follow_up_status IN ('sent', 'uncertain') OR (o.follow_up_status = 'sending' AND o.follow_up_cleared_at IS NOT NULL)))`))
    .returning({ id: bookingDrafts.id })
  if (u) await db.insert(bookingDraftEvents).values({ draftId: id, eventType: 'follow_up_requeued', actor, meta: {} })
  return !!u
}

export async function countOpenDrafts(): Promise<number> {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(bookingDrafts)
    .where(and(eq(bookingDrafts.status, 'open'), eq(bookingDrafts.staffStatus, 'new')))
  return r?.n ?? 0
}
