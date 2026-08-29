/**
 * P-D2 live verification — Invoice Draft UI (read model + audited overrides + permissions).
 * Creates ZZ retail + dealer test Jobs through the real create path, exercises the
 * deployed invoice endpoints with crafted role cookies, asserts totals/permissions/audit,
 * then sweeps all ZZ test data. No QuickBooks writes anywhere.
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
const BASE = process.env.BASE_URL || 'https://pitt-stop-internal.vercel.app'
const ID = 'e8614830-cece-41b7-9de9-caf7808a92c5'

const cookie = (role) => `ps_actor=${encodeURIComponent(JSON.stringify({ id: ID, name: `ZZ ${role}`, role }))}`
const admin = cookie('admin'), manager = cookie('manager'), employee = cookie('employee')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }

async function get(id, ck) {
  const r = await fetch(`${BASE}/api/workflow/orders/${id}/invoice`, { headers: { cookie: ck } })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function override(id, ck, field, removed, reason) {
  const r = await fetch(`${BASE}/api/workflow/orders/${id}/invoice/override`, {
    method: 'POST', headers: { cookie: ck, 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, removed, reason }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const created = []
async function main() {
  // ── Seed a priced ($650) retail Job via the real create endpoint (admin sets price) ──
  const cr = await fetch(`${BASE}/api/quick-entry/jobs`, {
    method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'ZZ Invoice Draft', vehicle: { year: '2020', make: 'Honda', model: 'Civic' },
      lines: [{ name: 'Interior Detail', priceCents: 0 }], workPriceCents: 65000, createdBy: 'ZZ admin',
    }),
  })
  const crb = await cr.json()
  ok('01 create priced retail Job', cr.ok && crb.serviceOrderId, JSON.stringify(crb).slice(0, 120))
  const oid = crb.serviceOrderId
  created.push(oid)

  // ── 02 GET as admin: authoritative breakdown ──
  let g = await get(oid, admin)
  const d = g.body.draft || {}
  ok('02 GET admin → priced retail', g.status === 200 && d.priced === true && d.isDealer === false)
  ok('03 work price = $650.00', d.workPriceCents === 65000, `${d.workPriceCents}`)
  ok('04 shop supplies = $19.50', d.shopSupplies?.cents === 1950, `${d.shopSupplies?.cents}`)
  ok('05 payment charge = $20.09 (3% of work+supplies)', d.paymentCharge?.cents === 2009, `${d.paymentCharge?.cents}`)
  ok('06 tax not applicable (detailing)', d.tax?.applicable === false && d.tax?.cents === 0)
  ok('07 total = $689.59', d.totalCents === 68959, `${d.totalCents}`)

  // ── Permissions on read ──
  ok('08 GET employee → 403', (await get(oid, employee)).status === 403)
  ok('09 GET manager → 200 priced', (await get(oid, manager)).body.draft?.priced === true)

  // ── Overrides (manager) ──
  let o = await override(oid, manager, 'payment', true)
  ok('10 remove payment → total $669.50', o.status === 200 && o.body.draft?.totalCents === 66950 && o.body.draft?.paymentCharge?.waived === true, `${o.body.draft?.totalCents}`)

  o = await override(oid, manager, 'payment', false)
  ok('11 restore payment → total $689.59', o.body.draft?.totalCents === 68959 && o.body.draft?.paymentCharge?.waived === false, `${o.body.draft?.totalCents}`)

  o = await override(oid, manager, 'shop_supplies', true)
  ok('12 remove shop supplies → payment recalcs to work-only basis $19.50', o.body.draft?.shopSupplies?.waived === true && o.body.draft?.paymentCharge?.cents === 1950, `pay=${o.body.draft?.paymentCharge?.cents}`)
  ok('13 remove shop supplies → total $669.50', o.body.draft?.totalCents === 66950, `${o.body.draft?.totalCents}`)

  o = await override(oid, manager, 'shop_supplies', false)
  ok('14 restore shop supplies → total $689.59', o.body.draft?.totalCents === 68959, `${o.body.draft?.totalCents}`)

  // ── Permission enforcement on overrides ──
  ok('15 employee override → 403', (await override(oid, employee, 'payment', true)).status === 403)
  ok('16 manager tax_exempt → 403 (admin-only)', (await override(oid, manager, 'tax_exempt', true, 'x')).status === 403)
  ok('17 admin tax_exempt w/o reason → 400', (await override(oid, admin, 'tax_exempt', true)).status === 400)
  o = await override(oid, admin, 'tax_exempt', true, 'ZZ resale certificate on file')
  ok('18 admin tax_exempt w/ reason → 200', o.status === 200 && o.body.draft?.tax?.exempt === true)

  // ── Audit trail ──
  const events = await sql.query(`SELECT event_type, employee_name, note FROM service_order_events WHERE service_order_id=$1 AND event_type='invoice_override' ORDER BY created_at`, [oid])
  ok('19 audit: 5 invoice_override events written', events.length === 5, `${events.length}`)
  const taxEv = events.find((e) => { try { return JSON.parse(e.note).key === 'tax_exempt' } catch { return false } })
  const taxNote = taxEv ? JSON.parse(taxEv.note) : {}
  ok('20 audit: tax event has actor+old→new+reason', taxNote.reason === 'ZZ resale certificate on file' && taxNote.old === false && taxNote.new === true && taxEv.employee_name === 'ZZ admin', JSON.stringify(taxNote))

  // ── Dealer Job: no retail charges, overrides rejected ──
  const [veh] = await sql.query(`INSERT INTO vehicles (year, make, model) VALUES ('2021','Mazda','CX-5') RETURNING id`)
  const [dord] = await sql.query(
    `INSERT INTO service_orders (order_number, vehicle_id, source, service_type, status, customer_name)
     VALUES ($1,$2,'dealer','dealer_detail','arrived','ZZ Purdy Mazda') RETURNING id`,
    [`ZZ-DLR-${Date.now()}`, veh.id])
  created.push(dord.id)
  g = await get(dord.id, admin)
  ok('21 dealer GET → isDealer, no retail draft', g.status === 200 && g.body.draft?.isDealer === true && g.body.draft?.priced === false)
  ok('22 dealer override rejected → 400', (await override(dord.id, admin, 'payment', true)).status === 400)
}

main()
  .catch((e) => { console.error('ERROR', e); fail++ })
  .finally(async () => {
    // Sweep every ZZ test artifact.
    for (const oid of created) {
      const vids = await sql.query(`SELECT vehicle_id FROM service_orders WHERE id=$1`, [oid])
      const ests = await sql.query(`SELECT id FROM job_estimates WHERE service_order_id=$1`, [oid])
      for (const e of ests) {
        const svc = await sql.query(`SELECT id FROM job_services WHERE job_estimate_id=$1`, [e.id])
        for (const s of svc) await sql.query(`DELETE FROM job_line_items WHERE job_service_id=$1`, [s.id])
        await sql.query(`DELETE FROM job_services WHERE job_estimate_id=$1`, [e.id])
      }
      await sql.query(`DELETE FROM job_estimates WHERE service_order_id=$1`, [oid])
      await sql.query(`DELETE FROM quick_entry_jobs WHERE service_order_id=$1`, [oid])
      await sql.query(`DELETE FROM service_order_events WHERE service_order_id=$1`, [oid])
      await sql.query(`DELETE FROM service_order_assignments WHERE service_order_id=$1`, [oid])
      await sql.query(`DELETE FROM service_orders WHERE id=$1`, [oid])
      for (const v of vids) await sql.query(`DELETE FROM vehicles WHERE id=$1`, [v.vehicle_id]).catch(() => {})
    }
    const leftover = await sql.query(`SELECT count(*)::int n FROM service_orders WHERE customer_name LIKE 'ZZ %'`)
    console.log(`\nCleanup: ZZ service_orders remaining = ${leftover[0].n}`)
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
