import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'

/**
 * Persist customer-visible estimate notes. Touches ONLY `customer_notes` (+ `updated_at` / `updated_by`)
 * on the estimate and appends ONE append-only audit event — both in a SINGLE CTE so the write and its
 * audit land together (Neon HTTP supports CTEs, not interactive transactions). Pricing, status, QB linkage
 * and every other column are left exactly as they are; nothing is sent or synced to QuickBooks.
 *
 * `notes` is already VALIDATED + NORMALIZED by the caller (see notes.ts); '' clears the notes to NULL. The
 * value is PARAMETERIZED (never string-interpolated), so multiline notes and SQL metacharacters are stored
 * verbatim and can't alter the statement. The caller holds the intake lock and has already compared the
 * revision token, so this never blindly clobbers a concurrently-changed estimate. Scoped by both estimate
 * id and service_order_id so a stale/mismatched pair updates nothing (and writes no event).
 */
export async function saveCustomerNotes(params: { orderId: string; estimateId: string; notes: string; actor: string }): Promise<void> {
  const { orderId, estimateId, notes, actor } = params
  const value = notes.length > 0 ? notes : null
  const auditNote = value ? 'Customer notes updated' : 'Customer notes cleared'
  await getDb().execute(sql`
    WITH updated AS (
      UPDATE job_estimates
      SET customer_notes = ${value}, updated_at = now(), updated_by = ${actor}
      WHERE id = ${estimateId}::uuid AND service_order_id = ${orderId}::uuid
      RETURNING service_order_id
    )
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
    SELECT service_order_id, 'estimate_customer_notes', ${actor}, ${auditNote} FROM updated
  `)
}
