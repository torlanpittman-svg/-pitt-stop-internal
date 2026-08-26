/**
 * READ-ONLY reconciliation of QuickBooks Payroll figures against *2649 Plaid clearings.
 * QB net checks (weekly Fri): Torlan $1,572.45, Anthony $1,006.12, Darryl $461.75.
 * Hourly (Mon, $11/hr): Jermie Townsend, Jerry Travis — do they actually clear the bank?
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
const op = (await sql.query(`select fa.id from fin_accounts fa join fin_plaid_accounts pa on pa.mapped_account_id=fa.id where pa.mask='2649'`))[0].id

console.log('=== Net-pay check amounts in *2649 clearings (QB payroll anchors) ===')
for (const [nm, cents] of [['Torlan 1572.45', 157245], ['Anthony 1006.12', 100612], ['Darryl 461.75', 46175]]) {
  const r = await sql.query(`select txn_date, extract(dow from txn_date)::int dow from fin_transactions where fin_account_id=$1 and direction='out' and not removed and amount_cents=$2 order by txn_date`, [op, cents])
  console.log(`  ${nm.padEnd(16)} → ${r.length} matches: ${r.map(x => x.txn_date + '(' + DOW[x.dow] + ')').join(', ') || 'NONE'}`)
}

console.log('\n=== All check/clearing amounts in *2649, ranked (find hourly Monday checks) ===')
for (const r of await sql.query(`select amount_cents, count(*)::int n, string_agg(distinct to_char(txn_date,'Dy'),',') days, min(txn_date) lo, max(txn_date) hi
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(name) ~ 'clearing|check'
  group by amount_cents order by n desc, amount_cents desc limit 30`, [op]))
  console.log(`  ${d(r.amount_cents).padStart(11)} ×${String(r.n).padStart(2)}  [${r.days}]  ${r.lo}…${r.hi}`)

console.log('\n=== Monday check-clearings (hourly employee candidates) ===')
for (const r of await sql.query(`select txn_date, amount_cents from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(name) ~ 'clearing|check' and extract(dow from txn_date)=1 order by txn_date desc limit 20`, [op]))
  console.log(`  ${r.txn_date} Mon  ${d(r.amount_cents)}`)

console.log('\n=== IRS / EFTPS federal tax deposits in *2649 (payroll tax cash) ===')
for (const r of await sql.query(`select txn_date, amount_cents, coalesce(merchant_name,name) nm from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(coalesce(merchant_name,name)) ~ 'internal revenue|irs|eftps|941' order by txn_date`, [op]))
  console.log(`  ${r.txn_date}  ${d(r.amount_cents).padStart(10)}  ${String(r.nm).slice(0, 34)}`)

console.log('\n=== Friday total check-clearing cash by week (net payroll proxy) ===')
for (const r of await sql.query(`select to_char(date_trunc('week',txn_date),'IYYY-IW') wk, min(txn_date) mon,
    coalesce(sum(case when extract(dow from txn_date)=5 then amount_cents else 0 end),0)::int fri,
    coalesce(sum(amount_cents),0)::int allwk
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(name) ~ 'clearing|check'
  group by wk order by wk`, [op]))
  console.log(`  ${r.wk} wk-of ${r.mon}  Fri-clearings ${d(r.fri).padStart(10)}  all-week ${d(r.allwk)}`)
