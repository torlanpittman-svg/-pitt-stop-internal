/**
 * Record owner-authorized Extraco loan terms extracted (read-only) from Nancy Balke's July 2026
 * "Loan Activity" statements (Extraco Banks N.A.). Source=document, confidence=manual_verified,
 * as_of=2026-07-31 statement / balances as-of the stated payment dates. No money movement.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)

const SRC = { source: 'document', confidence: 'manual_verified', asOf: '2026-07-31' }
// name-match, principal_cents, apr_bps, payment_cents, freq, next_due, maturity, avail_credit_cents, collateral, kind, verified, notes
const LOANS = [
  {
    match: 'floor plan', principal: 9745000, apr: 825, payment: null, freq: 'monthly', nextDue: '2026-08-25', maturity: null, avail: null,
    collateral: 'Inventory — retail/services vehicles (code 408)', kind: 'floor_plan', verified: true,
    notes: 'Extraco Floor Plan acct #…3058. Commercial-Variable, orig 08/21/2020, APR 8.25%, per diem $22.33, accrued int $496.26 (as-of 08/25/2026). Interest-only + PRINCIPAL CURTAILMENTS as vehicles sell (paid via DDA transfers). AMBIGUOUS: statement "Payment Amount $98,035.59 / accrued interest only" looks like a PAYOFF figure, not a monthly payment — FLAG FOR REVIEW. This facility ENCUMBERS *5600 auto-sales cash.',
  },
  {
    match: 'f250', principal: 1166566, apr: 550, payment: 149873, freq: 'monthly', nextDue: '2026-08-22', maturity: '2027-03-22', avail: null,
    collateral: 'F250 light truck (equipment code 736)', kind: 'term_loan', verified: true,
    notes: 'Extraco F250 acct #…5782. Commercial-Fixed, orig 11/22/2022, term 52 mo, APR 5.50%. Scheduled payment $1,498.73/mo (incl accrued int ~$60) due 22nd. Balance $11,665.66 as-of 08/22/2026. Maturity approx (52 mo from origination) — verify exact.',
  },
  {
    match: 'extraco #1120', principal: 1522500, apr: 875, payment: 17200, freq: 'monthly', nextDue: '2026-09-15', maturity: '2027-04-15', avail: 3477500,
    collateral: 'Unsecured (code 102)', kind: 'loc', verified: true,
    notes: 'Extraco RLOC acct #…1120. Revolving LOC, Commercial-Variable, orig 04/15/2026, term 12 mo, APR 8.75%. Credit LIMIT $50,000; drawn $15,225.00; available ~$34,775 (as-of 09/15/2026). Interest-only (~$172/mo, varies with balance) due 15th. Unsecured.',
  },
]

for (const L of LOANS) {
  const row = (await sql.query(`select id, name from fin_debts where lower(name) like '%'||$1||'%' order by principal_cents desc nulls last limit 1`, [L.match]))[0]
  if (!row) { console.log(`  ! no fin_debts match for '${L.match}'`); continue }
  await sql.query(
    `update fin_debts set kind=$2, principal_cents=$3, apr_bps=$4, payment_cents=$5, payment_frequency=$6, next_due=$7,
      maturity=$8, available_credit_cents=$9, collateral=$10, source=$11, confidence=$12, as_of=$13, verified=$14, notes=$15, updated_at=now()
     where id=$1`,
    [row.id, L.kind, L.principal, L.apr, L.payment, L.freq, L.nextDue, L.maturity, L.avail, L.collateral, SRC.source, SRC.confidence, SRC.asOf, L.verified, L.notes])
  console.log(`  ✓ ${row.name} → verified (bal $${(L.principal/100).toLocaleString()}, APR ${L.apr/100}%${L.payment?`, pmt $${(L.payment/100).toFixed(2)}`:''}${L.avail?`, avail $${(L.avail/100).toLocaleString()}`:''})`)
  await sql.query(`insert into fin_events(actor,action,entity,entity_id,after,source) values('admin','debt_terms_verified','fin_debts',$1,$2,'document')`, [row.id, JSON.stringify({ match: L.match, principal: L.principal, apr_bps: L.apr, source: 'Extraco July 2026 Loan Activity statement' })])
}
console.log('Done. Floor-plan payoff amount + exact F250 maturity + DDA paying-account flagged for review.')
