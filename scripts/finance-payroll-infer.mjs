/**
 * READ-ONLY payroll inference from Plaid *2649 (QBO has no usable payroll data). Shows evidence for
 * a single owner verification of the weekly payroll cash requirement. No writes.
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
const op = (await sql.query(`select id from fin_accounts where name ~ '2649' limit 1`))[0].id

console.log('=== CHECKS on *2649 (name ~ check|clearing), by week ===')
for (const r of await sql.query(`
  select to_char(date_trunc('week',txn_date),'IYYY-IW') wk, min(txn_date) mon,
         count(*)::int n, sum(amount_cents)::int tot, round(avg(amount_cents))::int avg
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed
    and lower(name) ~ 'check|clearing'
  group by wk order by wk`, [op]))
  console.log(`  ${r.wk} wk-of ${r.mon}  ${String(r.n).padStart(2)} checks  total ${d(r.tot).padStart(11)}  avg ${d(r.avg)}`)

console.log('\n=== Distinct check amounts (repeated ≥2×) — recurring paycheck-sized ===')
for (const r of await sql.query(`
  select amount_cents, count(*)::int n, min(txn_date) lo, max(txn_date) hi
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(name) ~ 'check|clearing'
  group by amount_cents having count(*) >= 2 order by n desc, amount_cents desc limit 25`, [op]))
  console.log(`  ${d(r.amount_cents).padStart(11)}  ×${String(r.n).padStart(2)}  ${r.lo}…${r.hi}`)

console.log('\n=== Cash withdrawals (ATM / over-counter) by week ===')
for (const r of await sql.query(`
  select to_char(date_trunc('week',txn_date),'IYYY-IW') wk, count(*)::int n, sum(amount_cents)::int tot
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed and lower(name) ~ 'withdrawal|atm|over.counter|cash'
  group by wk order by wk`, [op]))
  console.log(`  ${r.wk}  ${String(r.n).padStart(2)} wd  total ${d(r.tot)}`)

console.log('\n=== Intuit / QuickBooks / payroll / direct-deposit debits ===')
for (const r of await sql.query(`
  select txn_date, extract(dow from txn_date)::int dow, amount_cents, coalesce(merchant_name,name) nm
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed
    and lower(coalesce(merchant_name,name)) ~ 'intuit|quickbook|payroll|direct dep|dir dep|dfas|gusto|adp'
  order by txn_date desc limit 25`, [op]))
  console.log(`  ${r.txn_date} ${DOW[r.dow]}  ${d(r.amount_cents).padStart(10)}  ${String(r.nm).slice(0,44)}`)

console.log('\n=== Tax-authority payments (payroll tax deposits?) ===')
for (const r of await sql.query(`
  select txn_date, amount_cents, coalesce(merchant_name,name) nm
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed
    and lower(coalesce(merchant_name,name)) ~ 'irs|internal revenue|eftps|tax|comptroller|twc|941'
  order by txn_date desc limit 20`, [op]))
  console.log(`  ${r.txn_date}  ${d(r.amount_cents).padStart(11)}  ${String(r.nm).slice(0,44)}`)

console.log('\n=== Largest recurring OUTFLOWS Wed–Fri (payroll window), by name+~amount ===')
for (const r of await sql.query(`
  select coalesce(merchant_name, regexp_replace(lower(name),'[0-9]{2,}','#','g')) key,
         round(avg(amount_cents))::int avg, count(*)::int n, min(txn_date) lo, max(txn_date) hi
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed
    and extract(dow from txn_date) in (3,4,5)
  group by key having count(*) >= 3 order by avg*n desc limit 20`, [op]))
  console.log(`  ${String(r.key).slice(0,32).padEnd(33)} avg ${d(r.avg).padStart(10)} ×${String(r.n).padStart(2)}  ${r.lo}…${r.hi}`)
