/**
 * Local runner for the REAL transaction-ingestion module (proves live Plaid transaction access +
 * populates fin_transactions against the production DB). Read-only from Plaid; no money movement.
 *   npx tsx scripts/run-ingest.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}

async function main() {
  const { ingestTransactions, getClassificationSummary, getRecentTransactions } = await import('@/apps/finance/transactions')

  console.log('Ingesting transactions (read-only)…')
  const res = await ingestTransactions('local-verify')
  console.log('\nResult:', JSON.stringify(res, null, 2))

  const sum = await getClassificationSummary(180)
  console.log(`\nClassification (since ${sum.since}) — total ${sum.total}, pending ${sum.pending}:`)
  for (const r of sum.rows) console.log(`  ${r.txnClass.padEnd(14)} n=${String(r.n).padStart(4)}  out $${(r.outCents / 100).toLocaleString()}  in $${(r.inCents / 100).toLocaleString()}`)

  const recent = await getRecentTransactions(12)
  console.log('\nMost recent 12:')
  for (const t of recent) {
    const amt = `${t.direction === 'out' ? '-' : '+'}$${Math.abs(t.amountCents / 100).toLocaleString()}`
    console.log(`  ${t.txnDate} ${t.pending ? '⧗' : ' '} ${amt.padStart(12)}  [${t.txnClass}]  ${(t.merchantName || t.name || '').slice(0, 44)}`)
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
