import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  const { queryQBO } = await import('@/apps/quickbooks/client')
  const emps = (await queryQBO<{ Employee?: any[] }>('SELECT * FROM Employee MAXRESULTS 1000')).Employee ?? []
  console.log('EMPLOYEES (all):')
  for (const e of emps) console.log(`  ${e.Active ? '●' : '○'} ${e.DisplayName}  active=${e.Active}  hired=${e.HiredDate ?? '—'}`)

  const vend = (await queryQBO<{ Vendor?: any[] }>("SELECT * FROM Vendor WHERE DisplayName LIKE '%Pittman%' MAXRESULTS 100")).Vendor ?? []
  console.log('\nVENDORS ~Pittman:', vend.map((v) => v.DisplayName).join(', ') || '(none)')

  // Any transactions that look like payroll/wages/Darryl in the last 120 days across common types.
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const since = ymd(new Date(Date.now() - 120 * 86400_000))
  for (const ent of ['Purchase', 'Bill', 'JournalEntry', 'Deposit']) {
    const rows = (await queryQBO<any>(`SELECT * FROM ${ent} WHERE TxnDate >= '${since}' MAXRESULTS 500`).catch(() => ({})))[ent] ?? []
    const hits = rows.filter((t: any) => /payroll|paycheck|wage|salary|pittman|darryl|owner draw|distribution|gusto/i.test(JSON.stringify(t)))
    console.log(`\n${ent}: ${rows.length} rows, ${hits.length} payroll/owner-ish`)
    for (const t of hits.slice(0, 6)) console.log(`   ${t.TxnDate}  $${t.TotalAmt ?? t.Amount ?? '?'}  ${(t.PrivateNote || t.DocNumber || t.EntityRef?.name || '').slice(0, 50)}`)
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1) })
