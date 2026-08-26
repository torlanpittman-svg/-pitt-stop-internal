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

console.log('=== INTUIT payroll-ish ACH (excl financing/tran-fee) on *2649, weekly ===')
for (const r of await sql.query(`select to_char(date_trunc('week',txn_date),'IYYY-IW') wk, count(*)::int n, sum(amount_cents)::int tot
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed
    and lower(coalesce(merchant_name,name)) ~ 'intuit' and lower(coalesce(merchant_name,name)) !~ 'financing|tran fee'
  group by wk order by wk`, [op]))
  console.log(`  ${r.wk}  ${r.n} debits  ${d(r.tot)}`)

console.log('\n=== recurring CHECKS on *2649 (excl $1,000 owner-draw), payroll candidates ===')
for (const r of await sql.query(`select amount_cents, count(*)::int n, mode() within group (order by extract(dow from txn_date)::int) dow, min(txn_date) lo, max(txn_date) hi
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(name) ~ 'check|clearing' and amount_cents not between 99000 and 101000
  group by amount_cents having count(*)>=3 order by n desc limit 12`, [op]))
  console.log(`  ${d(r.amount_cents).padStart(10)} ×${r.n}  ${DOW[r.dow]}  ${r.lo}…${r.hi}`)

console.log('\n=== $1,000 owner-draw 2649→0169, cadence ===')
const od = (await sql.query(`select count(*)::int n, min(txn_date) lo, max(txn_date) hi from fin_transactions where fin_account_id=$1 and direction='out' and not removed and amount_cents between 99000 and 101000 and lower(name) ~ '0169|to checking'`, [op]))[0]
console.log(`  $1,000 → *0169: ×${od.n}  ${od.lo}…${od.hi}`)

console.log('\n=== IRS / tax deposits on *2649 (payroll tax) ===')
for (const r of await sql.query(`select txn_date, amount_cents, coalesce(merchant_name,name) nm from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(coalesce(merchant_name,name)) ~ 'internal revenue|irs|eftps|941' order by txn_date desc`, [op]))
  console.log(`  ${r.txn_date}  ${d(r.amount_cents).padStart(10)}  ${String(r.nm).slice(0, 40)}`)

console.log('\n=== ALL distinct Intuit descriptions (to separate payroll vs financing vs fees) ===')
for (const r of await sql.query(`select coalesce(merchant_name,name) nm, count(*)::int n, sum(amount_cents)::int tot from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(coalesce(merchant_name,name)) ~ 'intuit|qbc' group by nm order by tot desc`, [op]))
  console.log(`  ${String(r.nm).slice(0, 40).padEnd(41)} ×${String(r.n).padStart(2)}  ${d(r.tot)}`)
