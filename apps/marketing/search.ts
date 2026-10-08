/**
 * Scoped, READ-ONLY lookups so a manager can link a lead to a real order/customer by human identifiers
 * (order number, customer name, vehicle) instead of pasting an opaque UUID. Bounded (LIMIT) and
 * parameterized. Callers are already manager-gated (the leads page + actions). No writes here.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'

function toRows<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] })?.rows ?? [])
}

/** Escape LIKE wildcards in user input, then wrap for a contains match. */
function contains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

export interface OrderMatch {
  serviceOrderId: string
  orderNumber: string | null
  customerId: string | null
  customerName: string | null
  vehicle: string | null
  status: string
  completedAt: Date | null
}

/** Find non-cancelled service orders by order number, customer name, or vehicle. Bounded. */
export async function searchLinkableOrders(query: string, limit = 20): Promise<OrderMatch[]> {
  const q = (query ?? '').trim()
  if (q.length < 2) return []
  const like = contains(q)
  const rows = toRows<{
    serviceOrderId: string; orderNumber: string | null; customerId: string | null
    customerName: string | null; vehicle: string | null; status: string; completedAt: string | Date | null
  }>(await getDb().execute(sql`
    SELECT so.id              AS "serviceOrderId",
           so.order_number    AS "orderNumber",
           so.customer_id     AS "customerId",
           so.customer_name   AS "customerName",
           so.status          AS status,
           so.completed_at    AS "completedAt",
           nullif(trim(concat_ws(' ', v.year, v.make, v.model)), '') AS vehicle
    FROM service_orders so
    LEFT JOIN vehicles v ON v.id = so.vehicle_id
    WHERE so.cancelled_at IS NULL
      AND (so.order_number ILIKE ${like}
           OR so.customer_name ILIKE ${like}
           OR concat_ws(' ', v.year, v.make, v.model) ILIKE ${like})
    ORDER BY so.created_at DESC
    LIMIT ${Math.min(50, Math.max(1, limit))}
  `))
  return rows.map((r) => ({
    serviceOrderId: r.serviceOrderId,
    orderNumber: r.orderNumber,
    customerId: r.customerId,
    customerName: r.customerName,
    vehicle: r.vehicle,
    status: r.status,
    completedAt: r.completedAt ? new Date(r.completedAt) : null,
  }))
}

export interface CustomerMatch {
  customerId: string
  name: string | null
  phone: string | null
  email: string | null
}

/** Find active directory customers by name, phone, or email. Bounded. */
export async function searchCustomers(query: string, limit = 20): Promise<CustomerMatch[]> {
  const q = (query ?? '').trim()
  if (q.length < 2) return []
  const like = contains(q)
  const rows = toRows<{ customerId: string; name: string | null; phone: string | null; email: string | null }>(await getDb().execute(sql`
    SELECT id AS "customerId",
           coalesce(nullif(display_name, ''), nullif(trim(concat_ws(' ', first_name, last_name)), '')) AS name,
           phone, email
    FROM customers
    WHERE active = true
      AND (display_name ILIKE ${like} OR first_name ILIKE ${like} OR last_name ILIKE ${like}
           OR phone ILIKE ${like} OR email ILIKE ${like})
    ORDER BY display_name NULLS LAST
    LIMIT ${Math.min(50, Math.max(1, limit))}
  `))
  return rows.map((r) => ({ customerId: r.customerId, name: r.name, phone: r.phone, email: r.email }))
}
