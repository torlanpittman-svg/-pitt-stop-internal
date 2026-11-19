'use server'

/**
 * Staff appointment actions. proxy.ts gates /appointments behind the employee PIN session; every action
 * re-verifies server-side. Employees: view, enter phone/walk-in bookings within the normal rules, check
 * in, mark no-show, add notes. Managers/admins additionally: reschedule, cancel, capacity/window
 * override, settings and closures.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { authenticatedActor, authorizedManager, authorizedManagerStrict, employeeAuthorized, isManagerRole } from '@/apps/auth/employee-guard'
import { setDraftStaffStatus, requeueDraftFollowUp, STAFF_STATUSES, type StaffStatus } from '@/apps/appointments/drafts'
import {
  createAppointment, cancelAppointment, markNoShow, rescheduleAppointment, acknowledgeAppointments, addInternalNote,
  addBlock, removeBlock, declineEstimate, getAvailability, getBookingConfig, saveBookingConfig, BookingError, APPOINTMENT_SOURCES,
  type AppointmentSource, type BookingInput, type DeclineLeadOutcome,
} from '@/apps/appointments/db'
import { checkInAppointment, type VehicleChoice } from '@/apps/appointments/checkin'
import { dispatchDue, requeueNotification } from '@/apps/appointments/notify'
import { mergeBookingConfig, WEEKDAYS, type BookingConfig, type DayView } from '@/apps/appointments/policy'
import {
  enrollManually, recordManagerEmailConsent, startSequence, pauseSequence, resumeSequence, stopSequence, setStaffOutcome, sendNextNow, reviewRebookMatch,
  STAFF_OUTCOMES, type StaffOutcome,
} from '@/apps/appointments/recovery'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The staff's answer to "which vehicle is here?" — only a saved-vehicle id or an explicit "new vehicle"; anything else is no choice. */
function vehicleChoice(c?: { vehicleId?: string | null; newVehicle?: boolean } | null): VehicleChoice | null {
  if (c?.vehicleId && UUID.test(c.vehicleId)) return { vehicleId: c.vehicleId }
  if (c?.newVehicle === true) return { newVehicle: true }
  return null
}

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string }

async function staff(): Promise<{ name: string; manager: boolean }> {
  if (!(await employeeAuthorized())) throw new BookingError('conflict', 'Sign in required.')
  const actor = await authenticatedActor()
  const mgr = await authorizedManager()
  return { name: actor?.name ?? mgr?.name ?? 'Employee', manager: !!mgr || isManagerRole(actor?.role) }
}
async function manager(): Promise<string> {
  const m = await authorizedManager()
  if (!m) throw new BookingError('conflict', 'Managers and admins only.')
  return m.name
}
const fail = (e: unknown): ActionResult => {
  if (e instanceof BookingError) return { ok: false, error: e.message }
  console.error('[appointments] action failed:', e)
  return { ok: false, error: e instanceof Error ? e.message : 'Something went wrong.' }
}
const dispatchLater = (id: string) => after(() => dispatchDue({ appointmentId: id }).catch((err) => console.error('[appointments] dispatch failed:', err)))

export async function staffAvailability(date: string, serviceKeys: string[], excludeId: string | null = null): Promise<DayView | null> {
  await staff()
  const cfg = await getBookingConfig()
  const { days } = await getAvailability({ cfg: { ...cfg, sameDayLeadMinutes: 0, maxAdvanceDays: 365, sameDayEnabled: true }, serviceKeys, fromDate: date, days: 1, publicOnly: false, excludeId })
  return days[0] ?? null
}

export async function createStaffAppointment(input: BookingInput & { source: string; override?: boolean }): Promise<ActionResult> {
  try {
    const who = await staff()
    // Crediting a Lead Recovery rebooking is manager-only, like the queue itself; anyone else's value is dropped.
    if (input.recoveryId && !(await authorizedManagerStrict())) input = { ...input, recoveryId: undefined }
    const source = (APPOINTMENT_SOURCES as readonly string[]).includes(input.source) ? input.source as AppointmentSource : 'phone'
    if (input.override && !who.manager) return { ok: false, error: 'Only a manager can override the booking rules.' }
    const { appointment } = await createAppointment(input, { mode: 'staff', source, actor: who.name, override: !!input.override })
    dispatchLater(appointment.id)
    revalidatePath('/appointments')
    return { ok: true, id: appointment.id }
  } catch (e) { return fail(e) }
}

export async function checkInAction(id: string, choice?: { vehicleId?: string | null; newVehicle?: boolean } | null): Promise<ActionResult> {
  let orderId: string
  try {
    const who = await staff()
    orderId = (await checkInAppointment(id, who.name, vehicleChoice(choice))).serviceOrderId
  } catch (e) { return fail(e) }
  revalidatePath('/appointments')
  redirect(`/orders/${orderId}`)
}

export async function noShowAction(id: string): Promise<ActionResult> {
  try { const who = await staff(); await markNoShow(id, who.name); revalidatePath('/appointments'); return { ok: true } } catch (e) { return fail(e) }
}

export async function cancelAction(id: string, reason: string, initiator: 'customer' | 'shop' | null = null): Promise<ActionResult> {
  try {
    const name = await manager()
    await cancelAppointment(id, { actor: name, by: 'staff', reason: reason.slice(0, 300) || null, initiator: initiator === 'customer' || initiator === 'shop' ? initiator : null })
    dispatchLater(id); revalidatePath('/appointments'); return { ok: true }
  } catch (e) { return fail(e) }
}

export type DeclineActionResult = { ok: true; lead: DeclineLeadOutcome } | { ok: false; error: string }

/**
 * "Attended — estimate declined" (managers/admins): the customer came in, got an estimate and said no.
 * Marks the appointment declined and the linked marketing lead Lost in one transaction. Creates no Job,
 * no invoice, and NEVER an email — no dispatch is triggered (the decline statement itself retires the
 * appointment's pending notices).
 */
export async function declineEstimateAction(id: string, reason: string): Promise<DeclineActionResult> {
  try {
    const name = await manager()
    // A server action is a public endpoint: validate the raw argument types, not just their shapes.
    if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: 'Invalid appointment.' }
    if (typeof reason !== 'string') return { ok: false, error: 'Invalid reason.' }
    const trimmed = reason.trim()
    if (trimmed.length > 300) return { ok: false, error: 'Keep the reason under 300 characters.' }
    const { lead } = await declineEstimate(id, { actor: name, reason: trimmed || null })
    revalidatePath('/appointments'); revalidatePath(`/appointments/${id}`)
    revalidatePath('/marketing/leads'); revalidatePath('/marketing/report'); revalidatePath('/marketing')
    return { ok: true, lead }
  } catch (e) {
    const f = fail(e)
    return { ok: false, error: f.ok ? 'Something went wrong.' : f.error }
  }
}

export async function rescheduleAction(id: string, date: string, time: string, override: boolean): Promise<ActionResult> {
  try {
    const name = await manager()
    await rescheduleAppointment(id, { date, time }, { actor: name, override })
    dispatchLater(id); revalidatePath('/appointments'); return { ok: true }
  } catch (e) { return fail(e) }
}

export async function acknowledgeAction(ids: string[]): Promise<ActionResult> {
  try { const who = await staff(); await acknowledgeAppointments(ids, who.name); revalidatePath('/appointments'); return { ok: true } } catch (e) { return fail(e) }
}

export async function noteAction(id: string, note: string): Promise<ActionResult> {
  try { const who = await staff(); await addInternalNote(id, note, who.name); revalidatePath(`/appointments/${id}`); return { ok: true } } catch (e) { return fail(e) }
}

export async function requeueAction(notificationId: string, appointmentId: string): Promise<ActionResult> {
  try { await manager(); await requeueNotification(notificationId); dispatchLater(appointmentId); revalidatePath(`/appointments/${appointmentId}`); return { ok: true } } catch (e) { return fail(e) }
}

/**
 * Run this appointment's due notices now. For a notice HELD by a test-mode allowlist there is nothing to
 * re-queue — it is already pending and already due — it simply needs a dispatcher, and the only automatic
 * one is the daily cron. Without this, lifting the allowlist left a real customer's confirmation waiting up
 * to a day, long enough for a next-morning drop-off to pass and the notice to be abandoned.
 */
export async function dispatchNowAction(appointmentId: string): Promise<ActionResult> {
  try { await manager(); dispatchLater(appointmentId); revalidatePath(`/appointments/${appointmentId}`); return { ok: true } } catch (e) { return fail(e) }
}

const num = (v: FormDataEntryValue | null) => (v == null || String(v).trim() === '' ? null : Number(v))

export async function saveSettingsAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const name = await manager()
    const cur = await getBookingConfig()
    const days = Object.fromEntries(WEEKDAYS.map((w) => [w, {
      open: form.get(`day_${w}_open`) === 'on',
      start: String(form.get(`day_${w}_start`) ?? cur.days[w].start),
      cutoff: String(form.get(`day_${w}_cutoff`) ?? cur.days[w].cutoff),
    }]))
    const services = cur.services.map((s) => ({
      ...s, enabled: form.get(`svc_${s.key}_enabled`) === 'on',
      weight: Number(form.get(`svc_${s.key}_weight`) ?? s.weight),
      // Customer-facing name; the key (stored on appointments, used in website links) never changes.
      label: String(form.get(`svc_${s.key}_label`) ?? s.label).trim().slice(0, 80) || s.label,
      description: String(form.get(`svc_${s.key}_description`) ?? s.description).trim().slice(0, 240),
    }))
    const next: BookingConfig = mergeBookingConfig({
      ...cur,
      enabled: form.get('enabled') === 'on',
      intervalMinutes: Number(form.get('intervalMinutes') ?? cur.intervalMinutes),
      sameDayEnabled: form.get('sameDayEnabled') === 'on',
      sameDayLeadMinutes: Number(form.get('sameDayLeadMinutes') ?? cur.sameDayLeadMinutes),
      maxAdvanceDays: Number(form.get('maxAdvanceDays') ?? cur.maxAdvanceDays),
      federalHolidaysClosed: form.get('federalHolidaysClosed') === 'on',
      slotCapacity: num(form.get('slotCapacity')),
      dailyAppointmentLimit: num(form.get('dailyAppointmentLimit')),
      workloadLimitsEnabled: form.get('workloadLimitsEnabled') === 'on',
      dailyUnits: num(form.get('dailyUnits')),
      categoryLimits: { detail: num(form.get('limitDetail')), mechanic: num(form.get('limitMechanic')) },
      cancelCutoffMinutes: Number(form.get('cancelCutoffMinutes') ?? cur.cancelCutoffMinutes),
      confirmationEnabled: form.get('confirmationEnabled') === 'on',
      reminderEnabled: form.get('reminderEnabled') === 'on',
      reminderHoursBefore: Number(form.get('reminderHoursBefore') ?? cur.reminderHoursBefore),
      title: String(form.get('title') ?? cur.title), intro: String(form.get('intro') ?? cur.intro),
      phone: String(form.get('phone') ?? cur.phone), address: String(form.get('address') ?? cur.address),
      instructions: String(form.get('instructions') ?? cur.instructions), cancellationPolicy: String(form.get('cancellationPolicy') ?? cur.cancellationPolicy),
      days, services,
      draftFollowUpEnabled: form.get('draftFollowUpEnabled') === 'on',
      draftFollowUpDelayHours: Number(form.get('draftFollowUpDelayHours') ?? cur.draftFollowUpDelayHours),
      draftRetentionEnabled: form.get('draftRetentionEnabled') === 'on',
      draftRetentionDays: Number(form.get('draftRetentionDays') ?? cur.draftRetentionDays),
      recoveryEmailsEnabled: form.get('recoveryEmailsEnabled') === 'on',
      recoveryAutoStart: form.get('recoveryAutoStart') === 'on',
      recoveryDelayHours: [0, 1, 2].map((i) => Number(form.get(`recoveryDelayHours${i + 1}`) ?? cur.recoveryDelayHours[i])) as [number, number, number],
      recoverySendStartHour: Number(form.get('recoverySendStartHour') ?? cur.recoverySendStartHour),
      recoverySendEndHour: Number(form.get('recoverySendEndHour') ?? cur.recoverySendEndHour),
      recoveryLinkDays: Number(form.get('recoveryLinkDays') ?? cur.recoveryLinkDays),
    })
    await saveBookingConfig(next, name)
    revalidatePath('/appointments'); revalidatePath('/book'); revalidatePath('/appointments/leads'); revalidatePath('/appointments/recovery')
    return { ok: true }
  } catch (e) { return fail(e) }
}

export async function addBlockAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const name = await manager()
    await addBlock({ kind: form.get('kind') === 'open' ? 'open' : 'close', date: String(form.get('date') ?? ''), time: String(form.get('time') ?? '') || null, reason: String(form.get('reason') ?? '') }, name)
    revalidatePath('/appointments/settings')
    return { ok: true }
  } catch (e) { return fail(e) }
}

export async function removeBlockAction(id: string): Promise<ActionResult> {
  try { const name = await manager(); await removeBlock(id, name); revalidatePath('/appointments/settings'); return { ok: true } } catch (e) { return fail(e) }
}

// ── Unfinished online bookings (leads) — managers/admins only, fail-closed ────

async function leadManager(): Promise<string> {
  const m = await authorizedManagerStrict()
  if (!m) throw new BookingError('conflict', 'Managers and admins only.')
  return m.name
}

export async function setLeadStatusAction(id: string, status: string): Promise<ActionResult> {
  try {
    const name = await leadManager()
    if (!(STAFF_STATUSES as readonly string[]).includes(status)) return { ok: false, error: 'Choose a valid status.' }
    await setDraftStaffStatus(id, status as StaffStatus, name)
    revalidatePath('/appointments/leads'); return { ok: true }
  } catch (e) { return fail(e) }
}

export async function requeueLeadFollowUpAction(id: string): Promise<ActionResult> {
  try {
    const name = await leadManager()
    if (!(await requeueDraftFollowUp(id, name))) return { ok: false, error: 'This email can’t be queued again (closed lead, no permission, already handled, or booked).' }
    revalidatePath('/appointments/leads'); return { ok: true }
  } catch (e) { return fail(e) }
}

// ── Lead Recovery (cancelled appointments) — managers/admins only, fail-closed ─

/** One wrapper for every recovery action: strict manager check, typed-argument check, uniform errors + refresh. */
async function recoveryAction(id: unknown, run: (id: string, name: string) => Promise<unknown>): Promise<ActionResult> {
  try {
    const name = await leadManager()
    if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: 'Invalid record.' }
    await run(id, name)
    revalidatePath('/appointments/recovery'); revalidatePath('/appointments'); revalidatePath('/marketing/report')
    return { ok: true }
  } catch (e) { return fail(e) }
}

/** Add an older (or Pitt Stop-cancelled) cancellation to the queue. Never starts emails. `id` = the appointment. */
export async function recoveryEnrollAction(appointmentId: string): Promise<ActionResult> {
  return recoveryAction(appointmentId, (id, name) => enrollManually(id, name))
}
export async function recoveryStartAction(id: string): Promise<ActionResult> {
  return recoveryAction(id, (rid, name) => startSequence(rid, name))
}
export async function recoveryPauseAction(id: string): Promise<ActionResult> {
  return recoveryAction(id, async (rid, name) => { if (!(await pauseSequence(rid, name))) throw new BookingError('conflict', 'Only running follow-ups can be paused.') })
}
export async function recoveryResumeAction(id: string): Promise<ActionResult> {
  return recoveryAction(id, (rid, name) => resumeSequence(rid, name))
}
export async function recoveryStopAction(id: string): Promise<ActionResult> {
  return recoveryAction(id, async (rid, name) => { if (!(await stopSequence(rid, name, 'Stopped by staff.'))) throw new BookingError('conflict', 'This lead is already closed or rebooked.') })
}
export async function recoveryOutcomeAction(id: string, outcome: string): Promise<ActionResult> {
  if (!(STAFF_OUTCOMES as readonly string[]).includes(outcome)) return { ok: false, error: 'Choose a valid outcome.' }
  return recoveryAction(id, (rid, name) => setStaffOutcome(rid, outcome as StaffOutcome, name))
}
export async function recoveryMatchAction(id: string, decision: string): Promise<ActionResult> {
  if (decision !== 'confirmed' && decision !== 'rejected') return { ok: false, error: 'Choose a valid decision.' }
  return recoveryAction(id, (rid, name) => reviewRebookMatch(rid, decision, name))
}
/** The customer told staff they agree to follow-up email. Appended to the consent trail under the manager's name. */
export async function recoveryConsentAction(id: string): Promise<ActionResult> {
  return recoveryAction(id, (rid, name) => recordManagerEmailConsent(rid, name))
}
/** Send the next recovery email now. It still passes the send-time gate, and nothing sends while the master switch is off. */
export async function recoverySendNowAction(id: string): Promise<ActionResult> {
  return recoveryAction(id, async (rid, name) => { const { appointmentId } = await sendNextNow(rid, name); dispatchLater(appointmentId) })
}
