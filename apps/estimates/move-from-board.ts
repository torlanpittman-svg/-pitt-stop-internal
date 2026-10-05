import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { getBusinessConfig } from '@/apps/settings/db'

/** One atomic correction; retains the original job and all its linked detail. */
export async function moveBoardOrderToEstimates(id: string, actor: string) {
  const db = getDb()
  const config = await getBusinessConfig()
  const result = await db.execute(sql`
    WITH moved AS (
      UPDATE service_orders so SET status = 'estimate', arrived_at = NULL,
        approved_price_cents = NULL, updated_at = now()
      WHERE so.id = ${id}::uuid AND so.status = 'arrived'
        AND so.started_at IS NULL AND so.completed_at IS NULL
        AND so.cancelled_at IS NULL AND so.delivered_at IS NULL
        AND lower(so.source) NOT IN ('dealer', 'dealer_checkin')
        AND coalesce(lower(so.service_type), '') NOT LIKE 'dealer%'
        AND (lower(so.source) IN ('quick_entry', 'walk_in', 'vin_scan', 'retail', 'estimate')
          OR lower(so.service_type) LIKE 'retail%')
        AND NOT EXISTS (SELECT 1 FROM service_order_assignments a WHERE a.service_order_id = so.id)
        AND NOT EXISTS (SELECT 1 FROM dealer_scans d WHERE d.service_order_id = so.id)
        AND NOT EXISTS (SELECT 1 FROM job_estimates e WHERE e.service_order_id = so.id
          AND (e.qb_invoice_id IS NOT NULL OR e.qb_status <> 'none'))
        AND NOT EXISTS (SELECT 1 FROM estimate_intakes i WHERE i.order_id = so.id
          AND i.locked_at > now() - interval '10 minutes')
      RETURNING so.*
    ), intake AS (
      INSERT INTO estimate_intakes(order_id) SELECT id FROM moved
      ON CONFLICT (order_id) DO NOTHING
    ), estimate AS (
      INSERT INTO job_estimates(service_order_id, tax_rate_bps, explicit_tax_category, created_by, updated_by)
      SELECT id, ${config.defaultTaxBps}, 'detailing', ${actor}, ${actor} FROM moved
      ON CONFLICT (service_order_id) DO UPDATE SET status = 'draft', decided_at = NULL,
        converted_at = NULL, updated_at = now(), updated_by = ${actor}
    ), contact AS (
      INSERT INTO quick_entry_jobs(service_order_id, vehicle_id, customer_name, year, make, model, vin, created_by)
      SELECT m.id, m.vehicle_id, coalesce(m.customer_name, 'Customer'), v.year, v.make, v.model, v.vin, ${actor}
      FROM moved m JOIN vehicles v ON v.id = m.vehicle_id
      WHERE NOT EXISTS (SELECT 1 FROM quick_entry_jobs q WHERE q.service_order_id = m.id)
    ), audit AS (
      INSERT INTO service_order_events(service_order_id, event_type, employee_name, old_status, new_status, note)
      SELECT id, 'moved_to_estimates', ${actor}, 'arrived', 'estimate',
        'Corrected accidental Work Board entry; moved to Estimates with customer, vehicle, services, and pricing preserved.' FROM moved
    )
    SELECT id FROM moved
  `)
  if (result.rows.length) return
  const existing = await db.execute(sql`SELECT so.id FROM service_orders so
    JOIN estimate_intakes i ON i.order_id = so.id WHERE so.id = ${id}::uuid AND so.status = 'estimate'`)
  if (existing.rows.length) return
  throw new Error('Only retail jobs that have not started and have no invoice can move to Estimates. Refresh the job and try again.')
}
