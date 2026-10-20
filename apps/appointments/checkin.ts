/**
 * Check-in: the vehicle has physically arrived → create its Work Board Job through the EXISTING Quick
 * Entry job creator (canonical customer match, vehicle find-or-create, draft estimate). The booked
 * services are the customer's request (shown as the Job note), not billable lines.
 * No parallel intake. Dealer Check-In, pricing, fees and QuickBooks are untouched; the Job then follows
 * the normal retail lifecycle → Invoice Draft → existing QuickBooks Create/Send.
 *
 * Exactly one Job per appointment:
 *   • a conditional claim (checkin_started_at) stops two staff / a double tap creating two Jobs;
 *   • appointments.service_order_id is unique and only set while NULL;
 *   • the Job's internal note carries the appointment reference, so a check-in interrupted after the Job
 *     was created but before it was linked is RECOVERED (linked) on retry instead of duplicated.
 */
import { and, desc, eq, gte, ilike, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { createQuickEntryJob } from '@/apps/quick-entry/jobs-db'
import { serviceOrders, jobEstimates, vehicles } from '@/apps/workflow/schema'
import { customerVehicles } from '@/apps/directory/schema'
import { linkLeadOutcome } from '@/apps/marketing/attribution'
import { appointments, appointmentEvents } from './schema'
import { getAppointment, BookingError, type Appointment } from './db'

const CLAIM_MS = 2 * 60_000

export const checkinMarker = (a: Pick<Appointment, 'reference'>) => `Appointment ${a.reference}`

/**
 * What the customer asked for when booking ("Complete Detail", "Odor / Ozone") is a REQUEST, not the
 * billable work: retail jobs are itemized by staff on the Estimate (Interior Detail, Exterior Wash,
 * Wax, …). So check-in creates NO service lines and no price — the request is shown on the Job as its
 * note instead. (Dealer Complete Detail is Dealer Check-In and never passes through here.)
 */
export function requestNoteForAppointment(a: Pick<Appointment, 'serviceLabels' | 'reference' | 'customerNotes'>): string {
  return [
    `Customer requested: ${a.serviceLabels.trim() || 'not specified'} (appointment ${a.reference}).`,
    a.customerNotes ? `Customer note: ${a.customerNotes}` : null,
  ].filter(Boolean).join(' ').slice(0, 500)
}

/** Reuse the customer's existing vehicle when exactly one linked vehicle matches year/make/model. */
async function matchCustomerVehicle(a: Appointment): Promise<string | null> {
  if (a.vehicleId) return a.vehicleId
  if (!a.customerId || !a.vehicleMake || !a.vehicleModel || a.vehicleVin) return null
  const rows = await getDb().select({ id: vehicles.id }).from(customerVehicles)
    .innerJoin(vehicles, eq(vehicles.id, customerVehicles.vehicleId))
    .where(and(
      eq(customerVehicles.customerId, a.customerId),
      sql`lower(${vehicles.make}) = lower(${a.vehicleMake})`, sql`lower(${vehicles.model}) = lower(${a.vehicleModel})`,
      ...(a.vehicleYear ? [eq(vehicles.year, a.vehicleYear)] : []),
    )).limit(2)
  return rows.length === 1 ? rows[0].id : null
}

/** A Job already created for this appointment by an interrupted check-in (found via its marker). */
async function findOrphanJob(a: Appointment): Promise<string | null> {
  if (!a.checkinStartedAt) return null
  const [row] = await getDb().select({ id: serviceOrders.id }).from(jobEstimates)
    .innerJoin(serviceOrders, eq(serviceOrders.id, jobEstimates.serviceOrderId))
    .where(and(ilike(jobEstimates.internalNotes, `%${checkinMarker(a)}%`), gte(serviceOrders.createdAt, new Date(a.checkinStartedAt.getTime() - 60_000))))
    .orderBy(desc(serviceOrders.createdAt)).limit(1)
  return row?.id ?? null
}

async function linkJob(a: Appointment, serviceOrderId: string, actor: string, recovered: boolean): Promise<void> {
  const db = getDb()
  const [vehicle] = await db.select({ vehicleId: serviceOrders.vehicleId, customerId: serviceOrders.customerId }).from(serviceOrders).where(eq(serviceOrders.id, serviceOrderId)).limit(1)
  const [linked] = await db.update(appointments).set({
    serviceOrderId, status: 'arrived', arrivedAt: new Date(), updatedAt: new Date(),
    vehicleId: vehicle?.vehicleId ?? a.vehicleId, customerId: a.customerId ?? vehicle?.customerId ?? null,
  }).where(and(eq(appointments.id, a.id), isNull(appointments.serviceOrderId))).returning({ id: appointments.id })
  if (!linked) return
  await db.insert(appointmentEvents).values({ appointmentId: a.id, eventType: 'checked_in', actor, meta: { serviceOrderId, recovered } })
  if (a.marketingLeadId) {
    const confidence = (a.attribution && Object.keys(a.attribution).length) ? 'direct' : 'unknown'
    await linkLeadOutcome(a.marketingLeadId, { serviceOrderId, confidence }, actor)
      .catch((err) => console.error('[appointments] lead→order link failed (check-in kept):', err))
  }
}

export async function checkInAppointment(id: string, actor: string): Promise<{ serviceOrderId: string; existing: boolean }> {
  const db = getDb()
  const a = await getAppointment(id)
  if (!a) throw new BookingError('not_found', 'Appointment not found.')
  if (a.serviceOrderId) return { serviceOrderId: a.serviceOrderId, existing: true }
  if (a.status !== 'confirmed' && a.status !== 'arrived') throw new BookingError('conflict', `This appointment is ${a.status.replace('_', '-')}.`)

  const orphan = await findOrphanJob(a)
  if (orphan) {
    await linkJob(a, orphan, actor, true)
    const after = await getAppointment(id)
    return { serviceOrderId: after?.serviceOrderId ?? orphan, existing: true }
  }

  const [claimed] = await db.update(appointments).set({ checkinStartedAt: new Date() }).where(and(
    eq(appointments.id, id), isNull(appointments.serviceOrderId),
    sql`(${appointments.checkinStartedAt} IS NULL OR ${appointments.checkinStartedAt} < ${new Date(Date.now() - CLAIM_MS).toISOString()}::timestamptz)`,
  )).returning()
  if (!claimed) {
    const again = await getAppointment(id)
    if (again?.serviceOrderId) return { serviceOrderId: again.serviceOrderId, existing: true }
    throw new BookingError('conflict', 'Check-in is already in progress for this appointment. Refresh in a moment.')
  }

  const note = [
    `${checkinMarker(claimed)} (${claimed.source.replace('_', ' ')}).`,
    claimed.customerNotes ? `Customer note: ${claimed.customerNotes}` : null,
    claimed.internalNotes ? `Staff note: ${claimed.internalNotes}` : null,
  ].filter(Boolean).join(' ').slice(0, 500)

  const job = await createQuickEntryJob({
    customerName: `${claimed.firstName} ${claimed.lastName}`.trim(),
    customerPhone: claimed.phone || null,
    customerEmail: claimed.email,
    vehicle: { vin: claimed.vehicleVin, year: claimed.vehicleYear, make: claimed.vehicleMake, model: claimed.vehicleModel, color: claimed.vehicleColor },
    vehicleId: await matchCustomerVehicle(claimed),
    lines: [],                                   // itemized on the Estimate — never auto-billed from the booking
    jobNote: requestNoteForAppointment(claimed),
    createdBy: actor,
    internalNote: note,
    audit: claimed.vehiclePlate ? { idMethod: 'manual', plate: claimed.vehiclePlate } : undefined,
  })
  await linkJob(claimed, job.serviceOrderId, actor, false)
  const after = await getAppointment(id)
  return { serviceOrderId: after?.serviceOrderId ?? job.serviceOrderId, existing: false }
}
