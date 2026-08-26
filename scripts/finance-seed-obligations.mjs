/**
 * Seed owner-CONFIRMED critical/planned obligations (idempotent by discovery_key). No money movement.
 * Facts (owner-verified 2026-08-26):
 *  - Employee payroll (3 salaried, Friday): Torlan $1,572.45, Anthony $1,006.12, Darryl $461.75.
 *    Paper checks — committed on Friday for Safe-to-Spend even if they clear later. priority=critical.
 *  - Federal payroll tax (941): monthly ~$2,394.54 due the 15th (paid to IRS). priority=critical.
 *  - Rent: $5,000 planned cash ($4,916.66 contractual) due the 15th → holding co. priority=contractual.
 *  - Darryl owner distribution: $1,000/week, planned/deferrable equity outflow. priority=planned.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)
const FRI = 5

// vendor, category, amount_cents, frequency, priority, critical, committed_on_issue, day_of_week, day_of_month, notes
const OBLIGATIONS = [
  ['Payroll — Torlan Pittman', 'payroll', 157245, 'weekly', 'critical', true, true, FRI, null, 'Confirmed QB Payroll net; paper check Friday'],
  ['Payroll — Anthony Pittman', 'payroll', 100612, 'weekly', 'critical', true, true, FRI, null, 'Confirmed QB Payroll net; paper check Friday'],
  ['Payroll — Darryl Pittman (W-2)', 'payroll', 46175, 'weekly', 'critical', true, true, FRI, null, 'Confirmed QB Payroll net; W-2 salary, distinct from owner draw'],
  ['Federal payroll tax (941)', 'payroll_tax', 239454, 'monthly', 'critical', true, false, null, 15, 'QB monthly 941 depositor; paid to IRS ~15th; reconcile to IRS bank debits (no double-count)'],
  ['Rent — holding company', 'rent', 500000, 'monthly', 'contractual', true, false, null, 15, 'Planned $5,000 cash ($4,916.66 contractual) due 15th; late payment does NOT change due date'],
  ['Owner distribution — Darryl Pittman', 'owner_draw', 100000, 'weekly', 'planned', false, false, FRI, null, 'Equity cash-out (NOT payroll); planned/deferrable; via *2649→*0169'],
]

for (const [vendor, category, amt, freq, priority, critical, committed, dow, dom, notes] of OBLIGATIONS) {
  const key = `seed:${vendor}`
  const existing = (await sql.query(`select id, status from fin_obligations where discovery_key=$1`, [key]))[0]
  if (existing) {
    // Refresh figures but preserve owner status if they changed it; keep confirmed.
    await sql.query(
      `update fin_obligations set vendor=$2, category=$3, amount_cents=$4, avg_amount_cents=$4, frequency=$5,
        priority=$6, critical=$7, committed_on_issue=$8, day_of_week=$9, day_of_month=$10, essential=$7,
        source='confirmed', confidence='manual', notes=$11 where id=$1`,
      [existing.id, vendor, category, amt, freq, priority, critical, committed, dow, dom, notes])
    console.log(`  ~ updated ${vendor}`)
  } else {
    await sql.query(
      `insert into fin_obligations(vendor,category,amount_cents,avg_amount_cents,frequency,priority,critical,committed_on_issue,day_of_week,day_of_month,essential,status,source,confidence,entered_by,discovery_key,notes)
       values($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$6,'confirmed','confirmed','manual','owner',$10,$11)`,
      [vendor, category, amt, freq, priority, critical, committed, dow, dom, key, notes])
    console.log(`  + seeded ${vendor} (${priority})`)
  }
}

// Retire any earlier auto-discovered payroll/owner proposals that these confirmed rows supersede,
// so they aren't double-counted (mark ignored, keep for history).
const sup = await sql.query(`update fin_obligations set status='ignored'
  where status='proposed' and (category in ('payroll','owner_draw') or lower(vendor) ~ 'clearing|to checking|payroll')
  and (discovery_key is null or discovery_key not like 'seed:%') returning vendor`)
console.log(`  ignored ${sup.length} superseded proposals`)
console.log('Done.')
