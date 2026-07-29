/**
 * Verify auto-refresh + persistence (item 7).
 * 1. Snapshot the connection row.
 * 2. Force the access token to look expired (DB-only edit to our own table).
 * 3. Hit /api/auth/quickbooks/test — this drives getValidAccessToken, which
 *    should refresh transparently and persist the rotated tokens.
 * 4. Snapshot again and confirm expiry advanced, lastRefreshedAt updated, and
 *    the encrypted refresh token changed (Intuit rotates it).
 * No QuickBooks invoice writes — a token refresh is OAuth housekeeping only.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}
const sql = neon(process.env.DATABASE_URL)
const hash = (s) => s ? s.slice(0, 20) : null

const before = (await sql.query(`SELECT id, access_token_expires_at, last_refreshed_at, refresh_token_enc FROM qb_connections WHERE status='active' ORDER BY updated_at DESC LIMIT 1`))[0]
console.log('BEFORE:')
console.log('  access_token_expires_at:', before.access_token_expires_at)
console.log('  last_refreshed_at:      ', before.last_refreshed_at)
console.log('  refresh_token (prefix): ', hash(before.refresh_token_enc))

// Force "expiring" so getValidAccessToken refreshes on next use.
await sql.query(`UPDATE qb_connections SET access_token_expires_at = now() - interval '1 minute' WHERE id = $1`, [before.id])
console.log('\n(forced access token to appear expired)\n')

// Trigger the app's real code path.
const res = await fetch('http://localhost:3000/api/auth/quickbooks/test')
console.log(`triggered /test → HTTP ${res.status} (companyinfo may 403 on prod host; refresh happens first)\n`)

const after = (await sql.query(`SELECT access_token_expires_at, last_refreshed_at, refresh_token_enc FROM qb_connections WHERE id = $1`, [before.id]))[0]
console.log('AFTER:')
console.log('  access_token_expires_at:', after.access_token_expires_at)
console.log('  last_refreshed_at:      ', after.last_refreshed_at)
console.log('  refresh_token (prefix): ', hash(after.refresh_token_enc))

const refreshed = new Date(after.access_token_expires_at) > new Date()
const rotated = after.refresh_token_enc !== before.refresh_token_enc
const stampMoved = new Date(after.last_refreshed_at) > new Date(before.last_refreshed_at)
console.log('\nRESULT:')
console.log('  access token re-issued (expiry in future):', refreshed)
console.log('  refresh token rotated + persisted:        ', rotated)
console.log('  last_refreshed_at advanced:               ', stampMoved)
console.log('  → auto-refresh + persistence:', refreshed && rotated && stampMoved ? 'VERIFIED' : 'NEEDS REVIEW')
