/**
 * Build a LOCAL preview of the BANK SPECIMEN page for layout review — no database, no QuickBooks, no
 * print queue, and NO real bank data: it uses made-up numbers (a public test routing number and a
 * placeholder account) through the same code path the real specimen uses.
 *
 *   npx tsx scripts/check-specimen-preview.ts <output-dir>
 *
 * Writes specimen-preview.pdf and specimen-preview-gauge.pdf (same page + MICR position gauge).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Placeholders ONLY — set before the modules read them. Never put real numbers here.
process.env.MICR_ROUTING = '021000021'
process.env.MICR_ACCOUNT = '0001234567'

async function main() {
  const { DEFAULT_LAYOUT, PAGE_WIDTH_IN, PAGE_HEIGHT_IN } = await import('@/apps/checks/layout')
  const { buildFields, specimenValues } = await import('@/apps/checks/render')
  const { assembleCheckTemplate, resolveSpecimenMicr } = await import('@/apps/checks/template-server')
  const { renderCheckPdf } = await import('@/apps/checks/pdf')
  const out = process.argv[2]
  if (!out) { console.error('usage: tsx scripts/check-specimen-preview.ts <output-dir>'); process.exit(1) }
  const layout = DEFAULT_LAYOUT
  const cfg = {
    enabled: true, liveEnabled: false, qboRealmId: '', templateMode: 'blank_full' as const, micrEnabled: false,
    banks: { operating: { key: 'operating' as const, qboAccountId: '', label: '' }, auto_sales: { key: 'auto_sales' as const, qboAccountId: '', label: '' } },
    categoryAccounts: {}, layout,
    display: { companyName: 'Pitt Stop Detail & Auto Sales', companyAddr: null, companyPhone: null, bankName: 'American Momentum Bank', bankAddr: null },
  }
  const template = resolveSpecimenMicr(assembleCheckTemplate(cfg, layout, { test: false, specimen: true }))
  if (template?.micr?.mode !== 'e13b') { console.error('E-13B font not available (run from the repo root).'); process.exit(1) }
  const payload = { pageWidthIn: PAGE_WIDTH_IN, pageHeightIn: PAGE_HEIGHT_IN, fields: buildFields(specimenValues(), layout), template }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'specimen-preview.pdf'), renderCheckPdf(payload))
  writeFileSync(join(out, 'specimen-preview-gauge.pdf'), renderCheckPdf(payload, { micrGauge: { bottomYIn: layout.sectionHeightIn } }))
  console.log(`wrote ${join(out, 'specimen-preview.pdf')} and specimen-preview-gauge.pdf (placeholder numbers only)`)
}
main()
