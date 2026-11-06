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
 *
 * The vehicle: a booking has no VIN (the public form never asks). The VIN lives on the customer's saved
 * vehicle row, so check-in reuses that row — chosen by staff, or the single saved vehicle with the booked
 * year/make/model. It never guesses: with several candidates (or none that match while others are on
 * file) it refuses until staff choose. See resolveCheckinVehicle.
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

// ── Which vehicle is here? ────────────────────────────────────────────────────
// A booking carries only what the customer typed (type/year/make/model — the public form has no VIN
// field). The VIN lives on the customer's SAVED vehicle row (vehicles.vin, linked via customer_vehicles),
// so check-in must hand the Quick Entry creator that row's id — never a VIN guessed from year/make/model,
// and never a silent pick between two saved vehicles. Rules, in order:
//   1. a vehicle already linked to the appointment → reused (authoritative — any choice is ignored);
//   2. the appointment itself carries a VIN (staff-entered) → the creator de-dupes by that VIN. The VIN
//      outranks any choice: the selector is hidden whenever a VIN exists, so a choice arriving here is a
//      stale or hidden preselection and must never override the VIN staff typed;
//   3. a vehicle staff explicitly chose (must be on the customer's file) → reused; staff chose
//      "new vehicle" → a new row;
//   4. nothing on file for the customer → a new row (no VIN — scan it on the Job);
//   5. exactly ONE saved vehicle has the booked year/make/model → reused;
//   6. otherwise (several match, or none match but others are on file) → check-in REFUSES until staff choose.

export interface SavedVehicle {
  id: string; vin: string | null; year: string | null; make: string | null; model: string | null; color: string | null
  /** Same year/make/model as the booking (case-insensitive; year compared only when the booking has one). */
  matches: boolean
}
export type VehicleChoice = { vehicleId: string } | { newVehicle: true }
export type VehicleHow = 'linked' | 'chosen' | 'new' | 'vin' | 'none_on_file' | 'matched'
export interface VehicleResolution { vehicleId: string | null; how: VehicleHow }

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
export const bookedVehicleLabel = (a: Pick<Appointment, 'vehicleYear' | 'vehicleMake' | 'vehicleModel'>) =>
  [a.vehicleYear, a.vehicleMake, a.vehicleModel].filter(Boolean).join(' ') || 'the booked vehicle'

/** The customer's saved vehicles (directory link), oldest first, each flagged when it is the booked year/make/model. */
export async function savedVehiclesFor(a: Pick<Appointment, 'customerId' | 'vehicleYear' | 'vehicleMake' | 'vehicleModel'>): Promise<SavedVehicle[]> {
  if (!a.customerId) return []
  const rows = await getDb().select({ id: vehicles.id, vin: vehicles.vin, year: vehicles.year, make: vehicles.make, model: vehicles.model, color: vehicles.color })
    .from(customerVehicles).innerJoin(vehicles, eq(vehicles.id, customerVehicles.vehicleId))
    .where(eq(customerVehicles.customerId, a.customerId)).orderBy(customerVehicles.firstSeenAt, vehicles.id)
  const wantMake = norm(a.vehicleMake), wantModel = norm(a.vehicleModel), wantYear = norm(a.vehicleYear)
  return rows.map((v) => ({
    ...v,
    matches: !!wantMake && !!wantModel && norm(v.make) === wantMake && norm(v.model) === wantModel && (!wantYear || norm(v.year) === wantYear),
  }))
}

/** Decide the vehicle row for the Job BEFORE anything is claimed or created; throws when staff must choose. */
export async function resolveCheckinVehicle(a: Appointment, choice?: VehicleChoice | null): Promise<VehicleResolution> {
  if (a.vehicleId) return { vehicleId: a.vehicleId, how: 'linked' }
  if (a.vehicleVin) return { vehicleId: null, how: 'vin' }
  if (choice && 'vehicleId' in choice) {
    const saved = await savedVehiclesFor(a)
    if (!saved.some((v) => v.id === choice.vehicleId)) throw new BookingError('invalid', 'That vehicle is not on this customer\'s file. Refresh and choose again.')
    return { vehicleId: choice.vehicleId, how: 'chosen' }
  }
  if (choice && 'newVehicle' in choice && choice.newVehicle) return { vehicleId: null, how: 'new' }
  const saved = await savedVehiclesFor(a)
  if (saved.length === 0) return { vehicleId: null, how: 'none_on_file' }
  const matching = saved.filter((v) => v.matches)
  if (matching.length === 1) return { vehicleId: matching[0].id, how: 'matched' }
  const booked = bookedVehicleLabel(a)
  throw new BookingError('conflict', matching.length > 1
    ? `This customer has ${matching.length} saved vehicles that are a ${booked}. Choose which one is here, then check in.`
    : `This customer has ${saved.length} saved vehicle${saved.length === 1 ? '' : 's'} on file and none is a ${booked}. Choose the saved vehicle that is here, or confirm it is a new vehicle, then check in.`)
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

async function linkJob(a: Appointment, serviceOrderId: string, actor: string, recovered: boolean, resolved?: VehicleResolution): Promise<void> {
  const db = getDb()
  const [vehicle] = await db.select({ vehicleId: serviceOrders.vehicleId, customerId: serviceOrders.customerId }).from(serviceOrders).where(eq(serviceOrders.id, serviceOrderId)).limit(1)
  const [linked] = await db.update(appointments).set({
    serviceOrderId, status: 'arrived', arrivedAt: new Date(), updatedAt: new Date(),
    vehicleId: vehicle?.vehicleId ?? a.vehicleId, customerId: a.customerId ?? vehicle?.customerId ?? null,
  }).where(and(eq(appointments.id, a.id), isNull(appointments.serviceOrderId))).returning({ id: appointments.id })
  if (!linked) return
  await db.insert(appointmentEvents).values({ appointmentId: a.id, eventType: 'checked_in', actor, meta: { serviceOrderId, recovered, ...(resolved ? { vehicle: resolved.how, vehicleId: resolved.vehicleId } : {}) } })
  if (a.marketingLeadId) {
    const confidence = (a.attribution && Object.keys(a.attribution).length) ? 'direct' : 'unknown'
    await linkLeadOutcome(a.marketingLeadId, { serviceOrderId, confidence }, actor)
      .catch((err) => console.error('[appointments] lead→order link failed (check-in kept):', err))
  }
}

export async function checkInAppointment(id: string, actor: string, choice?: VehicleChoice | null): Promise<{ serviceOrderId: string; existing: boolean }> {
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

  // Decide the vehicle first: a refusal ("choose which saved vehicle") must not claim the appointment.
  const vehicle = await resolveCheckinVehicle(a, choice)

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
    vehicleId: vehicle.vehicleId,                // the saved row (with its VIN) — never a VIN inferred from the text
    lines: [],                                   // itemized on the Estimate — never auto-billed from the booking
    jobNote: requestNoteForAppointment(claimed),
    createdBy: actor,
    internalNote: note,
    audit: { idMethod: vehicle.vehicleId ? 'saved_vehicle' : 'manual', plate: claimed.vehiclePlate ?? null },
  })
  await linkJob(claimed, job.serviceOrderId, actor, false, vehicle)
  const after = await getAppointment(id)
  return { serviceOrderId: after?.serviceOrderId ?? job.serviceOrderId, existing: false }
}
