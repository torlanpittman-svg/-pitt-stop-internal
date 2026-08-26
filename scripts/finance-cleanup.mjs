/**
 * CFO Phase 2 — one-time account cleanup + verified mappings. Idempotent.
 *   - AMB ····0169 (personal) and ····4183 ($0 extra business) → status 'ignored' (kept upstream,
 *     excluded from every CFO calc/view). 0169 entity_note 'personal'.
 *   - QBO Savings *3241 → status 'closed' (no longer exists; history preserved, not cash).
 *   - Verify-map Plaid ····2649 → fin_account *2649 (operating) and ····5600 → *5600 (auto sales):
 *     set mapped_account_id + mapping_verified, write ONE 'live' balance snapshot, set institution.
 * Amex ····5008 is intentionally left UNVERIFIED (mask 5008 vs QBO "6-31007" — needs owner confirm).
 * No QuickBooks writes. No money movement.
 *
 *   node scripts/finance-cleanup.mjs
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}
const sql = neon(process.env.DATABASE_URL)
const one = async (q, p = []) => (await sql.query(q, p))[0] ?? null

async function ignore(mask, note) {
  const pa = await one(`select id, plaid_account_id, status from fin_plaid_accounts where mask=$1`, [mask])
  if (!pa) return console.log(`  ! plaid ····${mask} not found`)
  await sql.query(`update fin_plaid_accounts set status='ignored', entity_note=coalesce($2,entity_note), updated_at=now() where id=$1`, [pa.id, note])
  await sql.query(`insert into fin_events(actor,action,entity,entity_id,after,source) values('admin','plaid_account_status','fin_plaid_accounts',$1,$2,'manual')`, [pa.plaid_account_id, JSON.stringify({ status: 'ignored', entityNote: note })])
  console.log(`  ✓ ····${mask} → ignored${note ? ' ('+note+')' : ''}`)
}

async function closeAccount(externalId) {
  const fa = await one(`select id, name, status from fin_accounts where external_source='qbo' and external_id=$1`, [externalId])
  if (!fa) return console.log(`  ! fin_account qbo:${externalId} not found`)
  await sql.query(`update fin_accounts set status='closed', active=false, updated_at=now() where id=$1`, [fa.id])
  await sql.query(`insert into fin_events(actor,action,entity,entity_id,after,source) values('admin','account_status','fin_accounts',$1,$2,'manual')`, [fa.id, JSON.stringify({ status: 'closed' })])
  console.log(`  ✓ ${fa.name} → closed`)
}

async function verifyMap(mask, externalId, institution) {
  const pa = await one(`select * from fin_plaid_accounts where mask=$1`, [mask])
  const fa = await one(`select id, name from fin_accounts where external_source='qbo' and external_id=$1`, [externalId])
  if (!pa || !fa) return console.log(`  ! map ····${mask}→qbo:${externalId} — missing side`)
  const already = pa.mapping_verified && pa.mapped_account_id === fa.id
  await sql.query(`update fin_plaid_accounts set mapped_account_id=$2, mapping_verified=true, status='active', updated_at=now() where id=$1`, [pa.id, fa.id])
  await sql.query(`update fin_accounts set institution=$2, updated_at=now() where id=$1`, [fa.id, institution])
  if (!already && pa.current_balance_cents != null) {
    await sql.query(
      `insert into fin_balance_snapshots(account_id,balance_cents,available_cents,as_of,source,confidence,raw)
       values($1,$2,$3,$4,'plaid','live',$5)`,
      [fa.id, pa.current_balance_cents, pa.available_balance_cents, pa.balance_as_of ?? new Date().toISOString(), JSON.stringify({ plaidAccountId: pa.plaid_account_id, mask: pa.mask })],
    )
    await sql.query(`insert into fin_events(actor,action,entity,entity_id,after,source) values('admin','plaid_mapping_verified','fin_accounts',$1,$2,'plaid')`, [fa.id, JSON.stringify({ plaidAccountId: pa.plaid_account_id, mask: pa.mask, account: fa.name })])
    console.log(`  ✓ ····${mask} → ${fa.name}  (verified + live snapshot ${pa.current_balance_cents/100})`)
  } else {
    console.log(`  ✓ ····${mask} → ${fa.name}  (already verified; institution set)`)
  }
}

console.log('AMB extra accounts → ignored:')
await ignore('0169', 'personal')
await ignore('4183', null) // entity unconfirmed — flagged for owner

console.log('\nObsolete account → closed:')
await closeAccount('132') // Savings *3241

console.log('\nVerified live mappings:')
await verifyMap('2649', '31', 'American Momentum Bank') // operating (Safe-to-Spend foundation)
await verifyMap('5600', '48', 'Extraco Banks')          // auto sales (kept separate)

console.log('\nDone. Amex ····5008 left UNVERIFIED (owner to confirm QBO “6-31007”).')
