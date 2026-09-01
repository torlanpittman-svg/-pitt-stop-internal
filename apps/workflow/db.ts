import { getDb } from '@/platform/db'
import { eq, and, isNull, not, inArray, desc, sql } from 'drizzle-orm'
import {
  employees,
  locations,
  vehicles,
  serviceOrders,
  serviceOrderAssignments,
  serviceOrderEvents,
  jobEstimates,
} from './schema'
import { partitionServices } from './services'
import { effectiveProductionDate, shopToday } from './production'
import { shopTimezone } from './completion'

export type EmployeeRow             = typeof employees.$inferSelect
export type LocationRow             = typeof locations.$inferSelect
export type VehicleRow              = typeof vehicles.$inferSelect
export type ServiceOrderRow         = typeof serviceOrders.$inferSelect
export type ServiceOrderAssignment  = typeof serviceOrderAssignments.$inferSelect
export type ServiceOrderEvent       = typeof serviceOrderEvents.$inferSelect

export type OrderWithContext = ServiceOrderRow & {
  vehicle:     VehicleRow
  activeTechs: ServiceOrderAssignment[]
  recentEvents: ServiceOrderEvent[]
}

// ── Status transition rules ────────────────────────────────────────────────────
// `ready` is reachable directly from every active state so the simplified employee
// "Finish Job" can complete a Job without first stepping through Start Work / QC.
// This is additive — the granular manager transitions are all still allowed, and
// the completion GATE (validateCompletion) still runs on any → ready.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  arrived:    ['in_progress', 'ready', 'cancelled'],
  in_progress:['paused', 'drying', 'qc_ready', 'ready', 'cancelled'],
  paused:     ['in_progress', 'ready', 'cancelled'],
  drying:     ['qc_ready', 'ready', 'in_progress'],
  qc_ready:   ['ready', 'in_progress'],
  ready:      ['delivered'],
  delivered:  [],
  cancelled:  [],
}

export function canTransition(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to)
}

// ── Locations ─────────────────────────────────────────────────────────────────

export async function getOrCreateDefaultLocation(): Promise<LocationRow> {
  const db = getDb()
  const existing = await db.select().from(locations).where(eq(locations.active, true)).limit(1)
  if (existing[0]) return existing[0]

  const [created] = await db
    .insert(locations)
    .values({ name: 'Pitt Stop', timezone: 'America/New_York' })
    .returning()
  return created
}

// ── Employees ─────────────────────────────────────────────────────────────────

export async function listEmployees(): Promise<EmployeeRow[]> {
  const db = getDb()
  return db
    .select()
    .from(employees)
    .where(eq(employees.active, true))
    .orderBy(employees.name)
}

export async function createEmployee(name: string, role: 'employee' | 'manager' | 'admin' = 'employee'): Promise<EmployeeRow> {
  const db = getDb()
  const [row] = await db.insert(employees).values({ name, role }).returning()
  return row
}

export async function deactivateEmployee(id: string): Promise<void> {
  const db = getDb()
  await db.update(employees).set({ active: false }).where(eq(employees.id, id))
}

export async function getVehicleById(id: string): Promise<VehicleRow | null> {
  const db = getDb()
  const [row] = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1)
  return row ?? null
}

/** Correct an existing vehicle's identifying fields in place (no new row). Used by
 *  the Job-detail vehicle correction so the Work Board + Job detail update instantly. */
export async function updateVehicleFields(
  id: string,
  patch: Partial<Pick<VehicleRow, 'year' | 'make' | 'model' | 'vin'>>,
): Promise<VehicleRow | null> {
  const db = getDb()
  const [row] = await db.update(vehicles).set(patch).where(eq(vehicles.id, id)).returning()
  return row ?? null
}

export async function getEmployee(id: string): Promise<EmployeeRow | null> {
  const db = getDb()
  const [row] = await db.select().from(employees).where(eq(employees.id, id)).limit(1)
  return row ?? null
}

export async function setEmployeeRole(id: string, role: 'employee' | 'manager' | 'admin'): Promise<void> {
  const db = getDb()
  await db.update(employees).set({ role }).where(eq(employees.id, id))
}

/** Set (or clear, when pinHash is null) an employee's elevation PIN hash. */
export async function setEmployeePinHash(id: string, pinHash: string | null): Promise<void> {
  const db = getDb()
  await db.update(employees).set({ pinHash }).where(eq(employees.id, id))
}

// ── Vehicles ──────────────────────────────────────────────────────────────────

export async function findOrCreateVehicle(data: {
  vin?:          string | null
  year?:         string | null
  make?:         string | null
  model?:        string | null
  color?:        string | null
  licensePlate?: string | null
  bodyClass?:    string | null
  vinRaw?:       unknown
}): Promise<VehicleRow> {
  const db = getDb()

  if (data.vin) {
    const existing = await db
      .select()
      .from(vehicles)
      .where(eq(vehicles.vin, data.vin))
      .limit(1)
    if (existing[0]) return existing[0]
  }

  const [created] = await db.insert(vehicles).values({
    vin:          data.vin          ?? null,
    year:         data.year         ?? null,
    make:         data.make         ?? null,
    model:        data.model        ?? null,
    color:        data.color        ?? null,
    licensePlate: data.licensePlate ?? null,
    bodyClass:    data.bodyClass    ?? null,
    vinRaw:       data.vinRaw       ?? null,
  }).returning()
  return created
}

// ── Order Numbers ─────────────────────────────────────────────────────────────

async function nextOrderNumber(): Promise<string> {
  const db = getDb()
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '') // YYYYMMDD
  const prefix = `SO-${today}-`

  const rows = await db
    .select({ orderNumber: serviceOrders.orderNumber })
    .from(serviceOrders)
    .where(sql`${serviceOrders.orderNumber} LIKE ${prefix + '%'}`)
    .orderBy(desc(serviceOrders.orderNumber))
    .limit(1)

  if (!rows[0]) return `${prefix}0001`

  const last = rows[0].orderNumber.split('-').at(-1) ?? '0'
  const next = (parseInt(last, 10) + 1).toString().padStart(4, '0')
  return `${prefix}${next}`
}

// ── Service Orders ────────────────────────────────────────────────────────────

export async function createServiceOrder(data: {
  vehicleId:    string
  locationId?:  string
  source?:      string
  serviceType?: string
  serviceFocus?: string
  checkedInBy?: string
  notes?:       string
  /** Selected service labels for the Work Board card (Quick Entry). Omitted → null. */
  services?:    string[]
  /** Card title: retail customer name or dealer name. Omitted → null (→ "Unknown Customer"). */
  customerName?: string | null
  /** Operational urgency set at check-in (defaults Normal). Visual/sort only. */
  isUrgent?: boolean
}): Promise<ServiceOrderRow> {
  const db = getDb()
  const orderNumber = await nextOrderNumber()

  const [row] = await db
    .insert(serviceOrders)
    .values({
      orderNumber,
      vehicleId:   data.vehicleId,
      locationId:  data.locationId  ?? null,
      source:      data.source      ?? 'walk_in',
      serviceType: data.serviceType ?? null,
      serviceFocus: data.serviceFocus ?? null,
      checkedInBy: data.checkedInBy ?? null,
      notes:       data.notes        ?? null,
      services:    data.services && data.services.length > 0 ? data.services : null,
      customerName: data.customerName?.trim() || null,
      isUrgent:    data.isUrgent ?? false,
      status:      'arrived',
      arrivedAt:   new Date(),
    })
    .returning()

  await logEvent({
    serviceOrderId: row.id,
    eventType:      'checked_in',
    employeeName:   data.checkedInBy ?? null,
    newStatus:      'arrived',
  })

  return row
}

/**
 * Set/clear a Job's operational urgency (any authenticated employee). Visual/sort priority only —
 * never touches status, pricing, production, or QuickBooks. Records a lightweight audit event.
 */
export async function setOrderUrgent(orderId: string, urgent: boolean, actor: string | null): Promise<ServiceOrderRow | null> {
  const db = getDb()
  const [row] = await db.update(serviceOrders)
    .set({ isUrgent: urgent, updatedAt: new Date() })
    .where(eq(serviceOrders.id, orderId))
    .returning()
  if (!row) return null
  await logEvent({ serviceOrderId: orderId, eventType: 'urgency_changed', employeeName: actor, note: urgent ? 'urgent' : 'normal' })
  return row
}

export async function findActiveOrderByVehicleId(vehicleId: string): Promise<ServiceOrderRow | null> {
  const db = getDb()
  const TERMINAL = ['delivered', 'cancelled']
  const rows = await db
    .select()
    .from(serviceOrders)
    .where(and(
      eq(serviceOrders.vehicleId, vehicleId),
      not(inArray(serviceOrders.status, TERMINAL)),
    ))
    .orderBy(desc(serviceOrders.arrivedAt))
    .limit(1)
  return rows[0] ?? null
}

/** Delete an order with its events + assignments, and optionally its vehicle
 *  (used to clean up test/automated check-ins so the board stays clean). */
export async function deleteOrderCascade(orderId: string, alsoVehicleId?: string): Promise<void> {
  const db = getDb()
  await db.delete(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))
  await db.delete(serviceOrderAssignments).where(eq(serviceOrderAssignments.serviceOrderId, orderId))
  await db.delete(serviceOrders).where(eq(serviceOrders.id, orderId))
  if (alsoVehicleId) await db.delete(vehicles).where(eq(vehicles.id, alsoVehicleId))
}

/** Active (non-terminal) order for a VIN, or null. Used for duplicate check-in guard. */
export async function findActiveOrderByVin(vin: string): Promise<ServiceOrderRow | null> {
  const db = getDb()
  const TERMINAL = ['delivered', 'cancelled']
  const rows = await db
    .select({ order: serviceOrders })
    .from(serviceOrders)
    .innerJoin(vehicles, eq(serviceOrders.vehicleId, vehicles.id))
    .where(and(
      eq(vehicles.vin, vin),
      not(inArray(serviceOrders.status, TERMINAL)),
    ))
    .orderBy(desc(serviceOrders.arrivedAt))
    .limit(1)
  return rows[0]?.order ?? null
}

export async function listActiveOrders(): Promise<OrderWithContext[]> {
  const db = getDb()

  const TERMINAL = ['delivered', 'cancelled']
  const orders = await db
    .select()
    .from(serviceOrders)
    .where(not(inArray(serviceOrders.status, TERMINAL)))
    .orderBy(serviceOrders.arrivedAt)

  if (orders.length === 0) return []

  const orderIds = orders.map(o => o.id)

  const [allVehicles, allActive, allEvents] = await Promise.all([
    db.select().from(vehicles).where(
      inArray(vehicles.id, orders.map(o => o.vehicleId))
    ),
    db.select().from(serviceOrderAssignments).where(
      and(
        inArray(serviceOrderAssignments.serviceOrderId, orderIds),
        isNull(serviceOrderAssignments.stoppedAt)
      )
    ),
    db.select().from(serviceOrderEvents).where(
      inArray(serviceOrderEvents.serviceOrderId, orderIds)
    ).orderBy(desc(serviceOrderEvents.createdAt)),
  ])

  const vehicleMap = Object.fromEntries(allVehicles.map(v => [v.id, v]))
  const activeTechMap: Record<string, ServiceOrderAssignment[]> = {}
  const eventMap: Record<string, ServiceOrderEvent[]> = {}

  for (const a of allActive) {
    ;(activeTechMap[a.serviceOrderId] ??= []).push(a)
  }
  for (const e of allEvents) {
    const list = (eventMap[e.serviceOrderId] ??= [])
    if (list.length < 5) list.push(e)
  }

  return orders.map(o => ({
    ...o,
    vehicle:      vehicleMap[o.vehicleId]!,
    activeTechs:  activeTechMap[o.id] ?? [],
    recentEvents: eventMap[o.id]      ?? [],
  }))
}

export async function getOrderWithContext(id: string): Promise<OrderWithContext | null> {
  const db = getDb()

  const orderRows = await db
    .select()
    .from(serviceOrders)
    .where(eq(serviceOrders.id, id))
    .limit(1)

  if (!orderRows[0]) return null
  const order = orderRows[0]

  const [vehicleRows, activeTechs, recentEvents] = await Promise.all([
    db.select().from(vehicles).where(eq(vehicles.id, order.vehicleId)).limit(1),
    db.select().from(serviceOrderAssignments).where(
      and(
        eq(serviceOrderAssignments.serviceOrderId, id),
        isNull(serviceOrderAssignments.stoppedAt)
      )
    ),
    db.select().from(serviceOrderEvents).where(
      eq(serviceOrderEvents.serviceOrderId, id)
    ).orderBy(desc(serviceOrderEvents.createdAt)).limit(10),
  ])

  if (!vehicleRows[0]) return null

  return {
    ...order,
    vehicle:      vehicleRows[0],
    activeTechs,
    recentEvents,
  }
}

// ── Status Transitions ────────────────────────────────────────────────────────

export async function transitionOrder(params: {
  orderId:      string
  newStatus:    string
  employeeName: string | null
  note?:        string
  /** Completion gate outputs (only when newStatus === 'ready'). */
  completedBy?: string | null
  completionChecklist?: Record<string, unknown> | null
}): Promise<{ ok: boolean; error?: string; order?: ServiceOrderRow }> {
  const db = getDb()

  const rows = await db.select().from(serviceOrders).where(eq(serviceOrders.id, params.orderId)).limit(1)
  if (!rows[0]) return { ok: false, error: 'Order not found' }

  const order = rows[0]
  if (!canTransition(order.status, params.newStatus)) {
    return { ok: false, error: `Cannot go from ${order.status} to ${params.newStatus}` }
  }

  const now = new Date()
  const updates: Partial<typeof serviceOrders.$inferInsert> = {
    status:    params.newStatus,
    updatedAt: now,
  }

  if (params.newStatus === 'in_progress' && !order.startedAt) {
    updates.startedAt = now
  }
  // True completion = Ready. Stamp completed_at ONCE (never overwrite via ordinary
  // transitions or delivery). Only the manager Reopen flow may clear it.
  if (params.newStatus === 'ready' && !order.completedAt) {
    updates.completedAt = now
    updates.completedBy = params.completedBy ?? params.employeeName ?? null
    if (params.completionChecklist) updates.completionChecklist = params.completionChecklist
  }
  if (params.newStatus === 'delivered') {
    updates.deliveredAt = now   // does NOT touch completed_at
  }
  if (params.newStatus === 'cancelled') {
    updates.cancelledAt = now
  }

  // Stop all active assignments when leaving in_progress
  const stopsWork = !['in_progress'].includes(params.newStatus)
  if (stopsWork) {
    await db
      .update(serviceOrderAssignments)
      .set({ stoppedAt: now })
      .where(
        and(
          eq(serviceOrderAssignments.serviceOrderId, params.orderId),
          isNull(serviceOrderAssignments.stoppedAt)
        )
      )
  }

  const [updated] = await db
    .update(serviceOrders)
    .set(updates)
    .where(eq(serviceOrders.id, params.orderId))
    .returning()

  await logEvent({
    serviceOrderId: params.orderId,
    eventType:      'status_changed',
    employeeName:   params.employeeName,
    oldStatus:      order.status,
    newStatus:      params.newStatus,
    note:           params.note ?? null,
  })
  // Distinct completion event when we actually stamped completed_at (Ready, first time).
  if (params.newStatus === 'ready' && updates.completedAt) {
    await logEvent({
      serviceOrderId: params.orderId,
      eventType:      'completed',
      employeeName:   params.completedBy ?? params.employeeName ?? null,
      note:           'Marked Ready (completion confirmed)',
    })
  }

  return { ok: true, order: updated }
}

/**
 * Manager/admin: REMOVE a mistaken/duplicate Job from the Work Board (soft cancel). Sets
 * status='cancelled' + cancelledAt so it drops from listActiveOrders immediately. SOFT only —
 * customer, vehicle, estimate, services, completion history and any QuickBooks linkage are all
 * left intact and recoverable. RETAIL + ACTIVE only: refuses dealer Jobs and any Ready/
 * Delivered/Cancelled Job (server-enforced, not just hidden in the UI). Never touches
 * completed_at. Writes a 'removed' audit event (actor, prior status, QB-invoice note).
 */
const REMOVABLE_STATUSES = ['arrived', 'in_progress', 'paused', 'drying', 'qc_ready']
export async function removeOrder(params: { orderId: string; actor: string | null }): Promise<{ ok: boolean; error?: string; order?: ServiceOrderRow }> {
  const db = getDb()
  const [order] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, params.orderId)).limit(1)
  if (!order) return { ok: false, error: 'Job not found' }
  // Dealer isolation — dealer Jobs are managed in Dealer Check-In, never removed from here.
  const src = (order.source ?? '').toLowerCase(), typ = (order.serviceType ?? '').toLowerCase()
  if (src === 'dealer' || src === 'dealer_checkin' || typ.startsWith('dealer')) {
    return { ok: false, error: 'Dealer Jobs are managed in Dealer Check-In.' }
  }
  // Active only — a Ready/Delivered/Cancelled Job cannot be swipe-removed (production-safe).
  if (!REMOVABLE_STATUSES.includes(order.status)) {
    return { ok: false, error: `Only an active Job can be removed (this Job is ${order.status}).` }
  }

  const now = new Date()
  // Stop any active tech assignments (same as a normal cancel transition).
  await db.update(serviceOrderAssignments).set({ stoppedAt: now })
    .where(and(eq(serviceOrderAssignments.serviceOrderId, params.orderId), isNull(serviceOrderAssignments.stoppedAt)))
  const [updated] = await db.update(serviceOrders)
    .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })   // never touches completed_at
    .where(eq(serviceOrders.id, params.orderId)).returning()

  // QB linkage is LEFT INTACT — record it in the audit note (we never void/delete the invoice).
  const [est] = await db.select({ qbInvoiceNumber: jobEstimates.qbInvoiceNumber })
    .from(jobEstimates).where(eq(jobEstimates.serviceOrderId, params.orderId)).limit(1)
  const qbNote = est?.qbInvoiceNumber ? ` · QuickBooks Invoice #${est.qbInvoiceNumber} left intact` : ''
  await logEvent({
    serviceOrderId: params.orderId, eventType: 'removed', employeeName: params.actor,
    oldStatus: order.status, newStatus: 'cancelled', note: `Removed from Work Board${qbNote}`,
  })
  return { ok: true, order: updated }
}

/**
 * Change Production Date (manager/admin): set or clear `production_date_override` so a completed
 * Job counts/shows on a chosen shop-calendar day, WITHOUT touching completed_at or the completion
 * event. Retail + dealer both supported (read only by dailyProduction; never touches dealer_scans
 * or QuickBooks). date=null → return to the completed_at-derived day. Rejects a non-completed Job
 * and a future date. Audited as `production_date_corrected` (append-only).
 */
export async function setProductionDateOverride(params: { orderId: string; date: string | null; actor: string | null }): Promise<{ ok: boolean; error?: string; previousEffective?: string | null; newEffective?: string | null }> {
  const db = getDb()
  const tz = shopTimezone()
  const [order] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, params.orderId)).limit(1)
  if (!order) return { ok: false, error: 'Job not found' }
  if (!order.completedAt) return { ok: false, error: 'Only a completed Job has a production date.' }
  const date = params.date
  if (date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid date.' }
    if (date > shopToday(tz)) return { ok: false, error: 'Production date cannot be in the future.' }
  }
  const previousEffective = effectiveProductionDate(order.productionDateOverride, order.completedAt, tz)
  const newEffective = effectiveProductionDate(date, order.completedAt, tz)
  if (previousEffective === newEffective) return { ok: true, previousEffective, newEffective }  // no-op, no event

  await db.update(serviceOrders).set({ productionDateOverride: date, updatedAt: new Date() }).where(eq(serviceOrders.id, params.orderId))
  await logEvent({
    serviceOrderId: params.orderId, eventType: 'production_date_corrected', employeeName: params.actor,
    note: JSON.stringify({ previousEffective, newProductionDate: date ?? 'reset', newEffective, completedAt: (order.completedAt as Date).toISOString() }),
  })
  return { ok: true, previousEffective, newEffective }
}

/**
 * Manager-only correction: reopen a Ready Job because work was actually incomplete.
 * Clears completed_at (so it counts only on its true final completion) while
 * preserving the original completed_at + reason + manager + reopen time in the
 * append-only audit history. Requires a reason. Not an employee action.
 */
export async function reopenOrder(params: {
  orderId: string
  reason:  string
  managerName: string | null
}): Promise<{ ok: boolean; error?: string; order?: ServiceOrderRow }> {
  const db = getDb()
  const rows = await db.select().from(serviceOrders).where(eq(serviceOrders.id, params.orderId)).limit(1)
  if (!rows[0]) return { ok: false, error: 'Job not found' }
  const order = rows[0]
  if (order.status !== 'ready') return { ok: false, error: 'Only a Ready Job can be reopened.' }
  if (!params.reason?.trim()) return { ok: false, error: 'A reason is required to reopen.' }

  const now = new Date()
  const priorCompletedAt = order.completedAt
  const [updated] = await db.update(serviceOrders)
    .set({ status: 'in_progress', completedAt: null, updatedAt: now })  // clears completion; may re-complete later
    .where(eq(serviceOrders.id, params.orderId))
    .returning()

  await logEvent({
    serviceOrderId: params.orderId,
    eventType:      'reopened',
    employeeName:   params.managerName,
    oldStatus:      'ready',
    newStatus:      'in_progress',
    note:           JSON.stringify({ reason: params.reason.trim(), priorCompletedAt: priorCompletedAt?.toISOString() ?? null, reopenedAt: now.toISOString(), manager: params.managerName ?? null }),
  })
  return { ok: true, order: updated }
}

// ── Tech Assignments ──────────────────────────────────────────────────────────

export async function startAssignment(params: {
  serviceOrderId: string
  employeeName:   string
}): Promise<ServiceOrderAssignment> {
  const db = getDb()

  // Stop any active sessions for this tech on other orders
  await db
    .update(serviceOrderAssignments)
    .set({ stoppedAt: new Date() })
    .where(
      and(
        eq(serviceOrderAssignments.employeeName, params.employeeName),
        isNull(serviceOrderAssignments.stoppedAt)
      )
    )

  const [row] = await db
    .insert(serviceOrderAssignments)
    .values({
      serviceOrderId: params.serviceOrderId,
      employeeName:   params.employeeName,
      startedAt:      new Date(),
    })
    .returning()

  return row
}

export async function stopAssignments(serviceOrderId: string): Promise<void> {
  const db = getDb()
  await db
    .update(serviceOrderAssignments)
    .set({ stoppedAt: new Date() })
    .where(
      and(
        eq(serviceOrderAssignments.serviceOrderId, serviceOrderId),
        isNull(serviceOrderAssignments.stoppedAt)
      )
    )
}

// ── Event Log ─────────────────────────────────────────────────────────────────

/**
 * Append services to an order's display list (Work Board card). Guards accidental
 * duplicates: if a requested service already exists and confirmDuplicates is false,
 * nothing is written and the duplicates are returned for the UI to confirm.
 * Logs a `service_added` audit event (who + timestamp + work-order id + names).
 * Display-only — no QuickBooks / AutoLeap writes.
 */
export async function addServiceToOrder(
  orderId: string,
  requested: string[],
  opts: { addedBy?: string | null; confirmDuplicates?: boolean } = {},
): Promise<{ ok: true; order: OrderWithContext } | { ok: false; needsConfirm: true; duplicates: string[] }> {
  const db = getDb()
  const [current] = await db.select({ services: serviceOrders.services }).from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  const existing = current?.services ?? []

  const { fresh, duplicates } = partitionServices(existing, requested)
  if (duplicates.length > 0 && !opts.confirmDuplicates) {
    return { ok: false, needsConfirm: true, duplicates }
  }
  // On explicit confirm, keep duplicates too (same service intentionally repeated);
  // otherwise just the fresh ones.
  const toAdd = opts.confirmDuplicates ? [...fresh, ...duplicates] : fresh
  if (toAdd.length === 0) {
    const order = await getOrderWithContext(orderId)
    return { ok: true, order: order! }
  }

  const nextServices = [...existing, ...toAdd]
  await db.update(serviceOrders).set({ services: nextServices, updatedAt: new Date() }).where(eq(serviceOrders.id, orderId))
  await logEvent({
    serviceOrderId: orderId,
    eventType:      'service_added',
    employeeName:   opts.addedBy ?? null,
    note:           toAdd.join(', '),
  })
  const order = await getOrderWithContext(orderId)
  return { ok: true, order: order! }
}

export async function logEvent(params: {
  serviceOrderId: string
  eventType:      string
  employeeName?:  string | null
  oldStatus?:     string | null
  newStatus?:     string | null
  note?:          string | null
}): Promise<void> {
  const db = getDb()
  await db.insert(serviceOrderEvents).values({
    serviceOrderId: params.serviceOrderId,
    eventType:      params.eventType,
    employeeName:   params.employeeName   ?? null,
    oldStatus:      params.oldStatus      ?? null,
    newStatus:      params.newStatus      ?? null,
    note:           params.note           ?? null,
  })
}
