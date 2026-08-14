/**
 * Phase 1a — one-time confident catalog cleanup of retail service → QB item mappings.
 * Idempotent. Validates each target QB item id exists + is active (via query-items) BEFORE
 * setting it. Owner-approved decisions only. No QB writes, no Send. Read-then-write to
 * service_catalog / service_aliases only.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
let PW = readFileSync(join(ROOT, '.env.admin-password'), 'utf8').trim(); if (PW.includes('=')) PW = PW.slice(PW.indexOf('=') + 1).trim(); if (PW[0] === '"') PW = PW.slice(1, -1)
const basic = 'Basic ' + Buffer.from('admin:' + PW).toString('base64')
const sql = neon(process.env.DATABASE_URL)
const items = (await fetch('https://pitt-stop-internal.vercel.app/api/quickbooks/query-items', { headers: { authorization: basic } }).then(r => r.json())).items
const liveById = Object.fromEntries(items.map(i => [String(i.id), i]))
const assertLive = (id) => { const it = liveById[String(id)]; if (!it || !it.active) throw new Error(`QB item ${id} not live/active`); return it }

// Owner-approved confident mappings (matched robustly by name substring).
const RULES = [
  { test: n => n.includes('Exterior Wash'), qb: 6 },
  { test: n => n === 'Exterior Wax', qb: 69 },
  { test: n => n.includes('Ceramic') && n.includes('1-Year'), qb: 70 },
  { test: n => n.includes('Ceramic') && n.includes('3-Year'), qb: 70 },
  { test: n => n.includes('Floor Mats'), qb: 42 },
]

const cats = await sql.query("SELECT id,name,qb_item_ref,qb_item_status,qb_sync_enabled FROM service_catalog WHERE archived_at IS NULL")
console.log('=== confident cleanup ===')
for (const c of cats) {
  const rule = RULES.find(r => r.test(c.name)); if (!rule) continue
  const it = assertLive(rule.qb)
  const before = `ref=${c.qb_item_ref ?? '-'} status=${c.qb_item_status} sync=${c.qb_sync_enabled}`
  await sql.query("UPDATE service_catalog SET qb_item_ref=$2, qb_item_status='existing', qb_sync_enabled=true WHERE id=$1", [c.id, String(rule.qb)])
  console.log(`  ${c.name.padEnd(34)} ${before}  →  ref=${rule.qb} (${it.name}) status=existing sync=true`)
}

// Wax → Exterior Wax alias (so the Quick Entry "Wax" title resolves to item 69).
const [wax] = await sql.query("SELECT id FROM service_catalog WHERE name='Exterior Wax' AND archived_at IS NULL")
if (wax) {
  const r = await sql.query("INSERT INTO service_aliases (catalog_id, alias, approved_for_ai) VALUES ($1,'Wax',false) ON CONFLICT (catalog_id, alias) DO NOTHING RETURNING id", [wax.id])
  console.log(`\nWax → Exterior Wax alias: ${r.length ? 'ADDED' : 'already present'}`)
}

console.log('\n=== verify (targets) ===')
const after = await sql.query("SELECT name,qb_item_ref,qb_item_status,qb_sync_enabled FROM service_catalog WHERE archived_at IS NULL AND (name ILIKE '%exterior w%' OR name ILIKE '%ceramic%' OR name ILIKE '%floor mats%') ORDER BY name")
for (const c of after) console.log(`  ${c.name.padEnd(34)} ref=${c.qb_item_ref} status=${c.qb_item_status} sync=${c.qb_sync_enabled}`)
console.log('\nDONE.')
