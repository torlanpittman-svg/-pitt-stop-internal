/**
 * Seed CONFIRMED debt obligations from verified loan statements + matched bank debits. Idempotent by
 * discovery_key. Sets payment_account_id so the calendar is per-account. No money movement.
 *
 * Established from actual transaction history (which account, modal day-of-month):
 *  *2649 (operating): 4 QuickBooks Capital loans.
 *  *5600 (auto-sales): Extraco F250 (fixed), RLOC interest, Floor-plan interest (+ variable curtailments).
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)
const acct = async (mask) => (await sql.query(`select fa.id from fin_accounts fa join fin_plaid_accounts pa on pa.mapped_account_id=fa.id where pa.mask=$1`, [mask]))[0]?.id
const OP = await acct('2649'), AS = await acct('5600')

// vendor, category, amount_cents, dayOfMonth, priority, acctId, notes
const DEBTS = [
  ['QB Capital loan #071b7e6', 'debt', 145576, 9,  'critical', OP, 'Verified statement 28.95% APR; auto-debit *2649 ~9th (QBC_PMTS INTUIT FINANCING)'],
  ['QB Capital loan #935150a', 'debt', 56595,  3,  'critical', OP, 'Verified statement 29.05% APR; auto-debit *2649 ~3rd'],
  ['QB Capital loan #5d005d5', 'debt', 45826,  20, 'critical', OP, 'Verified statement 29.14% APR; auto-debit *2649 ~20th'],
  ['QB Capital loan #90044eb', 'debt', 17843,  22, 'critical', OP, 'Verified statement 33.14% APR; auto-debit *2649 ~22nd'],
  ['Extraco F250 loan',        'debt', 149873, 22, 'critical', AS, 'Verified 5.50% fixed; Transfer to Loan Acct 375782 from *5600 ~22nd'],
  ['Extraco RLOC interest',    'debt', 17200,  15, 'critical', AS, 'Verified 8.75% var interest-only; from *5600 ~15th (varies with balance; excl. discretionary paydowns)'],
  ['Extraco Floor Plan interest', 'debt', 56000, 27, 'critical', AS, 'Verified 8.25% var interest ~$550-575/mo from *5600; PLUS variable principal curtailments as vehicles sell (not fixed)'],
]

for (const [vendor, category, amt, dom, priority, acctId, notes] of DEBTS) {
  const key = `seed:${vendor}`
  const ex = (await sql.query(`select id from fin_obligations where discovery_key=$1`, [key]))[0]
  if (ex) {
    await sql.query(`update fin_obligations set vendor=$2, category=$3, amount_cents=$4, avg_amount_cents=$4, frequency='monthly', day_of_month=$5, priority=$6, critical=true, essential=true, committed_on_issue=false, payment_account_id=$7, source='confirmed', confidence='manual_verified', status='confirmed', notes=$8 where id=$1`, [ex.id, vendor, category, amt, dom, priority, acctId, notes])
    console.log(`  ~ ${vendor}`)
  } else {
    await sql.query(`insert into fin_obligations(vendor,category,amount_cents,avg_amount_cents,frequency,day_of_month,priority,critical,essential,committed_on_issue,payment_account_id,status,source,confidence,entered_by,discovery_key,notes) values($1,$2,$3,$3,'monthly',$4,$5,true,true,false,$6,'confirmed','confirmed','manual_verified','owner',$7,$8)`, [vendor, category, amt, dom, priority, acctId, key, notes])
    console.log(`  + ${vendor} ($${(amt/100).toFixed(2)}, day ${dom}, ${acctId===OP?'*2649':'*5600'})`)
  }
}

// Set payment_account_id = *2649 on the existing operating obligations (payroll/tax/rent/owner-draw)
await sql.query(`update fin_obligations set payment_account_id=$1 where payment_account_id is null and (category in ('payroll','payroll_tax','owner_draw','rent') or discovery_key like 'seed:Payroll%' or discovery_key like 'seed:Federal%' or discovery_key like 'seed:Rent%' or discovery_key like 'seed:Owner%')`, [OP])
console.log('  set *2649 as payer on payroll/tax/rent/owner-draw')
console.log('Done.')
