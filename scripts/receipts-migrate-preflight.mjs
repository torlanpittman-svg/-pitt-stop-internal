/**
 * Business Receipts — READ-ONLY migration preflight. Runs NO DDL and mutates nothing; it only inspects
 * the target database (via DATABASE_URL) and prints a deterministic go/no-go apply plan. Use it BEFORE
 * scripts/apply-qb-migration.mjs so the operator knows exactly which files to run and whether it is safe.
 *
 *   node scripts/receipts-migrate-preflight.mjs
 *
 * It answers: is this a FRESH install or an EXISTING receipt table? which additive objects are missing?
 * and — crucially — are there pre-existing ACTIVE duplicate hashes that would make the 0039 UNIQUE index
 * fail? If so it STOPS (exit 2) and reports counts only (never row contents). Never drops/merges/deletes.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
function loadEnvLocal() {
  try {
    for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!process.env[m[1]]) process.env[m[1]] = v
    }
  } catch { /* optional */ }
}

async function main() {
  loadEnvLocal()
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL not found in environment or .env.local'); process.exit(1) }
  const sql = neon(url)
  const one = async (q, params = []) => {
    const r = await sql.query(q, params)
    const rows = Array.isArray(r) ? r : (r?.rows ?? [])
    return rows[0]
  }

  console.log('Business Receipts — migration preflight (READ-ONLY; nothing is modified)\n')

  // 1) Does the receipt table exist? (existence check BEFORE any table-scoped query)
  const tbl = await one(`SELECT to_regclass('public.business_receipts') AS reg`)
  const exists = !!tbl?.reg

  if (!exists) {
    console.log('State: FRESH install (business_receipts does not exist).')
    console.log('\nApply in order (each is idempotent; the runner splits on ";"):')
    console.log('  1) node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0038_business_receipts.sql')
    console.log('  2) node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0039_business_receipts_dedup.sql')
    console.log('  3) node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0040_business_receipts_hardening.sql')
    console.log('\n0038 creates the table WITH its inventory-vehicle FK inline, so no FK upgrade is needed.')
    console.log('RESULT: GO (fresh).')
    process.exit(0)
  }

  console.log('State: EXISTING business_receipts table — additive upgrade path.\n')

  // 2) Which additive objects are already present?
  const col = await one(`SELECT 1 AS ok FROM information_schema.columns WHERE table_name='business_receipts' AND column_name='processing_token'`)
  const uniq = await one(`SELECT 1 AS ok FROM pg_indexes WHERE tablename='business_receipts' AND indexname='business_receipts_hash_active_uniq'`)
  const fk = await one(`SELECT 1 AS ok FROM pg_constraint WHERE conname='business_receipts_inv_veh_fk' OR (conrelid='public.business_receipts'::regclass AND contype='f')`)
  const rateTbl = await one(`SELECT to_regclass('public.expense_rate_counters') AS reg`)
  console.log(`  processing_token column ......... ${col ? 'present' : 'MISSING → run 0040'}`)
  console.log(`  hash-active unique index ........ ${uniq ? 'present' : 'MISSING → run 0039 (after duplicate check below)'}`)
  console.log(`  inventory-vehicle FK ............ ${fk ? 'present' : 'MISSING → run the additive FK upgrade (psql DO-block; see docs §3)'}`)
  console.log(`  expense_rate_counters table ..... ${rateTbl?.reg ? 'present' : 'MISSING → run 0040'}`)

  // 3) STOP condition: pre-existing ACTIVE duplicate hashes make the 0039 UNIQUE index fail.
  let stop = false
  if (!uniq) {
    const dup = await one(`
      SELECT count(*)::int AS groups, COALESCE(sum(n),0)::int AS rows FROM (
        SELECT image_hash, count(*) AS n FROM business_receipts
        WHERE status <> 'rejected' AND image_hash IS NOT NULL
        GROUP BY image_hash HAVING count(*) > 1
      ) d`)
    if (dup && dup.groups > 0) {
      stop = true
      console.log(`\nSTOP: ${dup.groups} active duplicate-hash group(s) covering ${dup.rows} row(s).`)
      console.log('The 0039 UNIQUE index will FAIL until these are resolved. Do NOT delete/merge rows.')
      console.log('Resolution: a manager REJECTS all but one receipt per duplicate hash (rejected rows are')
      console.log('excluded from the index), then re-run this preflight. (Counts only shown — no contents.)')
    } else {
      console.log('\nDuplicate check: none — 0039 is safe to apply.')
    }
  }

  console.log(`\nRESULT: ${stop ? 'NO-GO (resolve duplicates first).' : 'GO (apply the MISSING items above, in order 0039 then 0040; add the FK if missing).'}`)
  process.exit(stop ? 2 : 0)
}

main().catch((err) => {
  // Never print secrets/connection strings; surface only a short code.
  console.error('Preflight failed:', (err && err.code) || (err && err.name) || 'unknown error')
  process.exit(1)
})
