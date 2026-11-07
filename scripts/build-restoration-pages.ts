/**
 * Build the five insurance-restoration WordPress landing pages into
 * website/wordpress/insurance-restoration/dist/ (preview HTML, WP body HTML, SEO sidecar JSON).
 * Local only — writes files, publishes nothing. Run: npx tsx scripts/build-restoration-pages.ts
 *
 * Images come ONLY from website/wordpress/insurance-restoration/assets.json (absent = no images render):
 *   { "illustration-vandalism": { "src": "<URL or local path>", "alt": "…", "provenance": "generated illustration" },
 *     "vandal-glass-cleanup":   { "src": "…", "provenance": "shop photo" },
 *     "<photo id>": "<URL>" }                                  // string shorthand = real shop photo
 * Generated illustrations always render with the visible caption "Illustrative image — not a completed
 * Pitt Stop job." and are rejected on real-photo slots (render.ts enforces both).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGES } from '../website/wordpress/insurance-restoration/pages'
import { previewHtml, wpBody, seoSidecar, type AssetManifest } from '../website/wordpress/insurance-restoration/render'

const root = join(process.cwd(), 'website/wordpress/insurance-restoration')
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })
const assetsPath = join(root, 'assets.json')
const assets: AssetManifest = existsSync(assetsPath) ? JSON.parse(readFileSync(assetsPath, 'utf8')) : {}

const index: string[] = []
for (const page of PAGES) {
  writeFileSync(join(dist, `${page.slug}.preview.html`), previewHtml(page, assets))
  writeFileSync(join(dist, `${page.slug}.wp.html`), wpBody(page, assets))
  writeFileSync(join(dist, `${page.slug}.json`), JSON.stringify(seoSidecar(page, assets), null, 2))
  const illus = page.illustrationId ? (assets[page.illustrationId] ? 'illustration supplied' : 'illustration pending') : 'hub (reuses service illustrations)'
  const optional = page.photos.filter((p) => !assets[p.id]).length
  index.push(`<li><a href="${page.slug}.preview.html">/${page.slug}/</a> — ${page.seoTitle} <small>(${illus}; ${optional} optional real photo${optional === 1 ? '' : 's'})</small></li>`)
  console.log(`built ${page.slug}: title ${page.seoTitle.length}ch, description ${page.metaDescription.length}ch, ${page.faqs.length} FAQs, ${illus}, ${optional} optional real photos`)
}
writeFileSync(join(dist, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Restoration landing page drafts</title>
<style>body{font:16px/1.5 Roboto,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#0b1f33;background:#fff}li{margin:8px 0}</style></head>
<body><h1>Insurance-restoration landing page drafts</h1><p>Previews for owner review. Nothing here is published. Built ${new Date().toISOString().slice(0, 10)}.</p><ul>${index.join('')}</ul></body></html>`)
console.log(`wrote ${PAGES.length} pages to ${dist}`)
