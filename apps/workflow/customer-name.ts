/**
 * Correct a retail customer's NAME spelling in place (e.g. "Jake Mixell" → "Jake Mizell").
 *
 * Same authoritative records as the Job customer-correction route
 * (app/api/workflow/orders/[id]/customer): service_orders.customer_name + the Job's
 * quick_entry_jobs contact row — and, additionally, the LINKED canonical directory customer
 * (service_orders.customer_id), so the profile/search shows the corrected spelling too.
 * Every id and link is kept: no customer, vehicle, job, or estimate is created or re-pointed.
 *
 * The directory row is renamed only when it still carries the job's OLD name (display name or
 * first+last). A linked profile whose name already differs is a different spelling owned by
 * someone else (AutoLeap/QB import, manager edit) and is left untouched rather than overwritten.
 * The QuickBooks customer record is never written here.
 *
 * One SQL statement → atomic on neon-http. Audited as `customer_corrected` (append-only).
 */
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'

export const CUSTOMER_NAME_MAX = 200

export function cleanCustomerName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('Enter the customer name.')
  if (name.length > CUSTOMER_NAME_MAX) throw new Error(`Customer name must be ${CUSTOMER_NAME_MAX} characters or fewer.`)
  return name
}

/** Split for directory rows that store first/last separately ("Mary Ann Smith" → "Mary Ann" / "Smith"). */
export function splitName(name: string): { first: string; last: string | null } {
  const parts = name.split(' ')
  if (parts.length === 1) return { first: name, last: null }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

export interface CustomerRenameResult {
  changed: boolean
  before: string | null
  after: string
  directoryCustomerId: string | null
}

export async function renameOrderCustomer(orderId: string, rawName: string, actor: string | null): Promise<CustomerRenameResult> {
  const name = cleanCustomerName(rawName)
  const { first, last } = splitName(name)
  const db = getDb()
  const [current] = (await db.execute(sql`SELECT customer_name FROM service_orders WHERE id = ${orderId}::uuid`)).rows as { customer_name: string | null }[]
  if (!current) throw new Error('Estimate not found.')
  if (current.customer_name === name) return { changed: false, before: current.customer_name, after: name, directoryCustomerId: null }

  const result = await db.execute(sql`
    WITH old AS (
      SELECT id, customer_name, customer_id FROM service_orders WHERE id = ${orderId}::uuid
    ), upd_order AS (
      UPDATE service_orders SET customer_name = ${name}, updated_at = now() WHERE id IN (SELECT id FROM old) RETURNING id
    ), upd_contact AS (
      UPDATE quick_entry_jobs SET customer_name = ${name} WHERE service_order_id IN (SELECT id FROM old) RETURNING 1
    ), upd_customer AS (
      UPDATE customers c SET display_name = ${name},
        first_name = CASE WHEN c.first_name IS NULL AND c.last_name IS NULL THEN NULL ELSE ${first} END,
        last_name  = CASE WHEN c.first_name IS NULL AND c.last_name IS NULL THEN NULL ELSE ${last} END,
        updated_at = now()
      FROM old
      WHERE c.id = old.customer_id AND length(trim(coalesce(old.customer_name, ''))) > 0 AND (
        lower(trim(coalesce(c.display_name, ''))) = lower(trim(old.customer_name))
        OR lower(trim(concat_ws(' ', c.first_name, c.last_name))) = lower(trim(old.customer_name)))
      RETURNING c.id
    )
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
    SELECT old.id, 'customer_corrected', ${actor}, json_build_object(
      'changed', json_build_array('name'),
      'before', json_build_object('name', old.customer_name),
      'after', json_build_object('name', ${name}::text),
      'directoryCustomerId', (SELECT id FROM upd_customer LIMIT 1),
      'source', 'estimate')::text
    FROM old, upd_order
    RETURNING note
  `)
  const row = result.rows[0] as { note: string } | undefined
  if (!row) throw new Error('Estimate not found.')
  const note = JSON.parse(row.note) as { directoryCustomerId: string | null }
  return { changed: true, before: current.customer_name, after: name, directoryCustomerId: note.directoryCustomerId ?? null }
}
