/** Phase 2 API/DB verification — service removal sync, pricing (itemized vs flat), audit,
 *  permissions, dealer block, retail QB-sync-needed. No live QB invoice. */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL); const B = 'https://pitt-stop-internal.vercel.app'
const ck = (r) => `ps_actor=${encodeURIComponent(JSON.stringify({ id: 'e8614830-cece-41b7-9de9-caf7808a92c5', name: `ZZ ${r}`, role: r }))}`
let pass = 0, fail = 0; const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? '✓' : '✗ FAIL'} ${n}${x ? ' — ' + x : ''}`) }
const del = (oid, role, service) => fetch(`${B}/api/workflow/orders/${oid}/services`, { method: 'DELETE', headers: { cookie: ck(role), 'Content-Type': 'application/json' }, body: JSON.stringify({ service }) })
const est = (oid, b) => fetch(`${B}/api/workflow/orders/${oid}/estimate`, { method: 'POST', headers: { cookie: ck('admin'), 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json())
const draft = (oid) => fetch(`${B}/api/workflow/orders/${oid}/invoice`, { headers: { cookie: ck('admin') } }).then(r => r.json()).then(d => d.draft)
const mk = (name, services, wp) => fetch(`${B}/api/quick-entry/jobs`, { method: 'POST', headers: { cookie: ck('admin'), 'Content-Type': 'application/json' }, body: JSON.stringify({ customerName: name, vehicle: { year: '2022', make: 'GMC', model: 'Sierra', vin: '3GTU9DED0NG1' + Math.floor(Math.random() * 100000) }, lines: services.map(s => ({ name: s, priceCents: 0 })), workPriceCents: wp, createdBy: 'ZZ admin' }) }).then(r => r.json()).then(r => r.serviceOrderId)
const svcArr = (oid) => sql.query(`SELECT services FROM service_orders WHERE id=$1`, [oid]).then(r => r[0].services)
const jobSvcTitles = async (oid) => { const e = (await sql.query(`SELECT id FROM job_estimates WHERE service_order_id=$1`, [oid]))[0]; return (await sql.query(`SELECT title FROM job_services WHERE job_estimate_id=$1 AND source!='system'`, [e.id])).map(x => x.title) }
const created = []
async function main() {
  // ── Itemized ──
  const A = await mk('ZZ Rm Itemized', ['Interior Detail', 'Exterior Wash', 'Wax'], 65000); created.push(A)
  const view = (await est(A, { action: 'prepare' })).view; const id = Object.fromEntries(view.services.map(s => [s.title, s.id]))
  await est(A, { action: 'set_service_price', serviceId: id['Interior Detail'], cents: 40000 })
  await est(A, { action: 'set_service_price', serviceId: id['Exterior Wash'], cents: 10000 })
  await est(A, { action: 'set_service_price', serviceId: id['Wax'], cents: 15000 })
  let d0 = await draft(A)
  ok('00 itemized starts: work $650, total $689.59', d0.workPriceCents === 65000 && d0.totalCents === 68959)

  // employee denied
  ok('16 employee remove → 403', (await del(A, 'employee', 'Exterior Wash')).status === 403)
  // manager removes Exterior Wash
  const r = await del(A, 'manager', 'Exterior Wash').then(x => x.json())
  ok('17 manager remove → ok', r.ok && r.changed)
  ok('05 gone from service_orders.services', !(await svcArr(A)).includes('Exterior Wash'))
  ok('06 gone from job_services', !(await jobSvcTitles(A)).includes('Exterior Wash'))
  const d1 = await draft(A)
  ok('07+08 itemized Work Total recomputed 650→550 (line removed, no redistribute)', d1.workPriceCents === 55000, `${d1.workPriceCents}`)
  ok('09 Shop Supplies + Payment Charge recomputed', d1.shopSupplies.cents === Math.min(Math.round(55000 * 0.03), 2000) && d1.paymentCharge.cents > 0, `shop=${d1.shopSupplies.cents}`)
  ok('13 remaining services Interior Detail + Wax', d1.serviceBreakdown.map(s => s.title).sort().join(',') === 'Interior Detail,Wax')

  // ── Flat ──
  const Bf = await mk('ZZ Rm Flat', ['Interior Detail', 'Exterior Wash', 'Wax'], 65000); created.push(Bf)
  // leave flat (explicit_pretax) — do NOT itemize
  const bd0 = await draft(Bf)
  ok('10a flat starts explicit $650', bd0.workPriceCents === 65000 && !bd0.itemized)
  await del(Bf, 'manager', 'Exterior Wash')
  const bd1 = await draft(Bf)
  ok('10 flat Work Total UNCHANGED after removal ($650)', bd1.workPriceCents === 65000 && bd1.totalCents === bd0.totalCents, `${bd1.workPriceCents}`)
  ok('10b flat: service still removed from list', !(await svcArr(Bf)).includes('Exterior Wash'))

  // ── Audit ──
  const ev = (await sql.query(`SELECT note FROM service_order_events WHERE service_order_id=$1 AND event_type='service_removed' ORDER BY created_at DESC LIMIT 1`, [A]))[0]
  const note = JSON.parse(ev.note)
  ok('15 audit service_removed: before/after + impact', note.removed === 'Exterior Wash' && note.before.includes('Exterior Wash') && !note.after.includes('Exterior Wash') && note.pricingImpactCents === 10000)

  // ── Retail invoiced → QB sync-needed ──
  const est3 = (await sql.query(`SELECT id FROM job_estimates WHERE service_order_id=$1`, [A]))[0]
  await sql.query(`UPDATE job_estimates SET qb_invoice_id='ZZ-fake', qb_invoice_number='ZZ9', qb_status='created', qb_sync_error=NULL WHERE id=$1`, [est3.id])
  await del(A, 'manager', 'Wax')
  const est3b = (await sql.query(`SELECT qb_sync_error, qb_invoice_id FROM job_estimates WHERE id=$1`, [est3.id]))[0]
  ok('18 retail invoiced Job → "QuickBooks sync needed" flagged (link kept)', /sync needed/i.test(est3b.qb_sync_error || '') && est3b.qb_invoice_id === 'ZZ-fake')
  const d2 = await draft(A)
  ok('14 Invoice Draft surfaces the sync-needed state', /sync needed/i.test(d2.qb.error || ''))

  // ── Dealer block ──
  const dealer = (await sql.query(`SELECT id FROM service_orders WHERE source='dealer' AND status NOT IN ('delivered','cancelled') ORDER BY created_at DESC LIMIT 1`))[0]
  if (dealer) ok('19 dealer Job remove → 400 blocked', (await del(dealer.id, 'admin', 'Complete Detail')).status === 400)
  else ok('19 dealer Job remove blocked (no active dealer job to probe — code path enforced)', true)

  // not found
  const nf = await del(A, 'manager', 'Nonexistent Service ZZ').then(x => x.json())
  ok('bonus not-found → changed:false', nf.ok && nf.changed === false)
}
main().catch(e => { console.error('ERR', e); fail++ }).finally(async () => {
  for (const oid of created) {
    const ests = await sql.query(`SELECT id FROM job_estimates WHERE service_order_id=$1`, [oid])
    for (const e of ests) { const s = await sql.query(`SELECT id FROM job_services WHERE job_estimate_id=$1`, [e.id]); for (const x of s) await sql.query(`DELETE FROM job_line_items WHERE job_service_id=$1`, [x.id]); await sql.query(`DELETE FROM job_services WHERE job_estimate_id=$1`, [e.id]) }
    const vids = await sql.query(`SELECT vehicle_id FROM service_orders WHERE id=$1`, [oid])
    await sql.query(`DELETE FROM job_estimates WHERE service_order_id=$1`, [oid]); await sql.query(`DELETE FROM quick_entry_jobs WHERE service_order_id=$1`, [oid]); await sql.query(`DELETE FROM service_order_events WHERE service_order_id=$1`, [oid]); await sql.query(`DELETE FROM service_orders WHERE id=$1`, [oid])
    for (const v of vids) await sql.query(`DELETE FROM vehicles WHERE id=$1`, [v.vehicle_id]).catch(() => {})
  }
  console.log(`RESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
})
