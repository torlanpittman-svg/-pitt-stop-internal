/**
 * REAL Postgres migration tests (PGlite): the UPGRADE path from an already-created table without the FK,
 * and the partial-unique-index PREFLIGHT when pre-existing active duplicates exist. Raw SQL against a
 * disposable database — establishes the documented remediation actually works. No production DB/creds.
 */
import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const migPath = (f: string) => fileURLToPath(new URL(`../../drizzle/migrations/manual/${f}`, import.meta.url))
function splitStatements(sqlText: string): string[] {
  return sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
}
async function apply(client: PGlite, f: string) { for (const s of splitStatements(readFileSync(migPath(f), 'utf8'))) await client.query(s) }
async function prereq(client: PGlite) {
  await client.exec(`
    CREATE TABLE vehicles(id uuid primary key default gen_random_uuid());
    CREATE TABLE inventory_vehicles(id uuid primary key default gen_random_uuid(), vehicle_id uuid references vehicles(id), stock_number text, created_at timestamptz default now());
  `)
}

describe('UPGRADE: an already-created table WITHOUT the FK gets it added (documented remediation)', () => {
  it('adds the FK + hardening column idempotently and enforces the FK', async () => {
    const client = new PGlite()
    await prereq(client)
    // Simulate the ORIGINAL table: created without the inventory FK and without processing_token.
    await client.exec(`
      CREATE TABLE business_receipts(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status varchar(20) NOT NULL DEFAULT 'needs_review',
        image_hash varchar(64),
        inventory_vehicle_id uuid,
        storage varchar(16) NOT NULL DEFAULT 'blob_public',
        audit_log jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );`)
    // No FK yet.
    const before = await client.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conname='business_receipts_inv_veh_fk'`)
    expect(before.rows.length).toBe(0)

    // Documented additive FK upgrade (idempotent DO block; runnable in psql).
    const fkUpgrade = `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_receipts_inv_veh_fk') THEN
        ALTER TABLE business_receipts
          ADD CONSTRAINT business_receipts_inv_veh_fk
          FOREIGN KEY (inventory_vehicle_id) REFERENCES inventory_vehicles(id) ON DELETE SET NULL;
      END IF;
    END $$;`
    await client.exec(fkUpgrade)
    await client.exec(fkUpgrade) // idempotent — second run is a no-op

    // 0040 additive column is idempotent on an existing table.
    await apply(client, '0040_business_receipts_hardening.sql')
    await apply(client, '0040_business_receipts_hardening.sql')

    const after = await client.query(`SELECT conname FROM pg_constraint WHERE conname='business_receipts_inv_veh_fk'`)
    expect(after.rows.length).toBe(1)
    const col = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name='business_receipts' AND column_name='processing_token'`)
    expect(col.rows.length).toBe(1)
    // FK now enforced.
    await expect(client.query(`INSERT INTO business_receipts(image_hash, inventory_vehicle_id) VALUES('x','00000000-0000-0000-0000-000000000000')`)).rejects.toBeTruthy()
  })
})

describe('PREFLIGHT: the partial unique index fails if pre-existing ACTIVE duplicates exist', () => {
  it('detects duplicates and refuses to build the index (no silent merge/delete)', async () => {
    const client = new PGlite()
    await prereq(client)
    await client.exec(`
      CREATE TABLE business_receipts(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status varchar(20) NOT NULL DEFAULT 'needs_review',
        image_hash varchar(64),
        created_at timestamptz NOT NULL DEFAULT now()
      );`)
    // Two ACTIVE rows with the same hash (a pre-existing duplicate).
    await client.query(`INSERT INTO business_receipts(image_hash,status) VALUES('DUP','needs_review')`)
    await client.query(`INSERT INTO business_receipts(image_hash,status) VALUES('DUP','needs_review')`)

    // PREFLIGHT (from the deploy runbook): must return the offending hash(es) BEFORE creating the index.
    const preflight = await client.query<{ image_hash: string; n: number }>(
      `SELECT image_hash, count(*)::int n FROM business_receipts WHERE status <> 'rejected' GROUP BY image_hash HAVING count(*) > 1`,
    )
    expect(preflight.rows.length).toBe(1)
    expect(preflight.rows[0].image_hash).toBe('DUP')

    // Building the unique index (0039) MUST fail while duplicates exist — proving we must stop + resolve.
    await expect(apply(client, '0039_business_receipts_dedup.sql')).rejects.toBeTruthy()

    // Rows are untouched (no silent delete/merge to force success).
    const cnt = await client.query<{ n: number }>(`SELECT count(*)::int n FROM business_receipts`)
    expect(cnt.rows[0].n).toBe(2)
  })
})
