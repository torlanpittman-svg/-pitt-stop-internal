/**
 * READ-ONLY transaction analysis for the CFO stop-point report: classification, pending, and
 * payroll / rent / recurring-outflow inference (evidence for owner verification). No writes.
 *   node scripts/finance-tx-report.mjs
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

// Which fin_account is *2649 (operating)?
const op = (await sql.query(`select id, name from fin_accounts where name ~ '2649' limit 1`))[0]
console.log(`\nOperating account: ${op?.name} (${op?.id})`)

console.log('\n==================== COVERAGE ====================')
for (const r of await sql.query(`
  select coalesce(fa.name, 'UNMAPPED/ignored') acct, count(*)::int n, min(txn_date) lo, max(txn_date) hi,
         sum((pending)::int)::int pend
  from fin_transactions t left join fin_accounts fa on fa.id=t.fin_account_id
  where not t.removed group by fa.name order by n desc`))
  console.log(`  ${String(r.acct).padEnd(28)} ${String(r.n).padStart(4)} txns  ${r.lo}…${r.hi}  pending ${r.pend}`)

console.log('\n==================== CLASSIFICATION (operating *2649) ====================')
for (const r of await sql.query(`
  select txn_class, count(*)::int n,
         coalesce(sum(case when direction='out' then amount_cents else 0 end),0)::int outc,
         coalesce(sum(case when direction='in' then -amount_cents else 0 end),0)::int inc
  from fin_transactions where fin_account_id=$1 and not removed group by txn_class order by n desc`, [op?.id]))
  console.log(`  ${r.txn_class.padEnd(14)} n=${String(r.n).padStart(4)}  out ${d(r.outc).padStart(12)}  in ${d(r.inc).padStart(12)}`)

console.log('\n==================== PAYROLL INFERENCE (operating *2649) ====================')
console.log('  (a) name-classified payroll:')
for (const r of await sql.query(`
  select txn_date, extract(dow from txn_date)::int dow, amount_cents, coalesce(merchant_name,name) nm, class_evidence
  from fin_transactions where fin_account_id=$1 and txn_class='payroll' and not removed order by txn_date desc limit 20`, [op?.id]))
  console.log(`    ${r.txn_date} ${DOW[r.dow]}  ${d(r.amount_cents).padStart(11)}  ${String(r.nm).slice(0, 40)}`)

console.log('\n  (b) recurring OUTFLOWS by merchant+~amount (top candidates, all classes):')
for (const r of await sql.query(`
  select coalesce(merchant_name, regexp_replace(lower(name), '[0-9]{2,}', '#', 'g')) key,
         round(avg(amount_cents))::int avg_c, count(*)::int n,
         min(txn_date) lo, max(txn_date) hi,
         mode() within group (order by extract(dow from txn_date)::int) dow
  from fin_transactions
  where fin_account_id=$1 and direction='out' and not removed
  group by key having count(*) >= 3
  order by n desc limit 25`, [op?.id]))
  console.log(`    ${String(r.key).slice(0, 34).padEnd(35)} avg ${d(r.avg_c).padStart(10)}  ×${String(r.n).padStart(3)}  ${DOW[r.dow]}  ${r.lo}…${r.hi}`)

console.log('\n  (c) Friday outflow distribution (payroll usually lands Friday):')
for (const r of await sql.query(`
  select extract(dow from txn_date)::int dow, count(*)::int n, coalesce(sum(amount_cents),0)::int total
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed
  group by dow order by dow`, [op?.id]))
  console.log(`    ${DOW[r.dow]}: ${String(r.n).padStart(4)} outflows, total ${d(r.total)}`)

console.log('\n==================== RENT CANDIDATES (~$5,000 near the 15th) ====================')
for (const r of await sql.query(`
  select txn_date, amount_cents, coalesce(merchant_name,name) nm, txn_class
  from fin_transactions where fin_account_id=$1 and direction='out' and not removed
    and amount_cents between 450000 and 550000 order by txn_date desc limit 15`, [op?.id]))
  console.log(`    ${r.txn_date}  ${d(r.amount_cents).padStart(11)}  [${r.txn_class}]  ${String(r.nm).slice(0, 40)}`)

console.log('\n==================== PENDING (operating *2649) ====================')
for (const r of await sql.query(`
  select txn_date, direction, amount_cents, txn_class, coalesce(merchant_name,name) nm
  from fin_transactions where fin_account_id=$1 and pending and not removed order by txn_date desc limit 15`, [op?.id]))
  console.log(`    ${r.txn_date} ${r.direction==='out'?'-':'+'}${d(r.amount_cents)}  [${r.txn_class}]  ${String(r.nm).slice(0,40)}`)
console.log('')
