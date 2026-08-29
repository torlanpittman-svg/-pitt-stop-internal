/**
 * Live verification — simplified mobile Estimate (suggested prices, flat-stays-flat,
 * itemize-on-edit, exact-penny Work Total, custom add, remove) + Invoice Draft for both
 * modes. Drives the deployed API with an admin cookie; sweeps all ZZ test data. No QB.
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
const admin = `ps_actor=${encodeURIComponent(JSON.stringify({ id: 'e8614830-cece-41b7-9de9-caf7808a92c5', name: 'ZZ admin', role: 'admin' }))}`

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { (c ? pass++ : fail++); console.log(`${c ? '✓' : '✗ FAIL'} ${n}${extra ? ' — ' + extra : ''}`) }
const est = (id, body) => fetch(`${BASE}/api/workflow/orders/${id}/estimate`, { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
const inv = (id) => fetch(`${BASE}/api/workflow/orders/${id}/invoice`, { headers: { cookie: admin } }).then((r) => r.json())
const sumPrices = (v) => v.services.reduce((s, x) => s + (x.priceCents ?? 0), 0)
const svc = (v, title) => v.services.find((s) => s.title === title)

async function createJob(name, services, workPriceCents) {
  const body = { customerName: name, vehicle: { year: '2020', make: 'Honda', model: 'Civic' }, lines: services.map((s) => ({ name: s, priceCents: 0 })), createdBy: 'ZZ admin' }
  if (workPriceCents) body.workPriceCents = workPriceCents
  const r = await fetch(`${BASE}/api/quick-entry/jobs`, { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())
  return r.serviceOrderId
}

const created = []
async function main() {
  // ── 1. Fresh Job (no Work Price) → seeded with catalog suggestions, itemized ──
  const fresh = await createJob('ZZ Est Fresh', ['Interior Detail', 'Exterior Wash']); created.push(fresh)
  let v = (await est(fresh, { action: 'prepare' })).view
  ok('01 fresh Job is itemized (not flat)', v.flat === false)
  ok('02 Interior Detail seeded $300', svc(v, 'Interior Detail')?.priceCents === 30000, `${svc(v, 'Interior Detail')?.priceCents}`)
  ok('03 Exterior Wash seeded $100', svc(v, 'Exterior Wash')?.priceCents === 10000, `${svc(v, 'Exterior Wash')?.priceCents}`)
  ok('04 Work Total = sum of services $400', v.workTotalCents === 40000 && v.workTotalCents === sumPrices(v), `${v.workTotalCents}`)
  let d = (await inv(fresh)).draft
  ok('05 Invoice Draft prices itemized Job (work = $400)', d.priced === true && d.workPriceCents === 40000, `${d.workPriceCents}`)

  // ── 2. Manual price wins; re-prepare never overwrites ──
  v = (await est(fresh, { action: 'set_service_price', serviceId: svc(v, 'Interior Detail').id, cents: 50000 })).view
  ok('06 manual edit → Interior Detail $500', svc(v, 'Interior Detail')?.priceCents === 50000)
  v = (await est(fresh, { action: 'prepare' })).view
  ok('07 re-prepare does NOT overwrite manual price', svc(v, 'Interior Detail')?.priceCents === 50000, `${svc(v, 'Interior Detail')?.priceCents}`)

  // ── 3. Work Total override → exact-penny reallocation ──
  v = (await est(fresh, { action: 'set_work_total', cents: 55000 })).view
  ok('08 set Work Total $550 → services sum EXACTLY to it', sumPrices(v) === 55000 && v.workTotalCents === 55000, `sum=${sumPrices(v)}`)

  // ── 4. Flat Job stays flat on open ──
  const flat = await createJob('ZZ Est Flat', ['Interior Detail', 'Exterior Wash', 'Wax'], 65000); created.push(flat)
  v = (await est(flat, { action: 'prepare' })).view
  ok('09 flat Job stays flat on open', v.flat === true && v.workTotalCents === 65000, `flat=${v.flat} total=${v.workTotalCents}`)
  ok('10 flat Job services have no per-service price yet', v.services.every((s) => s.priceCents === null))
  d = (await inv(flat)).draft
  ok('11 flat Invoice Draft still $650 work → $689.59', d.workPriceCents === 65000 && d.totalCents === 68959, `${d.workPriceCents}/${d.totalCents}`)

  // ── 5. Editing a service price itemizes the flat Job ──
  v = (await est(flat, { action: 'set_service_price', serviceId: svc(v, 'Interior Detail').id, cents: 40000 })).view
  ok('12 flat → itemized on edit; edited service = $400', v.flat === false && svc(v, 'Interior Detail')?.priceCents === 40000, `flat=${v.flat}`)
  ok('13 Work Total re-derives from lines', v.workTotalCents === sumPrices(v))

  // ── 6. "Set individual prices" (itemize action) preserves the flat total exactly ──
  const flat2 = await createJob('ZZ Est Flat2', ['Interior Detail', 'Exterior Wash'], 65000); created.push(flat2)
  await est(flat2, { action: 'prepare' })
  v = (await est(flat2, { action: 'itemize' })).view
  ok('14 itemize action preserves basis ($650) exactly', v.flat === false && v.workTotalCents === 65000 && sumPrices(v) === 65000, `${v.workTotalCents}`)

  // ── 7. Custom add + remove ──
  v = (await est(flat2, { action: 'add_service', title: 'ZZ Touch Up Paint', cents: 7500 })).view
  ok('15 custom service added with price $75', svc(v, 'ZZ Touch Up Paint')?.priceCents === 7500)
  const rid = svc(v, 'Exterior Wash').id
  v = (await est(flat2, { action: 'remove_service', serviceId: rid })).view
  ok('16 remove_service drops the service', !v.services.some((s) => s.id === rid))
}

main().catch((e) => { console.error('ERR', e); fail++ }).finally(async () => {
  for (const oid of created) {
    const vids = await sql.query(`SELECT vehicle_id FROM service_orders WHERE id=$1`, [oid])
    const ests = await sql.query(`SELECT id FROM job_estimates WHERE service_order_id=$1`, [oid])
    for (const e of ests) {
      const s = await sql.query(`SELECT id FROM job_services WHERE job_estimate_id=$1`, [e.id])
      for (const x of s) await sql.query(`DELETE FROM job_line_items WHERE job_service_id=$1`, [x.id])
      await sql.query(`DELETE FROM job_services WHERE job_estimate_id=$1`, [e.id])
    }
    await sql.query(`DELETE FROM job_estimates WHERE service_order_id=$1`, [oid])
    await sql.query(`DELETE FROM quick_entry_jobs WHERE service_order_id=$1`, [oid])
    await sql.query(`DELETE FROM service_order_events WHERE service_order_id=$1`, [oid])
    await sql.query(`DELETE FROM service_orders WHERE id=$1`, [oid])
    for (const vv of vids) await sql.query(`DELETE FROM vehicles WHERE id=$1`, [vv.vehicle_id]).catch(() => {})
  }
  const left = await sql.query(`SELECT count(*)::int n FROM service_orders WHERE customer_name LIKE 'ZZ %'`)
  console.log(`\nCleanup: ZZ service_orders remaining = ${left[0].n}`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})
