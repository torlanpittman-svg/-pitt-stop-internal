/**
 * Customer profile + history read model.
 *
 * Reconciles the fragmented customer representations (canonical directory `customers`,
 * denormalized `service_orders.customer_name`, and `quick_entry_jobs` contact strings)
 * WITHOUT destructively merging records. A service order is attached to a customer only by:
 *   1. an explicit `service_orders.customer_id` link (set going forward from a profile), OR
 *   2. a vehicle owned by this customer (`customer_vehicles` — explicit curated data), OR
 *   3. an EXACT normalized phone/email match captured in `quick_entry_jobs`.
 * Never by name alone — so an uncertain name collision can never expose another person's records.
 *
 * Each history row reports how it matched (`matchedBy`) and who authorized the work
 * (`authorizedBy` = the order's captured name), which may differ from the vehicle's current owner.
 */
import { getDb } from '@/platform/db'
import { sql } from 'drizzle-orm'

// Neon-http returns { rows }, PGlite likewise; stay defensive in case a driver returns a bare array.
const rowsOf = <T,>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[])) as T[]

export interface CustomerSearchResult {
  id: string
  name: string
  subtitle: string
  phone: string | null
  customerType: string
  /** What matched: the customer's own fields, or one of their vehicles (plate/VIN). */
  matchedVia: 'customer' | 'vehicle'
}

interface CustomerSearchRow {
  id: string; display_name: string | null; first_name: string | null; last_name: string | null
  company: string | null; phone: string | null; email: string | null; customer_type: string | null
  vehicle_hit: boolean
}

/**
 * Search the customer directory by name, phone, email, AND owned-vehicle plate/VIN — so a plate or
 * VIN query on /customers resolves to the owning customer (the global `customers` search category,
 * which only looks at customer fields, cannot do this). Parameterised; active customers only.
 */
export async function searchCustomers(query: string, limit = 20): Promise<CustomerSearchResult[]> {
  const q = (query ?? '').trim()
  if (q.length < 2) return []
  const db = getDb()

  const like = `%${q.toLowerCase()}%`
  const digits = q.replace(/\D/g, '')
  const digitsLike = `%${digits}%`
  const alnum = q.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const alnumLike = `%${alnum}%`
  const lim = Math.min(Math.max(limit, 1), 50)

  const res = await db.execute(sql`
    SELECT c.id, c.display_name, c.first_name, c.last_name, c.company, c.phone, c.email, c.customer_type,
      bool_or(
        (${alnum} <> '' AND (
          regexp_replace(upper(coalesce(v.vin,'')), '[^A-Z0-9]', '', 'g') LIKE ${alnumLike}
          OR regexp_replace(upper(coalesce(v.license_plate,'')), '[^A-Z0-9]', '', 'g') LIKE ${alnumLike}))
      ) AS vehicle_hit
    FROM customers c
    LEFT JOIN customer_vehicles cv ON cv.customer_id = c.id
    LEFT JOIN vehicles v ON v.id = cv.vehicle_id
    WHERE c.active = true AND (
      c.display_name ILIKE ${like}
      OR c.first_name ILIKE ${like}
      OR c.last_name  ILIKE ${like}
      OR c.company    ILIKE ${like}
      OR c.email      ILIKE ${like}
      OR (${digits} <> '' AND regexp_replace(coalesce(c.normalized_phone,''), '\\D', '', 'g') LIKE ${digitsLike})
      OR (${alnum} <> '' AND regexp_replace(upper(coalesce(v.vin,'')), '[^A-Z0-9]', '', 'g') LIKE ${alnumLike})
      OR (${alnum} <> '' AND regexp_replace(upper(coalesce(v.license_plate,'')), '[^A-Z0-9]', '', 'g') LIKE ${alnumLike})
    )
    GROUP BY c.id, c.display_name, c.first_name, c.last_name, c.company, c.phone, c.email, c.customer_type
    ORDER BY c.display_name ASC NULLS LAST
    LIMIT ${lim}
  `)

  return rowsOf<CustomerSearchRow>(res).map((r) => {
    const name = r.display_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || r.company || 'Customer'
    const subtitle = [r.phone, r.email].filter(Boolean).join(' · ') || '—'
    return {
      id: r.id,
      name,
      subtitle,
      phone: r.phone,
      customerType: r.customer_type ?? 'retail',
      matchedVia: r.vehicle_hit ? 'vehicle' : 'customer',
    }
  })
}

export interface CustomerVehicle {
  id: string
  year: string | null
  make: string | null
  model: string | null
  color: string | null
  vin: string | null
  licensePlate: string | null
  relationship: string
}

export interface CustomerProfile {
  id: string
  displayName: string
  firstName: string | null
  lastName: string | null
  company: string | null
  phone: string | null
  email: string | null
  customerType: string
  source: string
  active: boolean
  vehicles: CustomerVehicle[]
  openJobCount: number
}

export type HistoryMatch = 'linked' | 'contact' | 'vehicle'
export type HistoryKind = 'repair_order' | 'estimate'
/**
 * 'own'     — this customer authorized the order (customer_id link or a UNIQUE phone/email match).
 *             Financial details belong to them and may be shown (subject to role).
 * 'vehicle' — prior/other service on a vehicle they currently own, NOT authorized by them. This is
 *             the vehicle's service record, not their transaction. The authorizer, amounts, and
 *             invoice (another person's contact + financial data) are ALWAYS stripped server-side.
 */
export type HistoryScope = 'own' | 'vehicle'

export interface HistoryItem {
  orderId: string
  orderNumber: string
  kind: HistoryKind
  status: string
  /** ISO date used for ordering: completed → arrived → created. */
  date: string | null
  vehicleId: string
  vehicleLabel: string
  services: string[]
  scope: HistoryScope
  /** Best-available amount in cents (own scope only; manager-only on the wire). */
  amountCents: number | null
  /** The person who authorized this order (own scope only; null for vehicle-service rows). */
  authorizedBy: string | null
  matchedBy: HistoryMatch
  invoice: { number: string | null; status: string } | null
}

export interface HistoryPage {
  items: HistoryItem[]
  total: number
  hasMore: boolean
  limit: number
  offset: number
}

export function normalizePhone(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
}
export function normalizeEmail(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase()
}

function vehicleLabel(r: { year: string | null; make: string | null; model: string | null; color: string | null }): string {
  const ymm = [r.year, r.make, r.model].filter(Boolean).join(' ')
  const color = (r.color ?? '').trim()
  return ymm ? (color ? `${ymm} · ${color}` : ymm) : 'Unknown Vehicle'
}

interface CustomerBaseRow {
  id: string; display_name: string | null; first_name: string | null; last_name: string | null
  company: string | null; phone: string | null; normalized_phone: string | null
  email: string | null; normalized_email: string | null; customer_type: string | null
  source: string | null; active: boolean
}

export async function getCustomerProfile(customerId: string): Promise<CustomerProfile | null> {
  const db = getDb()
  const base = await db.execute(sql`
    SELECT id, display_name, first_name, last_name, company, phone, normalized_phone,
           email, normalized_email, customer_type, source, active
    FROM customers WHERE id = ${customerId} LIMIT 1
  `)
  const c = rowsOf<CustomerBaseRow>(base)[0]
  if (!c) return null

  const vehRes = await db.execute(sql`
    SELECT v.id, v.year, v.make, v.model, v.color, v.vin, v.license_plate, cv.relationship
    FROM customer_vehicles cv
    JOIN vehicles v ON v.id = cv.vehicle_id
    WHERE cv.customer_id = ${customerId}
    ORDER BY cv.last_seen_at DESC NULLS LAST, v.created_at DESC
  `)
  const vehicles = rowsOf<{ id: string; year: string | null; make: string | null; model: string | null; color: string | null; vin: string | null; license_plate: string | null; relationship: string }>(vehRes)
    .map((r) => ({
      id: r.id, year: r.year, make: r.make, model: r.model, color: r.color,
      vin: r.vin, licensePlate: r.license_plate, relationship: r.relationship ?? 'owner',
    }))

  const openRes = await db.execute(sql`
    SELECT count(*)::int AS n FROM service_orders so
    WHERE so.customer_id = ${customerId}
      AND so.status NOT IN ('delivered','cancelled','estimate')
  `)
  const openJobCount = rowsOf<{ n: number }>(openRes)[0]?.n ?? 0

  const displayName = c.display_name
    || [c.first_name, c.last_name].filter(Boolean).join(' ')
    || c.company
    || 'Customer'

  return {
    id: c.id,
    displayName,
    firstName: c.first_name,
    lastName: c.last_name,
    company: c.company,
    phone: c.phone,
    email: c.email,
    customerType: c.customer_type ?? 'retail',
    source: c.source ?? 'manual',
    active: c.active,
    vehicles,
    openJobCount,
  }
}

interface HistoryRow {
  id: string; order_number: string; status: string; services: unknown
  completed_at: string | null; arrived_at: string | null; created_at: string
  customer_name: string | null; match_rank: number
  vehicle_id: string; year: string | null; make: string | null; model: string | null; color: string | null
  approved_price_cents: number | null; quoted_price_cents: number | null
  total_cents: number | null; agreed_price_cents: number | null
  qb_invoice_number: string | null; qb_status: string | null
}

// Obvious placeholder contacts that must never be treated as a unique identity (see the shared
// no@no.com QuickBooks bug). A phone shorter than 7 digits is too ambiguous to key on.
export const PLACEHOLDER_EMAILS = new Set(['no@no.com', 'none@none.com', 'na@na.com', 'test@test.com'])

/**
 * The customer's phone/email ONLY if it uniquely identifies them in the directory. A phone/email
 * shared by more than one customer (families, shops, placeholders) returns '' so it is never used to
 * attribute an order — that would be ambiguous and could surface someone else's work.
 */
async function uniqueContact(customerId: string): Promise<{ uphone: string; uemail: string }> {
  const db = getDb()
  const res = await db.execute(sql`
    SELECT normalized_phone, normalized_email FROM customers WHERE id = ${customerId} LIMIT 1
  `)
  const row = rowsOf<{ normalized_phone: string | null; normalized_email: string | null }>(res)[0]
  if (!row) return { uphone: '', uemail: '' }
  const nphone = normalizePhone(row.normalized_phone)
  const nemail = normalizeEmail(row.normalized_email)

  const okPhone = nphone.length >= 7
  const okEmail = nemail.length > 0 && !PLACEHOLDER_EMAILS.has(nemail)

  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM customers
         WHERE active = true AND ${okPhone}
           AND regexp_replace(coalesce(normalized_phone,''), '\\D', '', 'g') = ${nphone}) AS pc,
      (SELECT count(*)::int FROM customers
         WHERE active = true AND ${okEmail}
           AND lower(trim(coalesce(normalized_email,''))) = ${nemail}) AS ec
  `)
  const c = rowsOf<{ pc: number; ec: number }>(counts)[0] ?? { pc: 0, ec: 0 }
  return {
    uphone: okPhone && c.pc === 1 ? nphone : '',
    uemail: okEmail && c.ec === 1 ? nemail : '',
  }
}

function mapHistoryRow(r: HistoryRow, scope: HistoryScope): HistoryItem {
  const services = Array.isArray(r.services) ? (r.services as string[]) : []
  const own = scope === 'own'
  const amountCents = own
    ? (r.approved_price_cents ?? r.quoted_price_cents ?? r.total_cents ?? r.agreed_price_cents ?? null)
    : null
  const matchedBy: HistoryMatch = scope === 'vehicle' ? 'vehicle' : r.match_rank >= 2 ? 'linked' : 'contact'
  const invoice = own && (r.qb_invoice_number || (r.qb_status && r.qb_status !== 'none'))
    ? { number: r.qb_invoice_number, status: r.qb_status ?? 'none' }
    : null
  return {
    orderId: r.id,
    orderNumber: r.order_number,
    kind: r.status === 'estimate' ? 'estimate' : 'repair_order',
    status: r.status,
    date: r.completed_at ?? r.arrived_at ?? r.created_at ?? null,
    vehicleId: r.vehicle_id,
    vehicleLabel: vehicleLabel(r),
    services,
    scope,
    amountCents,
    // Vehicle-service rows never reveal the (different) authorizer — another person's contact detail.
    authorizedBy: own ? r.customer_name : null,
    matchedBy,
    invoice,
  }
}

// SQL predicate: an order this customer AUTHORIZED — linked by id, or a UNIQUE phone/email match.
function ownPredicate(customerId: string, uphone: string, uemail: string) {
  // COALESCE keeps the result boolean (never NULL) so `NOT (own)` works for customer_id IS NULL rows.
  return sql`(
    COALESCE(so.customer_id = ${customerId}, false)
    OR (${uphone} <> '' AND EXISTS (
      SELECT 1 FROM quick_entry_jobs q WHERE q.service_order_id = so.id
        AND regexp_replace(coalesce(q.customer_phone,''), '\\D', '', 'g') = ${uphone}))
    OR (${uemail} <> '' AND EXISTS (
      SELECT 1 FROM quick_entry_jobs q WHERE q.service_order_id = so.id
        AND lower(trim(coalesce(q.customer_email,''))) = ${uemail}))
  )`
}

const HISTORY_SELECT = sql`
  so.id, so.order_number, so.status, so.services, so.customer_name,
  so.completed_at, so.arrived_at, so.created_at,
  so.vehicle_id, v.year, v.make, v.model, v.color,
  so.approved_price_cents, so.quoted_price_cents,
  je.total_cents, je.agreed_price_cents, je.qb_invoice_number, je.qb_status`

/**
 * The customer's OWN transaction history — orders they authorized (id link or a UNIQUE contact
 * match). Financial details are theirs. `total` reflects the full matched set so older records are
 * never silently dropped. Current vehicle ownership alone does NOT place an order here.
 */
export async function getCustomerHistory(
  customerId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<HistoryPage> {
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const offset = Math.max(opts.offset ?? 0, 0)

  const { uphone, uemail } = await uniqueContact(customerId)
  const own = ownPredicate(customerId, uphone, uemail)

  const countRes = await db.execute(sql`SELECT count(*)::int AS n FROM service_orders so WHERE ${own}`)
  const total = rowsOf<{ n: number }>(countRes)[0]?.n ?? 0

  const pageRes = await db.execute(sql`
    SELECT ${HISTORY_SELECT},
      (CASE WHEN so.customer_id = ${customerId} THEN 2 ELSE 1 END) AS match_rank
    FROM service_orders so
    JOIN vehicles v ON v.id = so.vehicle_id
    LEFT JOIN job_estimates je ON je.service_order_id = so.id
    WHERE ${own}
    ORDER BY COALESCE(so.completed_at, so.arrived_at, so.created_at) DESC
    LIMIT ${limit} OFFSET ${offset}`)
  const items = rowsOf<HistoryRow>(pageRes).map((r) => mapHistoryRow(r, 'own'))
  return { items, total, hasMore: offset + items.length < total, limit, offset }
}

/**
 * Prior/other service on vehicles the customer CURRENTLY owns, that they did NOT authorize. This is
 * the vehicle's service record, shown separately. Amounts, invoices, and the (different) authorizer
 * are stripped server-side for EVERY role — a previous owner's financial/contact data is never
 * attributed to this customer.
 */
export async function getVehicleServiceHistory(
  customerId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<HistoryPage> {
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const offset = Math.max(opts.offset ?? 0, 0)

  const { uphone, uemail } = await uniqueContact(customerId)
  const own = ownPredicate(customerId, uphone, uemail)
  const vehiclePred = sql`
    so.vehicle_id IN (SELECT vehicle_id FROM customer_vehicles WHERE customer_id = ${customerId})
    AND NOT ${own}`

  const countRes = await db.execute(sql`SELECT count(*)::int AS n FROM service_orders so WHERE ${vehiclePred}`)
  const total = rowsOf<{ n: number }>(countRes)[0]?.n ?? 0

  const pageRes = await db.execute(sql`
    SELECT ${HISTORY_SELECT}, 0 AS match_rank
    FROM service_orders so
    JOIN vehicles v ON v.id = so.vehicle_id
    LEFT JOIN job_estimates je ON je.service_order_id = so.id
    WHERE ${vehiclePred}
    ORDER BY COALESCE(so.completed_at, so.arrived_at, so.created_at) DESC
    LIMIT ${limit} OFFSET ${offset}`)
  const items = rowsOf<HistoryRow>(pageRes).map((r) => mapHistoryRow(r, 'vehicle'))
  return { items, total, hasMore: offset + items.length < total, limit, offset }
}

/** Strip manager-only pricing/invoice fields for employee views (applies to own-scope rows). */
export function redactHistoryForEmployee(items: HistoryItem[]): HistoryItem[] {
  return items.map((i) => ({ ...i, amountCents: null, invoice: null }))
}
