import { randomUUID } from 'node:crypto'
import { and, eq, desc, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { serviceOrders, vehicles, jobEstimates, jobServices, jobLineItems, serviceOrderEvents } from '@/apps/workflow/schema'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { estimateIntakes } from './schema'
import { z } from 'zod'
import { recomputeEstimate, getEstimateRow } from '@/apps/workflow/estimate-db'
import { getBusinessConfig } from '@/apps/settings/db'

export const intakeInput = z.object({
  requestId: z.uuid(),
  customerName: z.string().trim().min(1).max(200),
  customerEmail: z.union([z.email().max(200), z.literal('')]).default(''),
  customerPhone: z.string().trim().max(40).default(''),
  year: z.string().regex(/^\d{4}$/),
  make: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  vin: z.union([z.string().trim().toUpperCase().regex(/^[A-HJ-NPR-Z0-9]{17}$/), z.literal('')]).default(''),
  vehicleId: z.uuid().nullable().optional(),
  lines: z.array(z.object({ name: z.string().trim().min(1).max(200), priceCents: z.number().int().min(0).max(100000000) })).max(100).default([]),
  workPriceCents: z.number().int().min(0).max(100000000).nullable().optional(),
  notes: z.string().trim().max(5000).default(''),
})

export async function createIntake(input: z.infer<typeof intakeInput>, actor: string) {
  const db = getDb()
  const id = input.requestId
  const [existing] = await db.select().from(estimateIntakes).where(eq(estimateIntakes.orderId, id))
  if (existing) {
    const estimate = await getEstimateRow(id)
    if (estimate) await recomputeEstimate(estimate.id)
    return id
  }
  const [savedVehicle] = input.vehicleId
    ? await db.select().from(vehicles).where(eq(vehicles.id, input.vehicleId)).limit(1)
    : input.vin ? await db.select().from(vehicles).where(eq(vehicles.vin, input.vin)).orderBy(desc(vehicles.createdAt)).limit(1) : []
  if (input.vehicleId && !savedVehicle) throw new Error('Saved vehicle not found')
  const vehicleId = savedVehicle?.id ?? randomUUID()
  const vehicle = savedVehicle ?? input
  const estimateId = randomUUID()
  const services = input.lines.map((line, sortOrder) => ({ id: randomUUID(), jobEstimateId: estimateId, title: line.name, source: 'manual', sortOrder }))
  const cfg = await getBusinessConfig()
  // Neon batch is transactional: an estimate never appears briefly as an arrived Job,
  // and a failed contact/estimate insert cannot leave a half-created intake behind.
  const statements = [
    ...(!savedVehicle ? [db.insert(vehicles).values({ id: vehicleId, year: input.year, make: input.make, model: input.model, vin: input.vin || null })] : []),
    db.insert(serviceOrders).values({ id, orderNumber: `ES-${id.replaceAll('-', '').slice(0, 16)}`, vehicleId,
      source: 'estimate', serviceType: 'retail', status: 'estimate', customerName: input.customerName,
      notes: input.notes || null, checkedInBy: actor }),
    db.insert(quickEntryJobs).values({ serviceOrderId: id, vehicleId, customerName: input.customerName,
      customerEmail: input.customerEmail || null, customerPhone: input.customerPhone || null,
      year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vehicle.vin || null, createdBy: actor }),
    db.insert(jobEstimates).values({ id: estimateId, serviceOrderId: id, priceMode: input.workPriceCents ? 'explicit_pretax' : 'itemized', explicitTotalCents: input.workPriceCents || null, taxRateBps: cfg.defaultTaxBps, explicitTaxCategory: 'detailing', createdBy: actor, updatedBy: actor }),
    ...(services.length ? [
      db.insert(jobServices).values(services),
      db.insert(jobLineItems).values(services.map((service, i) => ({ jobServiceId: service.id, type: 'labor', name: service.title, qty: '1', unit: 'each', priceCents: input.lines[i].priceCents, taxable: false, taxCategory: 'detailing' }))),
    ] : []),
    db.insert(estimateIntakes).values({ orderId: id }),
    db.insert(serviceOrderEvents).values({ serviceOrderId: id, eventType: 'estimate_intake', employeeName: actor, newStatus: 'estimate' }),
  ]
  try {
    // batch() requires a non-empty tuple; the service-order/job/estimate/intake/event
    // inserts are unconditional, so `statements` always has at least those five.
    await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]])
  } catch (error) {
    const [retry] = await db.select().from(estimateIntakes).where(eq(estimateIntakes.orderId, id))
    if (!retry) throw error
  }
  const estimate = await getEstimateRow(id)
  if (estimate) await recomputeEstimate(estimate.id)
  return id
}

export async function listIntakes() {
  return getDb().select({ order: serviceOrders, vehicle: vehicles, estimate: jobEstimates, intake: estimateIntakes })
    .from(estimateIntakes).innerJoin(serviceOrders, eq(serviceOrders.id, estimateIntakes.orderId))
    .innerJoin(vehicles, eq(vehicles.id, serviceOrders.vehicleId))
    .innerJoin(jobEstimates, eq(jobEstimates.serviceOrderId, serviceOrders.id))
    .orderBy(desc(serviceOrders.createdAt))
}

export async function withIntakeLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const db = getDb()
  const stamp = new Date()
  const claimed = await db.update(estimateIntakes).set({ lockedAt: stamp }).where(and(
    eq(estimateIntakes.orderId, id),
    or(isNull(estimateIntakes.lockedAt), sql`${estimateIntakes.lockedAt} < now() - interval '10 minutes'`),
  )).returning()
  if (!claimed.length) throw new Error('This estimate is busy. Please try again shortly.')
  try { return await work() }
  finally {
    await db.update(estimateIntakes).set({ lockedAt: null }).where(and(eq(estimateIntakes.orderId, id), eq(estimateIntakes.lockedAt, stamp)))
  }
}

export async function moveIntakeToBoard(id: string, actor: string) {
  // Single statement: only the winning transition updates pricing/approval/audit.
  // Retains the SAME job, contact, estimate, line items, and QuickBooks estimate link.
  const result = await getDb().execute(sql`
    WITH moved AS (
      UPDATE service_orders so SET status = 'arrived', arrived_at = now(), updated_at = now(),
        services = (SELECT jsonb_agg(s.title ORDER BY s.sort_order, s.created_at)
          FROM job_services s JOIN job_estimates e ON e.id = s.job_estimate_id
          WHERE e.service_order_id = so.id AND s.source <> 'system'),
        quoted_price_cents = e.total_cents, approved_price_cents = e.total_cents
      FROM job_estimates e
      WHERE so.id = ${id}::uuid AND so.status = 'estimate' AND e.service_order_id = so.id
        AND e.total_cents > 0 AND EXISTS (SELECT 1 FROM job_services s WHERE s.job_estimate_id = e.id AND s.source <> 'system')
      RETURNING so.id
    ), approved AS (
      UPDATE job_services SET approval_state = 'approved', updated_at = now()
      WHERE job_estimate_id IN (SELECT id FROM job_estimates WHERE service_order_id IN (SELECT id FROM moved))
    ), converted AS (
      UPDATE job_estimates SET status = 'converted', decided_at = now(), converted_at = now(), updated_at = now(), updated_by = ${actor}
      WHERE service_order_id IN (SELECT id FROM moved)
    )
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, old_status, new_status, note)
    SELECT id, 'estimate_converted', ${actor}, 'estimate', 'arrived', 'Customer approved estimate; moved to Work Board' FROM moved
    RETURNING service_order_id
  `)
  if (!result.rows.length) {
    const [order] = await getDb().select().from(serviceOrders).where(eq(serviceOrders.id, id))
    if (!order || order.status === 'estimate') throw new Error('Add services and a price before moving this estimate to the Work Board.')
  }
}
