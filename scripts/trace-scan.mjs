/**
 * READ-ONLY end-to-end trace of the most recent dealer check-in(s).
 * Confirms the DB is the production company, then dumps the scan's QB result
 * columns and its full dealer_scan_events audit trail. No writes.
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

const j = (o) => JSON.stringify(o)

const conns = await sql`SELECT realm_id, environment, status FROM qb_connections ORDER BY last_used_at DESC NULLS LAST`
console.log('QB connections in this DB:', j(conns))

const scans = await sql`
  SELECT id, created_at, status, data_type, dealership_id, stock_number, vin,
         year, make, model, color, approved_by, approved_at,
         qb_invoice_number, qb_sync_status, qb_sync_error, qb_synced_at
  FROM dealer_scans
  ORDER BY created_at DESC
  LIMIT 5`
console.log('\n===== 5 most recent dealer_scans =====')
for (const s of scans) {
  console.log(`\n- scan ${s.id}  @ ${s.created_at?.toISOString?.() ?? s.created_at}`)
  console.log(`  status=${s.status} dataType=${s.data_type} stock=${s.stock_number} vin=${s.vin ?? '-'}`)
  console.log(`  vehicle=${[s.year,s.make,s.model,s.color].filter(Boolean).join(' ') || '-'} dealershipId=${s.dealership_id}`)
  console.log(`  qb_sync_status=${s.qb_sync_status} qb_invoice_number=${s.qb_invoice_number ?? '-'} qb_synced_at=${s.qb_synced_at ?? '-'}`)
  console.log(`  qb_sync_error=${s.qb_sync_error ?? '-'}`)
  console.log(`  approvedBy=${s.approved_by ?? '-'} approvedAt=${s.approved_at ?? '-'}`)
}

if (scans[0]) {
  const events = await sql`
    SELECT created_at, event_type, actor, note, new_value
    FROM dealer_scan_events WHERE scan_id = ${scans[0].id} ORDER BY created_at ASC`
  console.log(`\n===== event trail for most recent scan ${scans[0].id} =====`)
  for (const e of events) {
    console.log(`  ${e.created_at?.toISOString?.() ?? e.created_at}  ${e.event_type}  actor=${e.actor ?? '-'}  note=${e.note ?? '-'}  new=${e.new_value ? j(e.new_value) : '-'}`)
  }
  // resolve the dealership → qb customer for this scan
  if (scans[0].dealership_id) {
    const d = await sql`SELECT id, name, stock_prefix, qb_customer_id, qb_customer_name FROM dealerships WHERE id = ${scans[0].dealership_id}`
    console.log('\n  dealership:', j(d[0] ?? null))
  }
}
