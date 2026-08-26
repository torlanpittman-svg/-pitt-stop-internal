/**
 * READ-ONLY segment + owner-draw + payroll + encumbrance analysis. No writes.
 *   node scripts/finance-segment.mjs
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)
const d = (c) => `$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const acc = async (mask) => (await sql.query(`select fa.id from fin_accounts fa join fin_plaid_accounts pa on pa.mapped_account_id=fa.id where pa.mask=$1`, [mask]))[0]?.id
const op = await acc('2649'), as = await acc('5600')

console.log('==================== OWNER DRAW candidates on *2649 ($1,000 recurring) ====================')
for (const r of await sql.query(`select txn_date, extract(dow from txn_date)::int dow, coalesce(merchant_name,name) nm, txn_class
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed and amount_cents between 99000 and 101000 order by txn_date desc`, [op]))
  console.log(`  ${r.txn_date} ${DOW[r.dow]}  [${r.txn_class}]  ${String(r.nm).slice(0, 50)}`)

console.log('\n==================== "Pittman" / "Darryl" mentions (any account) ====================')
for (const r of await sql.query(`select txn_date, coalesce(merchant_name,name) nm, amount_cents, direction from fin_transactions where not removed and lower(coalesce(merchant_name,name)) ~ 'pittman|darryl|darr' order by txn_date desc limit 20`))
  console.log(`  ${r.txn_date}  ${r.direction === 'out' ? '-' : '+'}${d(r.amount_cents)}  ${String(r.nm).slice(0, 50)}`)

console.log('\n==================== ~$500 recurring on *2649 (Darryl W-2 candidate) ====================')
for (const r of await sql.query(`select amount_cents, count(*)::int n, min(txn_date) lo, max(txn_date) hi, mode() within group (order by extract(dow from txn_date)::int) dow
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed and amount_cents between 40000 and 60000 group by amount_cents having count(*)>=2 order by n desc`, [op]))
  console.log(`  ${d(r.amount_cents).padStart(9)} ×${r.n}  ${DOW[r.dow]}  ${r.lo}…${r.hi}`)

console.log('\n==================== VEHICLE / AUTO-SALES spending OUT of *2649 (division mixing) ====================')
const vehRe = 'floor.?plan|nextgear|next gear|afc |westlake|manheim|adesa|copart| iaa |auction|dealer|dmv|title|tag |registration|reconditio|body shop|transmission|tow|wrecker|carfax|kbb|dealer license|tax assessor|county tax'
for (const r of await sql.query(`select coalesce(merchant_name, regexp_replace(lower(name),'[0-9]{2,}','#','g')) key, count(*)::int n, sum(amount_cents)::int tot
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(coalesce(merchant_name,name)) ~ $2 group by key order by tot desc limit 20`, [op, vehRe]))
  console.log(`  ${String(r.key).slice(0, 38).padEnd(39)} ×${String(r.n).padStart(2)}  ${d(r.tot)}`)
const vehTot = (await sql.query(`select coalesce(sum(amount_cents),0)::int c, count(*)::int n from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(coalesce(merchant_name,name)) ~ $2`, [op, vehRe]))[0]
console.log(`  → total vehicle/auto-ish OUT of *2649: ${d(vehTot.c)} over ${vehTot.n} txns`)

console.log('\n==================== *5600 (Extraco / auto-sales) — inflows (vehicle sales?) ====================')
for (const r of await sql.query(`select txn_date, -amount_cents::int amt, coalesce(merchant_name,name) nm from fin_transactions where fin_account_id=$1 and direction='in' and not removed order by amount_cents asc limit 15`, [as]))
  console.log(`  ${r.txn_date}  +${d(r.amt).padStart(11)}  ${String(r.nm).slice(0, 44)}`)

console.log('\n==================== *5600 — floor-plan / title / payoff OUTFLOWS (encumbrance) ====================')
for (const r of await sql.query(`select txn_date, amount_cents, coalesce(merchant_name,name) nm from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(coalesce(merchant_name,name)) ~ $2 order by txn_date desc limit 20`, [as, vehRe]))
  console.log(`  ${r.txn_date}  ${d(r.amount_cents).padStart(11)}  ${String(r.nm).slice(0, 44)}`)
const encTot = (await sql.query(`select coalesce(sum(amount_cents),0)::int c, count(*)::int n from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(coalesce(merchant_name,name)) ~ $2`, [as, vehRe]))[0]
console.log(`  → floor-plan/title-ish OUT of *5600 (90d): ${d(encTot.c)} over ${encTot.n} txns`)

console.log('\n==================== *5600 top recurring outflows (what auto-sales pays) ====================')
for (const r of await sql.query(`select coalesce(merchant_name, regexp_replace(lower(name),'[0-9]{2,}','#','g')) key, count(*)::int n, sum(amount_cents)::int tot
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed group by key having count(*)>=2 order by tot desc limit 15`, [as]))
  console.log(`  ${String(r.key).slice(0, 38).padEnd(39)} ×${String(r.n).padStart(2)}  ${d(r.tot)}`)
