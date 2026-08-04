import { getDb } from '@/platform/db'
import { eq, and, isNull, not, inArray, desc, sql } from 'drizzle-orm'
import {
  employees,
  locations,
  vehicles,
  serviceOrders,
  serviceOrderAssignments,
  serviceOrderEvents,
} from './schema'

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
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  arrived:    ['in_progress', 'cancelled'],
  in_progress:['paused', 'drying', 'qc_ready', 'cancelled'],
  paused:     ['in_progress', 'cancelled'],
  drying:     ['qc_ready', 'in_progress'],
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

export async function createEmployee(name: string): Promise<EmployeeRow> {
  const db = getDb()
  const [row] = await db.insert(employees).values({ name }).returning()
  return row
}

export async function deactivateEmployee(id: string): Promise<void> {
  const db = getDb()
  await db.update(employees).set({ active: false }).where(eq(employees.id, id))
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
  if (params.newStatus === 'qc_ready') {
    updates.completedAt = now
  }
  if (params.newStatus === 'delivered') {
    updates.deliveredAt = now
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

async function logEvent(params: {
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
