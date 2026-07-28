/**
 * Idempotent migration applier for the QuickBooks connection table.
 *
 * Reads DATABASE_URL from .env.local (standalone node doesn't auto-load it) and
 * runs drizzle/migrations/manual/0001_qb_connections.sql statement-by-statement.
 * Safe to re-run: every statement uses IF NOT EXISTS.
 *
 *   node scripts/apply-qb-migration.mjs
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(ROOT, '.env.local'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let val = m[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (!process.env[m[1]]) process.env[m[1]] = val
    }
  } catch {
    // .env.local optional if DATABASE_URL already in env
  }
}

function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function main() {
  loadEnvLocal()
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL not found in environment or .env.local')
    process.exit(1)
  }

  const sqlText = readFileSync(join(ROOT, 'drizzle/migrations/manual/0001_qb_connections.sql'), 'utf8')
  const statements = splitStatements(sqlText)
  const sql = neon(url)

  console.log(`Applying ${statements.length} statement(s) to qb_connections...`)
  for (const stmt of statements) {
    const label = stmt.split('\n')[0].slice(0, 70)
    process.stdout.write(`  → ${label} ... `)
    await sql.query(stmt)
    console.log('ok')
  }

  // Verify the table exists and report its column count.
  const cols = await sql.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'qb_connections' ORDER BY ordinal_position`
  )
  console.log(`\nqb_connections has ${cols.length} columns:`)
  console.log('  ' + cols.map((c) => c.column_name).join(', '))
  console.log('\nMigration complete.')
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
