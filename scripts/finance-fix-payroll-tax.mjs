/**
 * CORRECT the payroll-tax cash model after QuickBooks Payroll read-only reconciliation (2026-08-27).
 * FINDINGS (QB Payroll → Payroll taxes → Tax transactions / Payment history, exact bank match):
 *  - Bank "TAX INTUIT" debits == QB "Payroll tax withdrawal": Intuit withdraws federal payroll tax
 *    (941: FIT + SS ee/er + Medicare ee/er) from *2649 per payroll run, ~weekly, tied to Friday payroll,
 *    withdrawn 1-3 business days later. Amounts observed: $292.88-$1,095.75; empirical avg ~$520/wk.
 *  - QB "Agency payment / Electronic" (bank "USATAXPYMT IRS" $365.25 7/29, $1,095.75 8/25) == Intuit
 *    REMITTING the already-withdrawn money to the IRS (prior month's liability). SAME money as the
 *    TAX INTUIT withdrawal — NOT additional cash. Verified: Jun-period withdrawals ($3,015.75) ==
 *    Jun-period IRS remittances ($3,015.75).
 *  - The $2,394.54 "941" figure = QB's AUGUST monthly 941 liability, still ACCRUING, due 09/15, "paying
 *    automatically" — it is the SUM of the ~weekly TAX INTUIT withdrawals, NOT a separate future debit.
 *  - Two round IRS "USATAXPYMT" $1,500 debits (6/15, 7/15) do NOT appear in QB payroll history =
 *    SEPARATE direct/back-tax payments (owner to confirm; NOT modeled here).
 * CORRECTION: model federal payroll tax as WEEKLY ~$525 tied to payroll (accurate withdrawal timing),
 * replacing the single monthly dom-15 lump. Amount ~= monthly $2,275 (~QB $2,394.54 liability). Safe-to-
 * Spend subtracts it ONCE (this is the only payroll-tax obligation). No money movement; read-only recon.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)
const ID = '1cbc45bc-d724-4f5e-96e2-c109360dbc38'
const notes = 'Federal payroll tax (941: FIT+SS ee/er+Medicare ee/er) WITHDRAWN by Intuit from *2649 as bank "TAX INTUIT" (=QB "Payroll tax withdrawal"), ~weekly with payroll, 1-3 business days after Friday. Observed $292.88-$1,095.75, empirical avg ~$520/wk = ~$2,275/mo. Intuit then REMITS to IRS (bank "USATAXPYMT IRS" = QB "Agency payment") from that same withdrawn money — do NOT double-count USATAXPYMT with TAX INTUIT (Jun withdrawals $3,015.75 == Jun IRS remittances $3,015.75, verified). QB accounting 941 monthly liability = $2,394.54 (Aug, accruing, due 09/15, paying automatically) — this is the SUM of the weekly withdrawals, not an extra debit. Verified read-only in QuickBooks Payroll 2026-08-27.'
await sql.query(`update fin_obligations set vendor=$2, amount_cents=$3, avg_amount_cents=$3, amount_min_cents=$4, amount_max_cents=$5, frequency='weekly', day_of_month=null, day_of_week=2, confidence='manual_verified', notes=$6 where id=$1`,
  [ID, 'Federal payroll tax (Intuit withdrawal)', 52500, 29288, 109575, notes])
console.log('Updated federal payroll-tax obligation → weekly $525 (Tue, with payroll), verified.')
// show the resulting weekly payroll-cycle picture
const d=(c)=>`$${(c/100).toLocaleString('en-US',{minimumFractionDigits:2})}`
const wk = await sql.query(`select vendor, amount_cents from fin_obligations where frequency='weekly' and status='confirmed' order by amount_cents desc`)
let net=0,tax=0,draw=0
for(const r of wk){ if(/owner|distribution/i.test(r.vendor)) draw+=r.amount_cents; else if(/tax/i.test(r.vendor)) tax+=r.amount_cents; else net+=r.amount_cents }
console.log(`\nNORMAL WEEKLY PAYROLL CYCLE: net checks ${d(net)} + payroll tax ${d(tax)} = ${d(net+tax)} (+ owner draw ${d(draw)} = ${d(net+tax+draw)})`)
console.log(`Monthly-equiv: payroll ${d(Math.round(net*52/12))} + tax ${d(Math.round(tax*52/12))} = ${d(Math.round((net+tax)*52/12))}`)
