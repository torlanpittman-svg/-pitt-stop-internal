/**
 * Record the IRS back-tax payment plan as a PAUSED obligation — status UNKNOWN / NEEDS VERIFICATION.
 * Owner confirmed the two $1,500 IRS debits (6/15, 7/15) were a $1,500/month IRS back-tax installment
 * plan; payments stopped after 7/15 and current status is unknown (complete? paused? changed?).
 * Stored PAUSED so it is NEVER counted in Safe-to-Spend / obligation calendar as a definite bill, but
 * is surfaced as a data-gap/risk and in the "Needs verification" band. No money movement.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)
const OP = (await sql.query(`select fa.id from fin_accounts fa join fin_plaid_accounts pa on pa.mapped_account_id=fa.id where pa.mask='2649'`))[0].id
const key = 'irs-backtax-plan'
const notes = 'IRS back-tax installment plan ~$1,500/mo. Observed direct EFTPS debits 6/15/2026 $1,500 + 7/15/2026 $1,500 (NOT in QuickBooks payroll tax history = separate from current 941). Owner confirmed it is a back-tax payment plan. Payments STOPPED after 7/15 — plan may be complete, paused, changed, or something else. STATUS UNKNOWN / NEEDS VERIFICATION with IRS. Do NOT assume another $1,500 is definitely due; do NOT assume it ended. Surfaced as risk/data-gap only; PAUSED so it does not affect Safe-to-Spend until verified.'
const ex = (await sql.query(`select id from fin_obligations where discovery_key=$1`, [key]))[0]
if (ex) { await sql.query(`update fin_obligations set vendor=$2,category='tax',amount_cents=150000,avg_amount_cents=150000,frequency='monthly',day_of_month=15,priority='critical',status='paused',confidence='estimated',payment_account_id=$3,notes=$4 where id=$1`, [ex.id, 'IRS back-tax payment plan', OP, notes]); console.log('~ updated IRS back-tax plan (paused)') }
else { await sql.query(`insert into fin_obligations(vendor,category,amount_cents,avg_amount_cents,frequency,day_of_month,priority,critical,payment_account_id,status,source,confidence,entered_by,discovery_key,notes) values($1,'tax',150000,150000,'monthly',15,'critical',true,$2,'paused','document','estimated','recon',$3,$4)`, [ 'IRS back-tax payment plan', OP, key, notes]); console.log('+ seeded IRS back-tax plan (paused, needs verification)') }
