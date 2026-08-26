/**
 * Lock owner-confirmed CFO decisions (2026-08-26). Idempotent. No QBO writes; no money movement.
 *   - Amex ····5008 → verified-map to QBO "6-31007" (qbo:138). Liability, not cash.
 *   - AMB ····4183 → entity_note 'holding company' (confirmed), stays ignored/excluded.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)
const one = async (q, p = []) => (await sql.query(q, p))[0] ?? null

// Amex verified mapping
const pa = await one(`select * from fin_plaid_accounts where mask='5008'`)
const fa = await one(`select id, name from fin_accounts where external_source='qbo' and external_id='138'`)
if (pa && fa) {
  const already = pa.mapping_verified && pa.mapped_account_id === fa.id
  await sql.query(`update fin_plaid_accounts set mapped_account_id=$2, mapping_verified=true, status='active', updated_at=now() where id=$1`, [pa.id, fa.id])
  await sql.query(`update fin_accounts set institution='American Express', updated_at=now() where id=$1`, [fa.id])
  if (!already && pa.current_balance_cents != null) {
    await sql.query(`insert into fin_balance_snapshots(account_id,balance_cents,available_cents,as_of,source,confidence,raw) values($1,$2,$3,$4,'plaid','live',$5)`,
      [fa.id, pa.current_balance_cents, pa.available_balance_cents, pa.balance_as_of ?? new Date().toISOString(), JSON.stringify({ plaidAccountId: pa.plaid_account_id, mask: pa.mask, note: 'credit-card liability; available credit is NOT cash' })])
    await sql.query(`insert into fin_events(actor,action,entity,entity_id,after,source) values('admin','plaid_mapping_verified','fin_accounts',$1,$2,'plaid')`, [fa.id, JSON.stringify({ plaidAccountId: pa.plaid_account_id, mask: pa.mask, account: fa.name })])
  }
  console.log(`✓ Amex ····5008 → ${fa.name} (verified, liability)`)
} else console.log('! Amex mapping sides missing')

// Holding-company confirmation
await sql.query(`update fin_plaid_accounts set entity_note='holding company', status='ignored', updated_at=now() where mask='4183'`)
await sql.query(`insert into fin_events(actor,action,entity,entity_id,after,source) values('admin','entity_confirmed','fin_plaid_accounts',(select plaid_account_id from fin_plaid_accounts where mask='4183'),$1,'manual')`, [JSON.stringify({ entity: 'holding company', excluded: true })])
console.log('✓ AMB ····4183 → holding company (confirmed, excluded)')
