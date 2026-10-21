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
  addBlock, removeBlock, getAvailability, getBookingConfig, saveBookingConfig, BookingError, APPOINTMENT_SOURCES,
  type AppointmentSource, type BookingInput,
} from '@/apps/appointments/db'
import { checkInAppointment } from '@/apps/appointments/checkin'
import { dispatchDue, requeueNotification } from '@/apps/appointments/notify'
import { mergeBookingConfig, WEEKDAYS, type BookingConfig, type DayView } from '@/apps/appointments/policy'

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
    const source = (APPOINTMENT_SOURCES as readonly string[]).includes(input.source) ? input.source as AppointmentSource : 'phone'
    if (input.override && !who.manager) return { ok: false, error: 'Only a manager can override the booking rules.' }
    const { appointment } = await createAppointment(input, { mode: 'staff', source, actor: who.name, override: !!input.override })
    dispatchLater(appointment.id)
    revalidatePath('/appointments')
    return { ok: true, id: appointment.id }
  } catch (e) { return fail(e) }
}

export async function checkInAction(id: string): Promise<ActionResult> {
  let orderId: string
  try {
    const who = await staff()
    orderId = (await checkInAppointment(id, who.name)).serviceOrderId
  } catch (e) { return fail(e) }
  revalidatePath('/appointments')
  redirect(`/orders/${orderId}`)
}

export async function noShowAction(id: string): Promise<ActionResult> {
  try { const who = await staff(); await markNoShow(id, who.name); revalidatePath('/appointments'); return { ok: true } } catch (e) { return fail(e) }
}

export async function cancelAction(id: string, reason: string): Promise<ActionResult> {
  try {
    const name = await manager()
    await cancelAppointment(id, { actor: name, by: 'staff', reason: reason.slice(0, 300) || null })
    dispatchLater(id); revalidatePath('/appointments'); return { ok: true }
  } catch (e) { return fail(e) }
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
    })
    await saveBookingConfig(next, name)
    revalidatePath('/appointments'); revalidatePath('/book'); revalidatePath('/appointments/leads')
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
