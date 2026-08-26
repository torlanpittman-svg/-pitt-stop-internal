/**
 * READ-ONLY finance audit. Dumps the live fin_* state (Plaid items/accounts, fin_accounts,
 * latest balance snapshots) so we can build an account map. No writes. Masks nothing that
 * isn't already a mask; prints no access tokens (they're encrypted and never selected).
 *
 *   node scripts/finance-audit.mjs
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
function loadEnvLocal() {
  try {
    for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!process.env[m[1]]) process.env[m[1]] = v
    }
  } catch {}
}
loadEnvLocal()
const sql = neon(process.env.DATABASE_URL)
const c = (n) => (n == null ? '—' : `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)

const tableExists = async (name) => {
  const r = await sql.query(`select to_regclass($1) as t`, [name])
  return r[0].t != null
}

console.log('\n==================== PLAID ITEMS ====================')
if (await tableExists('fin_plaid_items')) {
  const items = await sql.query(`select id, item_id, institution_name, institution_id, environment, status, last_error, connected_by, created_at, updated_at from fin_plaid_items order by created_at`)
  for (const it of items) {
    console.log(`\n• Item ${it.id}`)
    console.log(`    institution   : ${it.institution_name} (${it.institution_id})`)
    console.log(`    plaid item_id : ${it.item_id}`)
    console.log(`    environment   : ${it.environment}    status: ${it.status}${it.last_error ? '  lastError: ' + it.last_error : ''}`)
    console.log(`    connected_by  : ${it.connected_by}`)
    console.log(`    created/updated: ${it.created_at} / ${it.updated_at}`)
  }
  if (!items.length) console.log('  (none)')
} else console.log('  fin_plaid_items table does not exist yet')

console.log('\n\n==================== PLAID ACCOUNTS ====================')
if (await tableExists('fin_plaid_accounts')) {
  // Select every column so we see any status/ignore fields if they exist.
  const cols = (await sql.query(`select column_name from information_schema.columns where table_name='fin_plaid_accounts' order by ordinal_position`)).map(r => r.column_name)
  console.log(`  columns: ${cols.join(', ')}\n`)
  const pa = await sql.query(`select * from fin_plaid_accounts order by mask`)
  for (const a of pa) {
    console.log(`• ${a.name}${a.official_name && a.official_name !== a.name ? ' / ' + a.official_name : ''}  ····${a.mask}`)
    console.log(`    plaidAccountId: ${a.plaid_account_id}`)
    console.log(`    type/subtype  : ${a.type} / ${a.subtype}`)
    console.log(`    current       : ${c(a.current_balance_cents)}    available: ${c(a.available_balance_cents)}    ${a.currency ?? ''}`)
    console.log(`    balanceAsOf   : ${a.balance_as_of}`)
    console.log(`    mappedAccount : ${a.mapped_account_id ?? '—'}    mappingVerified: ${a.mapping_verified}`)
    if ('status' in a) console.log(`    status        : ${a.status}`)
    console.log('')
  }
  if (!pa.length) console.log('  (none)')
} else console.log('  fin_plaid_accounts table does not exist yet')

console.log('\n==================== FIN ACCOUNTS ====================')
if (await tableExists('fin_accounts')) {
  const cols = (await sql.query(`select column_name from information_schema.columns where table_name='fin_accounts' order by ordinal_position`)).map(r => r.column_name)
  console.log(`  columns: ${cols.join(', ')}\n`)
  const fa = await sql.query(`select * from fin_accounts order by kind, name`)
  for (const a of fa) {
    console.log(`• ${a.name}  [${a.kind}/${a.classification}]  inst=${a.institution ?? '—'}  ext=${a.external_source}:${a.external_id ?? '—'}`)
    console.log(`    isCash=${a.is_cash} isLiability=${a.is_liability} clearingSuspect=${a.clearing_suspect} active=${a.active}${'status' in a ? ' status=' + a.status : ''}`)
    const snap = await sql.query(`select balance_cents, available_cents, as_of, source, confidence from fin_balance_snapshots where account_id=$1 order by as_of desc limit 1`, [a.id])
    if (snap[0]) console.log(`    latest balance: ${c(snap[0].balance_cents)} (avail ${c(snap[0].available_cents)})  ${snap[0].source}/${snap[0].confidence}  asOf ${snap[0].as_of}`)
    else console.log(`    latest balance: (no snapshot)`)
    console.log(`    id=${a.id}`)
    console.log('')
  }
  if (!fa.length) console.log('  (none)')
} else console.log('  fin_accounts table does not exist yet')

console.log('\n==================== SNAPSHOT COUNTS ====================')
if (await tableExists('fin_balance_snapshots')) {
  const rows = await sql.query(`select confidence, count(*)::int n from fin_balance_snapshots group by confidence order by confidence`)
  for (const r of rows) console.log(`  ${r.confidence}: ${r.n}`)
}
console.log('')
