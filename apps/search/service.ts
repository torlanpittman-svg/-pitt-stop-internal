/**
 * The ONE coherent search service — indexed database reads against the CANONICAL operational tables.
 *
 * Design guarantees:
 *   - Direct, parameterised SQL (drizzle sql`` — every value is a bound parameter, so any input,
 *     including SQL metacharacters, is pure data). No user text is ever concatenated into SQL.
 *   - Only the categories the actor's SCOPE allows are queried (managers-only receipts/checks are never
 *     even read for an ordinary employee).
 *   - Each category read is itself LIMITed, then assemble.ts ranks + applies the per-category / overall
 *     caps — results can never be unbounded.
 *   - Matches structured metadata only. It never scans image bytes / OCR blobs; receipt search reads the
 *     small confirmed-value + filename fields, not stored images.
 *   - No parallel tables: vehicles ← workflow.vehicles, jobs ← service_orders, auto_sales ←
 *     inventory_vehicles, checks ← checks, receipts ← vehicle_documents, customers ← directory.customers.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import type { ParsedQuery } from './normalize'
import type { SearchScope } from './authz'
import { assembleResults, type RawCandidate, type AssembleLimits } from './assemble'
import type { SearchResponse } from './types'

/** Per-category DB read cap (before ranking). Higher than the display cap so ranking has candidates. */
const DB_LIMIT = 40

const vinLast4 = (vin: string | null | undefined) => (vin ? `····${vin.slice(-4)}` : null)
const ymm = (y?: string | null, mk?: string | null, md?: string | null) => [y, mk, md].filter(Boolean).join(' ')
const money = (cents: number | null | undefined) =>
  cents == null ? null : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const rowsOf = <T,>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[])) as T[]

/** Run the allowed category queries, then rank + cap deterministically. The single search entry point. */
export async function executeSearch(
  parsed: ParsedQuery,
  scope: SearchScope,
  limits: AssembleLimits = {},
): Promise<SearchResponse> {
  const tasks: Array<Promise<RawCandidate[]>> = []
  if (scope.categories.has('customers'))  tasks.push(queryCustomers(parsed))
  if (scope.categories.has('vehicles'))   tasks.push(queryVehicles(parsed))
  if (scope.categories.has('jobs'))       tasks.push(queryJobs(parsed))
  if (scope.categories.has('auto_sales')) tasks.push(queryAutoSales(parsed))
  if (scope.categories.has('receipts'))   tasks.push(queryReceipts(parsed))
  if (scope.categories.has('checks'))     tasks.push(queryChecks(parsed))

  const settled = await Promise.all(tasks)
  const candidates = settled.flat()
  return assembleResults(parsed, scope, candidates, limits)
}

// ── Fragments ───────────────────────────────────────────────────────────────
// `%alnum%` (VIN/plate/stock) — alnum is [A-Z0-9] only, so it carries no LIKE wildcards.
const alnumContains = (p: ParsedQuery) => `%${p.alnum}%`
const digitsContains = (p: ParsedQuery) => `%${p.digits}%`

// ── Customers (directory) ─────────────────────────────────────────────────────
interface CustomerRow {
  id: string; display_name: string | null; first_name: string | null; last_name: string | null
  company: string | null; phone: string | null; email: string | null; customer_type: string | null
}
async function queryCustomers(p: ParsedQuery): Promise<RawCandidate[]> {
  const db = getDb()
  const phoneClause = p.digits.length >= 3
    ? sql`OR c.normalized_phone LIKE ${digitsContains(p)}`
    : sql``
  const res = await db.execute(sql`
    SELECT c.id, c.display_name, c.first_name, c.last_name, c.company, c.phone, c.email, c.customer_type
    FROM customers c
    WHERE c.active = true AND (
      c.display_name ILIKE ${p.likeContains}
      OR c.first_name ILIKE ${p.likeContains}
      OR c.last_name  ILIKE ${p.likeContains}
      OR c.company    ILIKE ${p.likeContains}
      OR c.email      ILIKE ${p.likeContains}
      ${phoneClause}
    )
    ORDER BY c.display_name ASC
    LIMIT ${DB_LIMIT}
  `)
  return rowsOf<CustomerRow>(res).map((r) => {
    const name = r.display_name || ymm(r.first_name, r.last_name) || r.company || 'Customer'
    const subParts = [r.phone, r.email].filter(Boolean) as string[]
    return {
      category: 'customers',
      id: r.id,
      href: null, // no standalone customer page — contact card w/ tap-to-call; jobs/vehicles are the navigable records
      title: name,
      subtitle: subParts.join(' · ') || '—',
      badge: r.customer_type || undefined,
      phone: r.phone || undefined,
      sortKey: name.toLowerCase(),
      matchFields: { ids: [r.phone, r.email], text: [r.display_name, r.first_name, r.last_name, r.company] },
    }
  })
}

// ── Vehicles (canonical service/customer vehicles; inventory shown under Auto Sales instead) ──────────
interface VehicleRow {
  id: string; vin: string | null; year: string | null; make: string | null; model: string | null
  color: string | null; license_plate: string | null; customer_name: string | null; latest_order_id: string | null
}
async function queryVehicles(p: ParsedQuery): Promise<RawCandidate[]> {
  const db = getDb()
  const alnumClause = p.alnum.length >= 2
    ? sql`OR upper(coalesce(v.vin,'')) LIKE ${alnumContains(p)}
          OR regexp_replace(upper(coalesce(v.license_plate,'')), '[^A-Z0-9]', '', 'g') LIKE ${alnumContains(p)}`
    : sql``
  const res = await db.execute(sql`
    SELECT v.id, v.vin, v.year, v.make, v.model, v.color, v.license_plate,
           cust.display_name AS customer_name,
           so.id AS latest_order_id
    FROM vehicles v
    LEFT JOIN inventory_vehicles iv ON iv.vehicle_id = v.id
    LEFT JOIN LATERAL (SELECT cv.customer_id FROM customer_vehicles cv WHERE cv.vehicle_id = v.id LIMIT 1) cvx ON true
    LEFT JOIN customers cust ON cust.id = cvx.customer_id
    LEFT JOIN LATERAL (
      SELECT s.id FROM service_orders s WHERE s.vehicle_id = v.id AND s.status <> 'cancelled'
      ORDER BY s.created_at DESC LIMIT 1
    ) so ON true
    WHERE iv.id IS NULL AND (
      v.license_plate ILIKE ${p.likeContains}
      OR (coalesce(v.year,'') || ' ' || coalesce(v.make,'') || ' ' || coalesce(v.model,'')) ILIKE ${p.likeContains}
      OR cust.display_name ILIKE ${p.likeContains}
      ${alnumClause}
    )
    ORDER BY v.created_at DESC
    LIMIT ${DB_LIMIT}
  `)
  return rowsOf<VehicleRow>(res).map((r) => {
    const href = r.latest_order_id ? `/orders/${r.latest_order_id}` : null
    const sub = [vinLast4(r.vin), r.license_plate, r.customer_name].filter(Boolean).join(' · ')
    return {
      category: 'vehicles',
      id: r.id,
      href,
      title: ymm(r.year, r.make, r.model) || 'Vehicle',
      subtitle: sub || '—',
      badge: r.color || undefined,
      matchFields: { ids: [r.vin, r.license_plate], text: [ymm(r.year, r.make, r.model), r.customer_name] },
    }
  })
}

// ── Jobs (service_orders — also the destination for vehicle & service searches) ───────────────────────
interface JobRow {
  id: string; order_number: string | null; status: string | null; customer_name: string | null
  services: unknown; service_text: string | null; is_urgent: boolean | null; source: string | null
  created_at: string; year: string | null; make: string | null; model: string | null
  vin: string | null; license_plate: string | null; qb_invoice_number: string | null
}
async function queryJobs(p: ParsedQuery): Promise<RawCandidate[]> {
  const db = getDb()
  const alnumClause = p.alnum.length >= 2
    ? sql`OR upper(coalesce(v.vin,'')) LIKE ${alnumContains(p)}
          OR regexp_replace(upper(coalesce(v.license_plate,'')), '[^A-Z0-9]', '', 'g') LIKE ${alnumContains(p)}`
    : sql``
  const res = await db.execute(sql`
    SELECT so.id, so.order_number, so.status, so.customer_name, so.services, so.is_urgent, so.source,
           so.created_at, v.year, v.make, v.model, v.vin, v.license_plate, je.qb_invoice_number,
           (coalesce(CAST(so.services AS text), '') || ' ' ||
            coalesce((SELECT string_agg(coalesce(js.title,'') || ' ' || coalesce(jli.name,'') || ' ' || coalesce(jli.description,''), ' ')
                      FROM job_services js LEFT JOIN job_line_items jli ON jli.job_service_id = js.id
                      WHERE js.job_estimate_id = je.id), '') || ' ' ||
            coalesce((SELECT string_agg(ql.name, ' ')
                      FROM quick_entry_jobs qj JOIN quick_entry_job_lines ql ON ql.job_id = qj.id
                      WHERE qj.service_order_id = so.id), '')) AS service_text
    FROM service_orders so
    JOIN vehicles v ON v.id = so.vehicle_id
    LEFT JOIN job_estimates je ON je.service_order_id = so.id
    WHERE so.status <> 'cancelled' AND (
      so.order_number ILIKE ${p.likeContains}
      OR so.customer_name ILIKE ${p.likeContains}
      OR (coalesce(v.year,'') || ' ' || coalesce(v.make,'') || ' ' || coalesce(v.model,'')) ILIKE ${p.likeContains}
      OR CAST(so.services AS text) ILIKE ${p.likeContains}
      OR je.qb_invoice_number ILIKE ${p.likeContains}
      OR EXISTS (SELECT 1 FROM job_services js LEFT JOIN job_line_items jli ON jli.job_service_id = js.id
                 WHERE js.job_estimate_id = je.id
                   AND (js.title ILIKE ${p.likeContains} OR jli.name ILIKE ${p.likeContains} OR jli.description ILIKE ${p.likeContains}))
      OR EXISTS (SELECT 1 FROM quick_entry_jobs qj JOIN quick_entry_job_lines ql ON ql.job_id = qj.id
                 WHERE qj.service_order_id = so.id AND ql.name ILIKE ${p.likeContains})
      ${alnumClause}
    )
    ORDER BY so.created_at DESC
    LIMIT ${DB_LIMIT + 20}
  `)
  return rowsOf<JobRow>(res).map((r) => {
    const svcArr = Array.isArray(r.services) ? (r.services as string[]) : []
    const svcLabel = svcArr.filter(Boolean).slice(0, 3).join(', ')
    const sub = [ymm(r.year, r.make, r.model), vinLast4(r.vin)].filter(Boolean).join(' · ')
    return {
      category: 'jobs',
      id: r.id,
      href: `/orders/${r.id}`,
      title: [r.order_number, r.customer_name].filter(Boolean).join(' · ') || 'Job',
      subtitle: sub || '—',
      meta: svcLabel || undefined,
      badge: [r.is_urgent ? 'urgent' : null, r.status].filter(Boolean).join(' · ') || undefined,
      sortKey: r.created_at,
      matchFields: {
        ids: [r.order_number, r.vin, r.license_plate, r.qb_invoice_number],
        text: [r.customer_name, ymm(r.year, r.make, r.model), r.service_text],
      },
    }
  })
}

// ── Auto Sales (inventory_vehicles) — NO financial amounts in results ─────────────────────────────────
interface AutoSalesRow {
  id: string; stock_number: string | null; status: string | null; created_at: string
  year: string | null; make: string | null; model: string | null; vin: string | null
}
async function queryAutoSales(p: ParsedQuery): Promise<RawCandidate[]> {
  const db = getDb()
  const alnumClause = p.alnum.length >= 2 ? sql`OR upper(coalesce(v.vin,'')) LIKE ${alnumContains(p)}` : sql``
  const res = await db.execute(sql`
    SELECT iv.id, iv.stock_number, iv.status, iv.created_at, v.year, v.make, v.model, v.vin
    FROM inventory_vehicles iv
    JOIN vehicles v ON v.id = iv.vehicle_id
    WHERE (
      iv.stock_number ILIKE ${p.likeContains}
      OR iv.status ILIKE ${p.likeContains}
      OR (coalesce(v.year,'') || ' ' || coalesce(v.make,'') || ' ' || coalesce(v.model,'')) ILIKE ${p.likeContains}
      ${alnumClause}
    )
    ORDER BY iv.created_at DESC
    LIMIT ${DB_LIMIT}
  `)
  return rowsOf<AutoSalesRow>(res).map((r) => {
    const sub = [r.stock_number, vinLast4(r.vin)].filter(Boolean).join(' · ')
    return {
      category: 'auto_sales',
      id: r.id,
      href: `/auto-sales/${r.id}`,
      title: ymm(r.year, r.make, r.model) || r.stock_number || 'Inventory vehicle',
      subtitle: sub || '—',
      badge: r.status || undefined,
      sortKey: r.created_at,
      matchFields: { ids: [r.stock_number, r.vin], text: [ymm(r.year, r.make, r.model), r.status] },
    }
  })
}

// ── Receipts (vehicle_documents) — MANAGER-only; structured metadata only, never image bytes ──────────
interface ReceiptRow {
  id: string; filename: string | null; doc_type: string | null; receipt_total_cents: number | null
  created_at: string; notes: string | null; merchant: string | null; inv_id: string
  year: string | null; make: string | null; model: string | null; stock_number: string | null
}
async function queryReceipts(p: ParsedQuery): Promise<RawCandidate[]> {
  const db = getDb()
  const res = await db.execute(sql`
    SELECT d.id, d.filename, d.doc_type, d.receipt_total_cents, d.created_at, d.notes,
           coalesce(d.confirmed->>'vendor', d.confirmed->>'merchant') AS merchant,
           iv.id AS inv_id, iv.stock_number, v.year, v.make, v.model
    FROM vehicle_documents d
    JOIN inventory_vehicles iv ON iv.id = d.inventory_vehicle_id
    JOIN vehicles v ON v.id = iv.vehicle_id
    WHERE (
      d.filename ILIKE ${p.likeContains}
      OR d.notes ILIKE ${p.likeContains}
      OR coalesce(d.confirmed->>'vendor', d.confirmed->>'merchant') ILIKE ${p.likeContains}
      OR iv.stock_number ILIKE ${p.likeContains}
      OR (coalesce(v.year,'') || ' ' || coalesce(v.make,'') || ' ' || coalesce(v.model,'')) ILIKE ${p.likeContains}
    )
    ORDER BY d.created_at DESC
    LIMIT ${DB_LIMIT}
  `)
  return rowsOf<ReceiptRow>(res).map((r) => {
    const date = (r.created_at || '').slice(0, 10)
    const sub = [date, money(r.receipt_total_cents), ymm(r.year, r.make, r.model)].filter(Boolean).join(' · ')
    return {
      category: 'receipts',
      id: r.id,
      href: `/auto-sales/${r.inv_id}`,
      title: r.merchant || r.filename || 'Receipt',
      subtitle: sub || '—',
      badge: r.doc_type || undefined,
      sortKey: r.created_at,
      matchFields: { ids: [r.stock_number], text: [r.merchant, r.filename, r.notes, ymm(r.year, r.make, r.model)] },
    }
  })
}

// ── Checks — MANAGER-only (Write-a-Check permission). Amounts only reach managers. ────────────────────
interface CheckRow {
  id: string; check_number: number; payee_name: string | null; memo: string | null
  amount_cents: number; qb_status: string | null; check_date: string; entity: string | null; created_at: string
}
async function queryChecks(p: ParsedQuery): Promise<RawCandidate[]> {
  const db = getDb()
  const res = await db.execute(sql`
    SELECT id, check_number, payee_name, memo, amount_cents, qb_status, check_date, entity, created_at
    FROM checks
    WHERE (
      CAST(check_number AS text) ILIKE ${p.likeContains}
      OR payee_name ILIKE ${p.likeContains}
      OR memo ILIKE ${p.likeContains}
    )
    ORDER BY created_at DESC
    LIMIT ${DB_LIMIT}
  `)
  return rowsOf<CheckRow>(res).map((r) => {
    const num = String(r.check_number)
    const sub = [r.check_date, money(r.amount_cents)].filter(Boolean).join(' · ')
    return {
      category: 'checks',
      id: r.id,
      href: `/checks/${r.id}`,
      title: `#${num} · ${r.payee_name || 'Payee'}`,
      subtitle: sub || '—',
      badge: [r.entity === 'auto_sales' ? 'auto sales' : null, r.qb_status].filter(Boolean).join(' · ') || undefined,
      sortKey: r.created_at,
      matchFields: { ids: [num], text: [r.payee_name, r.memo] },
    }
  })
}
