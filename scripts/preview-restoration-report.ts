/**
 * LOCAL-ONLY visual review of /marketing/restoration without any database: renders the pure
 * RestorationReportView with the SYNTHETIC fixtures (app/marketing/restoration/report-fixture.ts) to
 * website-independent HTML files. No auth, no DB, no network, no production secrets — safe to run from
 * the worktree even though the local env points read-only at production (the app itself is not started).
 *
 * Run: npx tsx scripts/preview-restoration-report.ts
 * Output: docs/insurance-restoration/evidence/restoration-report-{populated,unknowns}.html
 *
 * What this shows: the real report markup and copy (values, labels, caveats, "Unavailable"/"—" handling).
 * What it does NOT show: Tailwind styling (no CSS build here — a minimal stylesheet is inlined for
 * readability) or live data (that needs migration 0076 in the deployed app).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RestorationReportView } from '../app/marketing/restoration/ReportView'
import { FIXTURE_POPULATED, FIXTURE_UNKNOWNS } from '../app/marketing/restoration/report-fixture'

const CSS = `body{background:#0a0a0a;color:#e5e7eb;font:14px/1.5 system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px}
section{border:1px solid #333;border-radius:12px;padding:14px;margin:0 0 16px}h2{font-size:13px;text-transform:uppercase;color:#9ca3af}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #333;padding:4px 8px;text-align:left}a{color:#93c5fd}
.note{color:#b45309;border:1px dashed #b45309;border-radius:8px;padding:8px 12px;margin:0 0 16px;font-size:13px}`

const out = join(process.cwd(), 'docs/insurance-restoration/evidence')
mkdirSync(out, { recursive: true })
for (const [name, fixture] of [['populated', FIXTURE_POPULATED], ['unknowns', FIXTURE_UNKNOWNS]] as const) {
  const body = renderToStaticMarkup(createElement(RestorationReportView, { report: fixture }))
  writeFileSync(join(out, `restoration-report-${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Restoration report — SYNTHETIC ${name} fixture</title><style>${CSS}</style></head><body><p class="note">SYNTHETIC review fixture (“${name}”) — every number is invented; this file proves the report markup and honesty rules, not live data or production styling.</p>${body}</body></html>`)
  console.log(`wrote restoration-report-${name}.html`)
}
