import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  const { qbApiRequest } = await import('@/apps/quickbooks/client')
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const now = new Date(); const start = new Date(now.getTime() - 91 * 86400_000)
  const pl = await qbApiRequest<any>({ path: '/reports/ProfitAndLoss', query: { start_date: ymd(start), end_date: ymd(now) } })
  console.log(`P&L ${ymd(start)} … ${ymd(now)}\n`)
  const walk = (rows: any[], depth = 0) => {
    for (const r of rows ?? []) {
      const cd = r.ColData
      if (cd && cd[0]?.value) console.log(`  ${'  '.repeat(depth)}${cd[0].value.padEnd(40 - depth * 2)} ${(cd[cd.length - 1]?.value ?? '').padStart(14)}`)
      if (r.Header?.ColData?.[0]?.value) console.log(`  ${'  '.repeat(depth)}${r.Header.ColData[0].value}`)
      if (r.Rows?.Row) walk(r.Rows.Row, depth + 1)
      if (r.Summary?.ColData?.[0]?.value) console.log(`  ${'  '.repeat(depth)}${(r.Summary.ColData[0].value).padEnd(40 - depth * 2)} ${(r.Summary.ColData[r.Summary.ColData.length - 1]?.value ?? '').padStart(14)}`)
    }
  }
  walk(pl?.Rows?.Row ?? [])
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1) })
