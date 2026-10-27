import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'

/**
 * Persist the per-estimate SEND recipient list. Touches ONLY `saved_recipients` on `estimate_intakes` and
 * appends ONE append-only audit event — both in a SINGLE CTE so the write and its audit land together (Neon
 * HTTP supports CTEs, not interactive transactions), exactly like saveCustomerNotes in notes-db.ts. Pricing,
 * status, QuickBooks linkage, the customer contact and every other column are left exactly as they are;
 * nothing is sent or synced to QuickBooks.
 *
 * `recipients` is already NORMALIZED + VALIDATED by the caller (see recipients.ts): a trimmed, lowercased,
 * de-duplicated, deterministically ordered SET. An empty array stores `'{}'` — the EXPLICIT "cleared" state
 * (distinct from a legacy NULL), which keeps a send blocked. Each element is PARAMETERIZED (never
 * string-interpolated), so address text can't alter the statement. The caller holds the intake lock and has
 * already compared the revision token, so this never blindly clobbers a concurrently-changed estimate.
 * Scoped by `order_id` so a stale/mismatched id updates nothing (and writes no event).
 */
export async function saveSavedRecipients(params: { orderId: string; recipients: string[]; actor: string }): Promise<void> {
  const { orderId, recipients, actor } = params
  const arrayExpr = recipients.length
    ? sql`ARRAY[${sql.join(recipients.map((r) => sql`${r}`), sql`, `)}]::text[]`
    : sql`ARRAY[]::text[]`
  const auditNote = recipients.length ? `Saved estimate recipients (${recipients.length})` : 'Saved estimate recipients cleared'
  await getDb().execute(sql`
    WITH updated AS (
      UPDATE estimate_intakes
      SET saved_recipients = ${arrayExpr}
      WHERE order_id = ${orderId}::uuid
      RETURNING order_id
    )
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
    SELECT order_id, 'estimate_saved_recipients', ${actor}, ${auditNote} FROM updated
  `)
}
