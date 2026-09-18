/**
 * REAL Postgres (PGlite) proof that migration 0046 makes reversal/removal ATOMIC: the partial unique
 * index vfe_reverses_active_uniq permits at most ONE active (non-void) reversal per reversed event, so two
 * simultaneous removal requests cannot both append an adjustment. Runs the ACTUAL migration SQL against a
 * disposable DB — not a mock. A void reversal is excluded from the predicate so a superseded correction
 * never blocks a fresh one.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const client = new PGlite()
const mig = fileURLToPath(new URL('../../drizzle/migrations/manual/0046_auto_sales_reversal_unique.sql', import.meta.url))
const q = (s: string, p: unknown[] = []) => client.query(s, p)

beforeAll(async () => {
  // Minimal table carrying exactly the columns the index references (id, reverses_event_id, status).
  await q(`CREATE TABLE vehicle_financial_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_vehicle_id uuid NOT NULL,
    economic_category varchar(32) NOT NULL,
    amount_cents integer NOT NULL,
    reverses_event_id uuid,
    status varchar(16) NOT NULL DEFAULT 'verified'
  )`)
  for (const stmt of readFileSync(mig, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean))
    await q(stmt)
})

const insertExpense = async () => (await q(`INSERT INTO vehicle_financial_events (inventory_vehicle_id, economic_category, amount_cents) VALUES (gen_random_uuid(), 'part', 25000) RETURNING id`) as { rows: { id: string }[] }).rows[0].id
const insertReversal = (origId: string, status = 'verified') => q(`INSERT INTO vehicle_financial_events (inventory_vehicle_id, economic_category, amount_cents, reverses_event_id, status) VALUES (gen_random_uuid(), 'adjustment', 25000, $1, $2)`, [origId, status])

describe('vfe_reverses_active_uniq — one active reversal per event (0046)', () => {
  it('rejects a SECOND active reversal of the same expense (the atomic guarantee)', async () => {
    const orig = await insertExpense()
    await insertReversal(orig)                                   // first removal wins
    await expect(insertReversal(orig)).rejects.toThrow(/unique|duplicate/i)  // simultaneous second loses
    const n = (await q(`SELECT count(*)::int c FROM vehicle_financial_events WHERE reverses_event_id = $1 AND status <> 'void'`, [orig]) as { rows: { c: number }[] }).rows[0].c
    expect(n).toBe(1)
  })

  it('does NOT constrain unrelated events — each expense can have its own reversal', async () => {
    const a = await insertExpense(); const b = await insertExpense()
    await insertReversal(a); await insertReversal(b)             // distinct originals → both allowed
    expect(true).toBe(true)
  })

  it('a VOID reversal is excluded from the predicate — it never blocks a fresh correction', async () => {
    const orig = await insertExpense()
    await insertReversal(orig, 'void')                            // superseded/void correction
    await expect(insertReversal(orig, 'verified')).resolves.toBeTruthy()  // a new active reversal is still allowed
  })
})
