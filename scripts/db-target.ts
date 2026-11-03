/**
 * Positive verification of the EFFECTIVE database target — before any write testing.
 * Run: node_modules/.bin/tsx scripts/db-target.ts
 *
 * Reports (NEVER printing credentials):
 *   - the connection ENDPOINT id parsed from APP_DATABASE_URL (this is what differs between Neon
 *     branches — compare it to your intended dev branch endpoint),
 *   - whether that host is the KNOWN PRODUCTION endpoint and whether the write-guard is active,
 *   - a LIVE read-only round-trip (SELECT) that proves we actually reach that host — the absence
 *     of a warning is NOT proof; this is,
 *   - the external side-effect posture (QuickBooks env, Plaid env, retail send flag) so you can
 *     confirm those are disabled SEPARATELY from the DB guard.
 *
 * Read-only: the single query is a SELECT, allowed even when the write-guard is active.
 */
import { readFileSync } from 'node:fs'

for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}

function hostEndpoint(url: string | undefined): string {
  try { return new URL(url ?? '').hostname.split('.')[0] || '(invalid APP_DATABASE_URL)' }
  catch { return '(invalid APP_DATABASE_URL)' }
}
function urlRole(url: string | undefined): string {
  try { return new URL(url ?? '').username || '(none)' } catch { return '(invalid)' }
}

;(async () => {
  const { neon } = await import('@neondatabase/serverless')
  const { isKnownProdUrl, prodWriteGuardActive, guardNeonClient, classifyDbTarget } = await import('@/platform/prod-db-guard')
  const { appDatabaseUrl } = await import('@/platform/db-url')
  const url = appDatabaseUrl() // the ONLY variable the app reads; no DATABASE_URL fallback
  if (!url) { console.log('APP_DATABASE_URL is not set — the app would refuse to start (no fallback to DATABASE_URL by design).'); process.exitCode = 1; return }

  const expected = process.argv[2]
  const endpoint = hostEndpoint(url)
  const prod = isKnownProdUrl(url)
  const classification = classifyDbTarget()
  const guard = prodWriteGuardActive()
  console.log('── Effective database target ───────────────────────────────')
  console.log('  endpoint id      :', hostEndpoint(url), '   (compare to your dev-branch endpoint)')
  console.log('  app role (URL)   :', urlRole(url), '   (expect pitt_stop_app; neondb_owner here is WRONG)')
  console.log('  owner var        :', process.env.DATABASE_URL_OWNER ? 'DATABASE_URL_OWNER present (migrations only)' : '(DATABASE_URL_OWNER unset — migrations unavailable here)')
  console.log('  DATABASE_ENV     :', process.env.DATABASE_ENV ?? '(unset)')
  console.log('  classification   :', classification.toUpperCase(),
    classification === 'unknown' ? '(undeclared → treated as PRODUCTION / fail-closed)' : '')
  console.log('  known PRODUCTION :', prod ? 'YES' : 'no')
  console.log('  write-guard      :', guard ? 'ACTIVE — writes BLOCKED' : 'inert — writes allowed')

  if (expected && (endpoint !== expected || prod)) {
    console.log('FAILED: effective endpoint does not match the requested development endpoint.')
    process.exitCode = 1
    return
  }

  let connected = false
  // LIVE proof we actually connect to that host (read-only; guard allows SELECT).
  try {
    const sql = guardNeonClient(neon(url!))
    const rows = await sql`select current_database() as db, current_user as role` as Array<{ db: string; role: string }>
    connected = true
    console.log('  live round-trip  : OK  (database=' + rows[0].db + ', role=' + rows[0].role + ')')
    // Read the retail send flag if present (defensive — table/row may not exist).
    try {
      const f = await sql`select value from app_settings where key = 'retail_qb_send_enabled' limit 1` as Array<{ value: unknown }>
      console.log('  retail_qb_send   :', f.length ? JSON.stringify(f[0].value) : '(unset → default OFF)')
    } catch { console.log('  retail_qb_send   : (could not read app_settings)') }
  } catch {
    // Driver errors can contain connection strings. Never print raw errors here.
    console.log('  live round-trip  : FAILED (details withheld to protect credentials)')
    process.exitCode = 1
  }

  console.log('── External side effects (disabled SEPARATELY from the DB guard) ──')
  console.log('  QUICKBOOKS_ENVIRONMENT :', process.env.QUICKBOOKS_ENVIRONMENT ?? '(unset)', '  (want: sandbox for testing)')
  console.log('  PLAID_ENV              :', process.env.PLAID_ENV ?? '(unset)', '  (read-only ingestion)')
  console.log('  SMS infra              : none in this codebase')
  console.log('────────────────────────────────────────────────────────────')
  if (prod) console.log('⚠ This is PRODUCTION. Point APP_DATABASE_URL at a dev branch before write testing.')
  else if (connected && expected) console.log('✓ LIVE connection verified to the exact requested development endpoint.')
  else if (connected) console.log('Endpoint reached; supply the expected endpoint as an argument for positive dev verification.')
})()
