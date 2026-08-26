/**
 * READ-ONLY investigation of expected inflows: QBO open invoices (A/R) + Sterling payment pattern +
 * PSOS active service orders (work-in-progress). No writes.
 *   npx tsx scripts/qbo-receivables.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
/* eslint-disable @typescript-eslint/no-explicit-any */
const d = (n: any) => `$${(parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`

async function main() {
  const { queryQBO } = await import('@/apps/quickbooks/client')

  console.log('==================== OPEN INVOICES (A/R, Balance > 0) ====================')
  const open = (await queryQBO<{ Invoice?: any[] }>("SELECT * FROM Invoice WHERE Balance > '0' ORDERBY TxnDate DESC MAXRESULTS 200")).Invoice ?? []
  let arTotal = 0
  const byCust: Record<string, { n: number; bal: number }> = {}
  for (const inv of open) {
    const cust = inv.CustomerRef?.name ?? '—'; const bal = parseFloat(inv.Balance) || 0; arTotal += bal
    byCust[cust] = byCust[cust] || { n: 0, bal: 0 }; byCust[cust].n++; byCust[cust].bal += bal
  }
  console.log(`  ${open.length} open invoices · A/R total ${d(arTotal)}`)
  console.log('  By customer:')
  for (const [c, v] of Object.entries(byCust).sort((a, b) => b[1].bal - a[1].bal))
    console.log(`    ${c.slice(0, 34).padEnd(35)} ${String(v.n).padStart(2)} inv  ${d(v.bal)}`)
  console.log('  Recent open invoices:')
  for (const inv of open.slice(0, 15))
    console.log(`    #${inv.DocNumber ?? '—'} ${inv.TxnDate} due ${inv.DueDate ?? '—'}  ${(inv.CustomerRef?.name ?? '').slice(0, 24).padEnd(25)} bal ${d(inv.Balance)} / total ${d(inv.TotalAmt)}`)

  console.log('\n==================== CUSTOMERS matching Sterling/dealer ====================')
  const custs = (await queryQBO<{ Customer?: any[] }>('SELECT * FROM Customer MAXRESULTS 500')).Customer ?? []
  const dealerish = custs.filter((c) => /sterling|dealer|motor|auto|automotive|nissan|ford|toyota|chevy|honda|kia|hyundai|gmc|buick|cadillac|lexus|bmw/i.test(c.DisplayName ?? ''))
  for (const c of dealerish.slice(0, 20)) console.log(`    ${c.DisplayName}  balance ${d(c.Balance)}  active=${c.Active}`)
  console.log(`  (${custs.length} customers total; ${dealerish.length} dealer-ish)`)

  // Sterling payment pattern: recent invoices + whether paid, to estimate lag.
  const sterling = custs.find((c) => /sterling/i.test(c.DisplayName ?? ''))
  if (sterling) {
    console.log(`\n==================== STERLING (${sterling.DisplayName}) recent invoices ====================`)
    const inv = (await queryQBO<{ Invoice?: any[] }>(`SELECT * FROM Invoice WHERE CustomerRef = '${sterling.Id}' ORDERBY TxnDate DESC MAXRESULTS 30`)).Invoice ?? []
    for (const i of inv.slice(0, 15)) {
      const dow = new Date(i.TxnDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
      console.log(`    #${i.DocNumber} ${i.TxnDate}(${dow}) due ${i.DueDate ?? '—'}  total ${d(i.TotalAmt)}  balance ${d(i.Balance)}  ${parseFloat(i.Balance) > 0 ? 'OPEN' : 'PAID'}`)
    }
    console.log(`  current Sterling A/R balance: ${d(sterling.Balance)}`)
  } else console.log('\n  (No "Sterling" customer found in QBO)')
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1) })
