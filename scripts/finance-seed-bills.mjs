/**
 * Seed newly-DISCOVERED recurring *2649 bills as confirmed obligations, using owner-confirmed
 * classifications + evidence from ≥3 occurrences in 90-day history. Idempotent by discovery_key.
 * Variable operating spend (parts/fuel/supplies) is NOT seeded as dated obligations — reported as a
 * budget separately. Ambiguous vendors (Intuit-mixed, Evolve, Thompson) left as flagged, not confirmed.
 * No money movement; no QBO writes.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)
const OP = (await sql.query(`select fa.id from fin_accounts fa join fin_plaid_accounts pa on pa.mapped_account_id=fa.id where pa.mask='2649'`))[0].id

// vendor, category, amount_cents(avg), min, max, dom, priority, confidence, notes
const BILLS = [
  ['City of College Station', 'utilities', 142230, 78980, 268182, 3,  'contractual', 'manual_verified', 'Owner-confirmed utilities (water/electric); usage-variable $790-$2,682; ×3 dom~3'],
  ['AT&T (work phones)',       'utilities', 44841,  44838, 44847,  9,  'contractual', 'manual_verified', 'Owner-confirmed work phones; fixed $448.41; ×3 dom~9'],
  ['Google Ads',              'advertising', 43859, 27632, 50000, 17, 'contractual', 'manual_verified', 'Owner-confirmed advertising; variable ~$276-$500; ×9'],
  ['Farmers Insurance',       'insurance',  20684,  20684, 20684,  17, 'contractual', 'strongly_inferred', 'Fixed $206.84 ×3 dom~17 — commercial insurance (verify policy)'],
  ['Progressive (insurance)', 'insurance',  3492,   3492,  3492,   24, 'contractual', 'strongly_inferred', 'Progressive County Mutual, fixed $34.92 ×3 dom~24 — auto/commercial insurance'],
  ['US Premium Finance (insurance)', 'insurance', 23876, 22195, 25557, 11, 'contractual', 'strongly_inferred', 'DRAFTS USPREMIUMFINANCE — financed insurance premium, ~$238/mo ×6 dom~11'],
  ['BCS Pure Water Systems',  'utilities',  34196,  27063, 55594,  18, 'contractual', 'strongly_inferred', 'Water delivery/supplies ~$342/mo ×4 dom~18'],
  ['Wirestar Network (internet)', 'utilities', 14414, 8648, 16338, 9, 'contractual', 'strongly_inferred', 'Internet/network ~$144/mo ×4 dom~9'],
  ['Mitchell Repair (software)', 'software', 19991, 17970, 21001, 17, 'contractual', 'strongly_inferred', 'Auto-repair data/software (ProDemand) ~$200/mo ×3 dom~17'],
  ['Autoleap (software)',     'software',   31814,  15854, 42454,  21, 'contractual', 'strongly_inferred', 'Shop-management SaaS ~$318 ×5 (reclassified from debt)'],
  ['Payme Lending',           'debt',       24400,  24400, 24400,  25, 'critical',    'strongly_inferred', 'Payme Lending Services financing, fixed $244 ×3 dom~25'],
  ['YouTube TV',              'subscription', 8984, 8984,  8984,   29, 'planned',     'strongly_inferred', 'Fixed $89.84/mo ×3 dom~29 (deferrable subscription)'],
  ['Amazon Prime + Prime Video', 'subscription', 2054, 540, 1514,  5,  'planned',     'strongly_inferred', 'Prime $5.40 + Prime Video $15.14/mo — deferrable subscriptions'],
]

for (const [vendor, category, amt, lo, hi, dom, priority, confidence, notes] of BILLS) {
  const key = `bill:${vendor}`
  const ex = (await sql.query(`select id, status from fin_obligations where discovery_key=$1`, [key]))[0]
  if (ex) { await sql.query(`update fin_obligations set vendor=$2,category=$3,amount_cents=$4,avg_amount_cents=$4,amount_min_cents=$5,amount_max_cents=$6,frequency='monthly',day_of_month=$7,priority=$8,critical=$9,essential=$9,payment_account_id=$10,source='discovery',confidence=$11,notes=$12 where id=$1`, [ex.id, vendor, category, amt, lo, hi, dom, priority, priority==='critical', OP, confidence, notes]); console.log(`  ~ ${vendor}`) }
  else { await sql.query(`insert into fin_obligations(vendor,category,amount_cents,avg_amount_cents,amount_min_cents,amount_max_cents,frequency,day_of_month,priority,critical,essential,payment_account_id,status,source,confidence,entered_by,discovery_key,notes) values($1,$2,$3,$3,$4,$5,'monthly',$6,$7,$8,$8,$9,'confirmed','discovery',$10,'audit',$11,$12)`, [vendor, category, amt, lo, hi, dom, priority, priority==='critical', OP, confidence, key, notes]); console.log(`  + ${vendor} (${category}, ${priority}, $${(amt/100).toFixed(2)}, dom${dom})`) }
}
// Retire earlier auto-proposals now superseded by these confirmed bills (keep for history).
const sup = await sql.query(`update fin_obligations set status='ignored' where status='proposed' and (lower(vendor) ~ 'city of college|google|autoleap|drafts|payme|wirestar|mitchell|bcs pure|at&t|farmers|prog ' ) returning vendor`)
console.log(`  ignored ${sup.length} superseded proposals`)
console.log('Done.')
