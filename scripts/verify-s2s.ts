import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
async function main() {
  const { computeSafeToSpend, projectCashLow } = await import('@/apps/finance/safe-to-spend')
  const s2s = await computeSafeToSpend(21)
  console.log('SAFE-TO-SPEND:', JSON.stringify(s2s, null, 2))
  const p = await projectCashLow(21)
  console.log('\nPROJECTION:', JSON.stringify({ startCents: p.startCents, lowCents: p.lowCents, lowDate: p.lowDate, overdraftRisk: p.overdraftRisk, points: p.points.length }, null, 2))
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1) })
