/**
 * Migration 0063 itself (not just the Drizzle schema the other tests push): applied with the same statement splitter
 * as scripts/apply-qb-migration.mjs, twice (idempotent), it must yield exactly the Drizzle table, indexes and checks.
 * Then the DATABASE-ENFORCED guard is exercised directly against that migrated table: one unfinished consolidation
 * per (QuickBooks realm, customer), across every unfinished state (prepared / voided / relinked — recovery
 * included), never blocking finished ones or another company's customer with the same id.
 *
 * What this proves: the unique index rejects a second unfinished row however it is written (no app code involved),
 * which is what a racing claim ultimately turns into. It does NOT reproduce a real two-connection READ COMMITTED
 * interleaving (PGlite is single-connection) — that race is argued in docs/combine-unpaid-invoices.md.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { sql } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

/* eslint-disable @typescript-eslint/no-explicit-any */
const rows = (r: unknown): any[] => (r as any).rows ?? r
/* eslint-enable @typescript-eslint/no-explicit-any */

const MIGRATION = readFileSync(path.join(process.cwd(), 'drizzle/migrations/manual/0063_retail_invoice_consolidations.sql'), 'utf8')
/** Same splitting as scripts/apply-qb-migration.mjs. */
const statements = (text: string) => text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)

async function pushed(): Promise<PgliteDatabase<typeof schema>> {
  const db = drizzle(new PGlite(), { schema })
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]); await apply()
  return db
}
async function shape(db: PgliteDatabase<typeof schema>) {
  const cols = rows(await db.execute(sql`SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
    FROM information_schema.columns WHERE table_name = 'retail_invoice_consolidations' ORDER BY column_name`))
  const idx = rows(await db.execute(sql`SELECT indexname, regexp_replace(indexdef, '\\s+', ' ', 'g') AS def FROM pg_indexes
    WHERE tablename = 'retail_invoice_consolidations' ORDER BY indexname`))
  const checks = rows(await db.execute(sql`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'retail_invoice_consolidations'::regclass AND contype = 'c' ORDER BY conname`))
  return { cols, idx, checks }
}

let migrated: PgliteDatabase<typeof schema>
let fx: { est: string[]; so: string[] }

beforeAll(async () => {
  migrated = await pushed()
  await migrated.execute(sql`DROP TABLE retail_invoice_consolidations`)
  for (let pass = 0; pass < 2; pass++) for (const st of statements(MIGRATION)) await migrated.execute(sql.raw(st))
  // Fixture Jobs to reference (FKs).
  fx = { est: [], so: [] }
  for (let i = 0; i < 6; i++) {
    const [v] = rows(await migrated.execute(sql`INSERT INTO vehicles (make, model) VALUES ('Ford', ${'M' + i}) RETURNING id`))
    const [so] = rows(await migrated.execute(sql`INSERT INTO service_orders (order_number, vehicle_id, status) VALUES (${'MIG-' + i}, ${v.id}, 'ready') RETURNING id`))
    const [je] = rows(await migrated.execute(sql`INSERT INTO job_estimates (service_order_id) VALUES (${so.id}) RETURNING id`))
    fx.so.push(so.id); fx.est.push(je.id)
  }
})

let n = 0
/** A consolidation row written straight to the table — as a racing claim would land, no app code in between. */
function insert(o: { retained: number; replaced: number; realm: string; customer: string; status?: string }) {
  return migrated.execute(sql`
    INSERT INTO retail_invoice_consolidations (request_id, status, retained_estimate_id, retained_service_order_id, replaced_estimate_id, replaced_service_order_id,
      qb_customer_id, qb_realm_id, retained_invoice_id, retained_sync_token, retained_lines_fingerprint, retained_total_cents,
      replaced_invoice_id, replaced_sync_token, replaced_lines_fingerprint, replaced_total_cents, replaced_prior_qb_status, combined_total_cents)
    VALUES (${'mig-' + ++n}, ${o.status ?? 'prepared'}, ${fx.est[o.retained]}::uuid, ${fx.so[o.retained]}::uuid, ${fx.est[o.replaced]}::uuid, ${fx.so[o.replaced]}::uuid,
      ${o.customer}, ${o.realm}, ${'I' + o.retained}, '0', 'x', 100, ${'I' + o.replaced}, '0', 'y', 100, 'created', 200)`)
}
const violation = (p: Promise<unknown>) => p.then(() => 'inserted', (e: { message?: string; cause?: { message?: string } }) => String(e?.cause?.message ?? e?.message))

describe('migration 0063', () => {
  it('applied twice (idempotent) it matches the Drizzle schema exactly — columns, indexes, checks', async () => {
    const want = await shape(await pushed())
    const got = await shape(migrated)
    expect(got.cols).toEqual(want.cols)
    expect(got.idx).toEqual(want.idx)
    expect(got.checks).toEqual(want.checks)
    expect(got.cols.find((c) => c.column_name === 'qb_realm_id')).toMatchObject({ is_nullable: 'NO', character_maximum_length: 100 })
    expect(got.idx.find((i) => i.indexname === 'ric_customer_active_uniq')!.def)
      .toMatch(/UNIQUE INDEX ric_customer_active_uniq ON .*\(qb_realm_id, qb_customer_id\) WHERE .*prepared.*voided.*relinked/)
  })

  it('is additive only: one new table, nothing dropped or altered elsewhere', () => {
    for (const st of statements(MIGRATION)) expect(st).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS /)
  })
})

describe('database-enforced guard: one unfinished consolidation per (realm, customer)', () => {
  it('a second unfinished row for the same customer in the same company is rejected in EVERY unfinished state', async () => {
    for (const status of ['prepared', 'voided', 'relinked']) {
      await migrated.execute(sql`DELETE FROM retail_invoice_consolidations`)
      await insert({ retained: 0, replaced: 1, realm: 'R1', customer: 'C-KELVIN', status })
      // Keep C / void A while A is retained elsewhere (the race the review found), and an unrelated pair.
      expect(await violation(insert({ retained: 2, replaced: 0, realm: 'R1', customer: 'C-KELVIN' }))).toMatch(/ric_customer_active_uniq|ric_/)
      expect(await violation(insert({ retained: 2, replaced: 3, realm: 'R1', customer: 'C-KELVIN' }))).toMatch(/ric_customer_active_uniq/)
    }
  })

  it('finished combines never block a new one; another company’s customer with the same id is independent', async () => {
    await migrated.execute(sql`DELETE FROM retail_invoice_consolidations`)
    for (const status of ['completed', 'cancelled', 'separated']) await insert({ retained: 0, replaced: 1, realm: 'R1', customer: 'C-KELVIN', status })
    expect(await violation(insert({ retained: 2, replaced: 3, realm: 'R1', customer: 'C-KELVIN' }))).toBe('inserted')
    // Same QuickBooks customer id, different QuickBooks company → a different customer.
    expect(await violation(insert({ retained: 4, replaced: 5, realm: 'R2', customer: 'C-KELVIN' }))).toBe('inserted')
    // Finishing the open one frees the customer again.
    await migrated.execute(sql`UPDATE retail_invoice_consolidations SET status = 'completed' WHERE retained_estimate_id = ${fx.est[2]}::uuid`)
    expect(await violation(insert({ retained: 2, replaced: 3, realm: 'R1', customer: 'C-KELVIN' }))).toBe('inserted')
  })
})
