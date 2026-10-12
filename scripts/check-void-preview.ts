/**
 * Build a LOCAL, NON-NEGOTIABLE VOID check PDF for layout review — no database, no QuickBooks, no print
 * queue, no bank data. Uses the default (approved) check geometry and the bundled E-13B font with the
 * all-zero test MICR line (apps/checks/micr.ts testMicrCells).
 *
 *   npx tsx scripts/check-void-preview.ts <output-dir>
 *
 * Writes void-check.pdf (what would print) and void-check-gauge.pdf (same page + MICR position gauge).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LAYOUT, PAGE_WIDTH_IN, PAGE_HEIGHT_IN } from '@/apps/checks/layout'
import { buildFields, testValues, type CheckPrintPayload } from '@/apps/checks/render'
import { buildCheckTemplate } from '@/apps/checks/template'
import { testMicrCells } from '@/apps/checks/micr'
import { micrFontAvailable } from '@/apps/checks/micr-font'
import { renderCheckPdf } from '@/apps/checks/pdf'

const out = process.argv[2]
if (!out) { console.error('usage: tsx scripts/check-void-preview.ts <output-dir>'); process.exit(1) }
if (!micrFontAvailable()) { console.error('E-13B font not available (run from the repo root).'); process.exit(1) }

const layout = DEFAULT_LAYOUT
const display = { companyName: 'Pitt Stop Detail & Auto Sales', companyAddr: null, bankName: 'American Momentum Bank', bankAddr: null }
const template = buildCheckTemplate(display, layout, { text: 'NON-NEGOTIABLE TEST', mode: 'e13b', cells: testMicrCells() })
const watermark = 'VOID - TEST - NOT NEGOTIABLE'
const payload: CheckPrintPayload = { pageWidthIn: PAGE_WIDTH_IN, pageHeightIn: PAGE_HEIGHT_IN, fields: buildFields(testValues(), layout), template, watermark }

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'void-check.pdf'), renderCheckPdf(payload, { watermark }))
writeFileSync(join(out, 'void-check-gauge.pdf'), renderCheckPdf(payload, { watermark, micrGauge: { bottomYIn: layout.sectionHeightIn } }))
console.log(`wrote ${join(out, 'void-check.pdf')} and void-check-gauge.pdf`)
