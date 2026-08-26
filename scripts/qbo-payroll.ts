/**
 * READ-ONLY QuickBooks payroll investigation. Uses the existing QBO accounting client to establish
 * the authoritative weekly payroll cash requirement (employees, payroll expense/liability accounts,
 * P&L payroll lines summarized by week). No QBO writes; no money movement.
 *   npx tsx scripts/qbo-payroll.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  const { queryQBO, qbApiRequest } = await import('@/apps/quickbooks/client')
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const now = new Date(); const start = new Date(now.getTime() - 91 * 86400_000)

  console.log('==================== EMPLOYEES ====================')
  const emp = await queryQBO<{ Employee?: any[] }>('SELECT * FROM Employee MAXRESULTS 500')
  const emps = emp.Employee ?? []
  for (const e of emps) console.log(`  ${e.Active ? '●' : '○'} ${e.DisplayName}  ${e.PrimaryEmailAddr?.Address ?? ''}  ${e.EmployeeType ?? ''}  hired ${e.HiredDate ?? '—'}${e.ReleasedDate ? ' released ' + e.ReleasedDate : ''}`)
  console.log(`  active: ${emps.filter((e) => e.Active).length} / total ${emps.length}`)

  console.log('\n==================== PAYROLL-RELATED ACCOUNTS ====================')
  const acc = await queryQBO<{ Account?: any[] }>('SELECT * FROM Account MAXRESULTS 1000')
  const payAcc = (acc.Account ?? []).filter((a) => /payroll|wage|salary|gusto|officer|employee|941|940|futa|suta|withhold|garnish/i.test(`${a.Name} ${a.AccountSubType}`))
  for (const a of payAcc) console.log(`  [${a.AccountType}/${a.AccountSubType}] ${a.Name}  bal ${a.CurrentBalance}`)
  if (!payAcc.length) console.log('  (none matched by name — payroll may post to generic expense/liability)')

  // Helper: recursively walk a P&L/report, collecting [label, lastColValue].
  const rowsMatching = (rep: any, re: RegExp): { label: string; cols: string[] }[] => {
    const out: { label: string; cols: string[] }[] = []
    const walk = (rows: any[]) => {
      for (const r of rows ?? []) {
        const head = r.Header?.ColData?.[0]?.value
        const cd = r.ColData
        if (cd && cd[0]?.value && re.test(cd[0].value)) out.push({ label: cd[0].value, cols: cd.slice(1).map((c: any) => c.value ?? '') })
        if (head && re.test(head) && r.Summary?.ColData) out.push({ label: head + ' (total)', cols: r.Summary.ColData.slice(1).map((c: any) => c.value ?? '') })
        if (r.Rows?.Row) walk(r.Rows.Row)
      }
    }
    walk(rep?.Rows?.Row ?? [])
    return out
  }

  console.log('\n==================== P&L PAYROLL LINES (last ~13 weeks, total) ====================')
  const pl = await qbApiRequest<any>({ path: '/reports/ProfitAndLoss', query: { start_date: ymd(start), end_date: ymd(now) } }).catch((e) => ({ __err: String(e) }))
  if (pl.__err) console.log('  P&L error:', pl.__err)
  else for (const r of rowsMatching(pl, /payroll|wage|salary|tax|officer|contract labor|employee/i)) console.log(`  ${r.label.padEnd(38)} ${r.cols.join(' | ')}`)

  console.log('\n==================== P&L PAYROLL BY WEEK (summarize_column_by=Weeks) ====================')
  const plW = await qbApiRequest<any>({ path: '/reports/ProfitAndLoss', query: { start_date: ymd(start), end_date: ymd(now), summarize_column_by: 'Weeks' } }).catch((e) => ({ __err: String(e) }))
  if (plW.__err) console.log('  error:', plW.__err)
  else {
    const cols = (plW.Columns?.Column ?? []).map((c: any) => (c.ColTitle || '').slice(0, 10))
    console.log('  weeks:', cols.filter(Boolean).join('  '))
    for (const r of rowsMatching(plW, /^total payroll|payroll expenses|wages|taxes/i)) console.log(`  ${r.label.slice(0, 22).padEnd(23)} ${r.cols.map((c) => (c || '·').padStart(9)).join('')}`)
  }

  console.log('\n==================== PAYROLL TRANSACTIONS hitting operating bank ====================')
  for (const ent of ['Purchase', 'JournalEntry']) {
    const q = await queryQBO<any>(`SELECT * FROM ${ent} WHERE TxnDate >= '${ymd(start)}' MAXRESULTS 200`).catch((e) => ({ __err: String(e) }))
    if (q.__err) { console.log(`  ${ent}: ${q.__err}`); continue }
    const list = q[ent] ?? []
    const pr = list.filter((t: any) => JSON.stringify(t).match(/payroll|paycheck|wage|salary|gusto|941|940/i))
    console.log(`  ${ent}: ${list.length} in window, ${pr.length} payroll-ish`)
    for (const t of pr.slice(0, 8)) console.log(`    ${t.TxnDate}  $${t.TotalAmt ?? '?'}  ${(t.PrivateNote || t.DocNumber || '').slice(0, 40)}`)
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1) })
