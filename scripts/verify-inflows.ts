import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const d = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
async function main() {
  const { deriveExpectedInflows, getExpectedInflows, getPipelineContext } = await import('@/apps/finance/expected-inflows')
  const { forecastWithInflows } = await import('@/apps/finance/safe-to-spend')
  const der = await deriveExpectedInflows('verify', 21)
  console.log('DERIVED:', { dealerWeekly: d(der.dealerWeeklyCents), cardDaily: d(der.cardDailyCents), rows: der.rows })
  const ctx = await getPipelineContext()
  console.log('PIPELINE:', ctx)
  const inflows = await getExpectedInflows(21)
  const byConf: Record<string, number> = {}
  for (const i of inflows) byConf[i.confidence] = (byConf[i.confidence] ?? 0) + i.amountCents
  console.log('EXPECTED INFLOWS (21d):', inflows.length, 'rows; by confidence:', Object.fromEntries(Object.entries(byConf).map(([k, v]) => [k, d(v)])))
  const f = await forecastWithInflows(21)
  console.log('\nFORECAST start', d(f.startCents), '| critical-out', d(-f.criticalBeforeInflowCents), '| high-in', d(f.expectedHighCents), '| probable-in', d(f.expectedProbableCents))
  for (const s of f.scenarios) console.log(`  ${s.scenario.padEnd(16)} low ${d(s.lowCents).padStart(12)} on ${s.lowDate} · overdraft ${s.overdraftRisk} · firstPayroll ${s.firstPayrollDate} covered=${s.firstPayrollCovered} bal ${d(s.firstPayrollBalance)} · ending ${d(s.endingCents)}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1) })
