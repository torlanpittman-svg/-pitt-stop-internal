/**
 * READ-ONLY comprehensive recurring-outflow audit of *2649 (+ context). Groups every outflow into
 * normalized vendor streams with frequency/amount/date evidence, and flags whether each is already
 * a confirmed obligation. No writes.
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

const rng = (await sql.query(`select min(txn_date) lo, max(txn_date) hi, count(*)::int n from fin_transactions where fin_account_id=$1 and direction='out' and not removed`, [op]))[0]
console.log(`*2649 outflows: ${rng.n} over ${rng.lo} … ${rng.hi}\n`)

console.log('=== ALL recurring OUTFLOW streams (≥2×), by merchant/normalized name ===')
console.log('    vendor                              n   avg        range              modalDOM  last        class(es)')
const streams = await sql.query(`
  with s as (
    select coalesce(merchant_name, regexp_replace(regexp_replace(lower(name),'[0-9]{2,}','#','g'),'\\s+',' ','g')) key,
           amount_cents, txn_date, txn_class,
           extract(day from txn_date)::int dom
    from fin_transactions where fin_account_id=$1 and direction='out' and not removed
  )
  select key, count(*)::int n, round(avg(amount_cents))::int avg, min(amount_cents)::int lo, max(amount_cents)::int hi,
         mode() within group (order by dom) modal_dom, max(txn_date) last,
         string_agg(distinct txn_class, ',') classes
  from s group by key having count(*) >= 2 order by sum(amount_cents) desc limit 60`, [op])
for (const r of streams)
  console.log(`  ${String(r.key).slice(0,34).padEnd(35)} ${String(r.n).padStart(2)}  ${d(r.avg).padStart(9)}  ${(d(r.lo)+'–'+d(r.hi)).padStart(18)}  dom~${String(r.modal_dom).padStart(2)}  ${r.last}  ${r.classes}`)

console.log('\n=== already-confirmed obligations (to compare) ===')
for (const r of await sql.query(`select vendor, category, priority, amount_cents, frequency, day_of_month, day_of_week from fin_obligations where status='confirmed' order by priority, vendor`))
  console.log(`  ${String(r.vendor).slice(0,32).padEnd(33)} ${(r.category||'').padEnd(12)} ${r.priority.padEnd(11)} ${d(r.amount_cents).padStart(10)} ${r.frequency}${r.day_of_month?' dom'+r.day_of_month:''}${r.day_of_week!=null?' dow'+r.day_of_week:''}`)

console.log('\n=== proposed (discovered, unconfirmed) obligations ===')
for (const r of await sql.query(`select vendor, category, priority, avg_amount_cents, frequency, occurrences from fin_obligations where status='proposed' order by (avg_amount_cents*occurrences) desc`))
  console.log(`  ${String(r.vendor).slice(0,32).padEnd(33)} ${(r.category||'').padEnd(10)} ${(r.priority||'').padEnd(11)} ${d(r.avg_amount_cents).padStart(10)} ${r.frequency} ×${r.occurrences}`)
