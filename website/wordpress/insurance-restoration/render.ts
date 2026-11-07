/**
 * Renders a LandingPage (pages.ts) into:
 *   - wpBody(page, assets) — the COMPLETE body for a WordPress Custom HTML block: content, scoped styles
 *                        (every rule under `.ps-restore`, so nothing leaks into Avada and nothing depends
 *                        on theme classes), JSON-LD, and the attribution pass-through / theme-booking-link
 *                        script (ampersand-free: WordPress entity-encodes `&` inside script text). Images render
 *                        ONLY for assets really supplied in the manifest; generated illustrations always
 *                        carry the visible "Illustrative image — not a completed Pitt Stop job." caption;
 *   - previewHtml(page, assets) — a standalone page for owner review (adds preview chrome + labelled
 *                        optional-photo placeholders around the exact production body);
 *   - faqJsonLd(page) / serviceJsonLd(page) — structured data;
 *   - seoSidecar(page, assets) — title / description / slug / canonical / schema / publish steps.
 * Pure functions, no I/O (the build script writes files; pages.test.ts asserts on the output).
 */
import { PAGES, SHOP, SITE, BOOK_HOST, CAMPAIGN, ILLUSTRATIONS, pageBySlug, type LandingPage, type Section } from './pages'
import { QUOTE_SERVICES } from '@/apps/marketing/quote-shared'
import { ATTRIBUTION_KEYS } from '@/apps/appointments/attribution'

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const pageUrl = (slug: string): string => `${SITE}/${slug}/`

// ── Asset manifest (assets.json) ──────────────────────────────────────────────────────────────────────
// Maps an asset id (ILLUSTRATIONS key or a page `photos` id) to its published file. Two shapes:
//   "<id>": "https://…/x.jpg"                                  — legacy shorthand: a REAL shop photo
//   "<id>": { src, alt?, caption?, provenance }                — explicit, provenance required
// Generated illustrations (owner-approved 2026-11-07) are allowed ONLY on illustration slots, always
// render the visible provenance caption, and may never claim before/after or completed-job results.
// Nothing renders for an id that is absent from the manifest — no URL is ever invented here.
export const GENERATED_PROVENANCE = 'generated illustration'
export const SHOP_PHOTO_PROVENANCE = 'shop photo'
export const ILLUSTRATION_NOTICE = 'Illustrative image — not a completed Pitt Stop job.'
export interface AssetEntry { src: string; alt?: string; caption?: string; provenance: typeof GENERATED_PROVENANCE | typeof SHOP_PHOTO_PROVENANCE }
export type AssetManifest = Record<string, string | AssetEntry>

/** Claims a generated image must never make (checked against its caption + alt). */
const GENERATED_FORBIDDEN = /before (and|&|\/) ?after|completed (job|work)|real (job|vehicle|customer)|our customer|finished result/i

function assetEntry(assets: AssetManifest, id: string): AssetEntry | null {
  const raw = assets[id]
  if (!raw) return null
  const entry: AssetEntry = typeof raw === 'string' ? { src: raw, provenance: SHOP_PHOTO_PROVENANCE } : raw
  if (!entry.src) return null
  if (entry.provenance !== GENERATED_PROVENANCE && entry.provenance !== SHOP_PHOTO_PROVENANCE) {
    throw new Error(`asset ${id}: provenance must be "${GENERATED_PROVENANCE}" or "${SHOP_PHOTO_PROVENANCE}"`)
  }
  // https URL or a plain local/site path — never javascript:, data:, protocol-relative or traversal.
  const ok = /^https:\/\/[\w.-]+\/[\w%@&=?./-]*$/.test(entry.src) || (/^[\w%@./-]+$/.test(entry.src) && !entry.src.includes('..') && !entry.src.startsWith('//'))
  if (!ok) throw new Error(`asset ${id}: src must be an https URL or a local relative path (got ${entry.src})`)
  return entry
}

/** A generated illustration's figure. Returns '' until the asset is actually supplied. */
export function illustrationFigure(illustrationId: string | null, assets: AssetManifest, compact = false): string {
  if (!illustrationId) return ''
  const meta = ILLUSTRATIONS[illustrationId]
  if (!meta) throw new Error(`unknown illustration id: ${illustrationId}`)
  const a = assetEntry(assets, illustrationId)
  if (!a) return ''
  const caption = a.caption ?? meta.caption
  if (a.provenance === GENERATED_PROVENANCE && GENERATED_FORBIDDEN.test(`${caption} ${a.alt ?? ''}`)) {
    throw new Error(`illustration ${illustrationId}: a generated image may not claim real-job results ("${caption}")`)
  }
  const note = a.provenance === GENERATED_PROVENANCE ? ` <span class="illus-note">${esc(ILLUSTRATION_NOTICE)}</span>` : ''
  const cap = compact && a.provenance === GENERATED_PROVENANCE ? `<figcaption><span class="illus-note">${esc(ILLUSTRATION_NOTICE)}</span></figcaption>` : `<figcaption>${esc(caption)}${note}</figcaption>`
  return `<figure class="${compact ? 'card-fig' : 'lead-fig'}"><img src="${esc(a.src)}" alt="${esc(a.alt ?? caption)}" loading="lazy">${cap}</figure>`
}

// ── Attribution pass-through + theme booking retarget (review fix 2026-11-07, live fixes 2026-11-07) ──
// The landing pages are static WordPress HTML, but their visitors can arrive from a Google Ads click
// carrying gclid / utm_*. The CTAs ship with organic defaults (utm_source=website); without forwarding,
// a paid click that navigates hub → service page → /quote would be relabelled as plain website traffic.
// This script forwards ONLY the allow-listed click keys (ATTRIBUTION_KEYS minus `lp` — each link keeps its
// OWN page slug and service) from location.search onto (a) estimate CTAs on the booking host and (b) links
// to the other restoration landing pages, so the chain survives cross-page navigation. No cookies, no
// storage, no third-party transmission — it only edits the query string of links that already point at the
// shop's own funnel/pages, with the same character filter cleanAttribution() applies server-side.
//
// Two constraints found on the LIVE pages after publication:
//   1. WordPress entity-encodes literal ampersands inside script text (`&&` became `&#038;&#038;`), a
//      SyntaxError that killed the whole script. The emitted script therefore contains NO literal `&`:
//      boolean `&&` is written as nested ifs, and `&` inside embedded string literals is emitted as the
//      JS unicode escape (backslash-u0026, see js()). attributionScript() throws at build time if one
//      sneaks back in.
//   2. The Avada theme injects its own booking links OUTSIDE `.ps-restore` (a fixed mobile bar + header
//      buttons, all marked data-ps-book and pointing at the generic BOOK_HOST/book page). On these five
//      pages those anchors are retargeted at the page's own quote CTA (the hub at its #types chooser) and
//      relabelled, keeping the theme's bar and styling. Only data-ps-book anchors whose href is
//      BOOK_HOST/book are touched — tel:, external and unrelated links never are — and a MutationObserver
//      corrects theme markup inserted after this script runs.
export const FORWARDED_ATTRIBUTION_KEYS = ATTRIBUTION_KEYS.filter((k) => k !== 'lp')

/** JS literal for the inline script: like JSON.stringify, but every `&` becomes the unicode escape
 *  (backslash-u0026) so the emitted script text never contains a literal ampersand for WordPress to
 *  entity-encode. */
const js = (v: unknown): string => JSON.stringify(v).replace(/&/g, '\\u0026')

/** What the theme's data-ps-book booking anchors should become on this page. */
export function themeBookTarget(page: LandingPage): { quote?: string; slug?: string; anchor?: string; label: string } {
  return page.service
    ? { quote: ctaUrl(page, 'theme'), slug: page.slug, label: 'Request Estimate' }
    : { anchor: '#types', label: 'Choose Damage Type' }
}

export function attributionScript(page?: LandingPage): string {
  const keys = js(FORWARDED_ATTRIBUTION_KEYS)
  const landing = js(Object.fromEntries(PAGES.map((p) => [p.slug, 1])))
  const book = page ? js(themeBookTarget(page)) : 'null'
  const script = `<script>
/* Pitt Stop attribution pass-through: forwards allow-listed ad-click parameters (gclid, utm_*, fbclid,
   ps_cid, ref) from this page's URL onto the estimate CTAs and the other restoration landing pages, so a
   paid visit is not relabelled as organic website traffic; also points the theme's own booking buttons
   (data-ps-book, injected outside .ps-restore) at this page's quote funnel. No cookies/storage, no third
   parties; it only rewrites links that already point at the shop's own funnel or landing pages.
   This script must contain no literal ampersand: WordPress rewrites it to an HTML entity inside script
   text, which is a SyntaxError. Boolean logic is nested ifs; embedded strings use the unicode escape. */
function psRestoreClean(v){return String(v).replace(/[^\\w.\\-:/@ +%]/g,'').slice(0,120)}
function psRestoreRewrite(href,incoming){
  'use strict';
  var u;try{u=new URL(href,${js(SITE + '/')})}catch(e){return null}
  if(u.protocol!=='https:')return null;
  var KEYS=${keys},LANDING=${landing},changed=false,i,k;
  var ok=false;
  if(u.origin===${js(BOOK_HOST)}){if(u.pathname==='/quote')ok=true}
  if(!ok){if(u.origin===${js(SITE)}){var m=u.pathname.match(/^\\/([a-z0-9-]+)\\/?$/);if(m){if(LANDING[m[1]]===1)ok=true}}}
  if(!ok)return null;
  for(i=0;i<KEYS.length;i++){k=KEYS[i];if(Object.prototype.hasOwnProperty.call(incoming,k)){if(incoming[k]){u.searchParams.set(k,incoming[k]);changed=true}}}
  return changed?u.toString():null
}
(function(){
  if(typeof document==='undefined'||typeof window==='undefined')return;
  var KEYS=${keys},BOOK=${book},INC=null;
  function psRestoreIncoming(){
    if(INC)return INC;
    var out={},i,v;
    try{var sp=new URLSearchParams(window.location.search);for(i=0;i<KEYS.length;i++){v=sp.get(KEYS[i]);if(v){v=psRestoreClean(v);if(v)out[KEYS[i]]=v}}}catch(e){}
    INC=out;return out
  }
  function psRestoreApply(){
    var incoming=psRestoreIncoming(),found=false,k;
    for(k in incoming){found=true;break}
    if(!found)return;
    var links=document.querySelectorAll('.ps-restore a[href]'),i,next;
    for(i=0;i<links.length;i++){next=psRestoreRewrite(links[i].getAttribute('href')||'',incoming);if(next)links[i].setAttribute('href',next)}
  }
  /* Retarget ONLY the theme's data-ps-book anchors that point at the booking host's generic /book page;
     tel:, external and unrelated links are never touched. Processed anchors are marked so the observer
     re-scan is idempotent (the relabel itself fires one childList mutation; the next scan is a no-op).
     The data-ps-book attribute is removed from a retargeted anchor: the theme's sitewide delegated click
     listener keys on it to emit the booking-click GA4 event, which must not fire for the quote funnel. */
  function psRestoreBook(){
    if(!BOOK)return;
    var list,i,a,pos,u;
    try{list=document.querySelectorAll('a[data-ps-book]')}catch(e){return}
    for(i=0;i<list.length;i++){
      a=list[i];
      if(a.getAttribute('data-ps-restored'))continue;
      pos=psRestoreClean(a.getAttribute('data-ps-book')||'');
      if(!pos)continue;
      try{u=new URL(a.getAttribute('href')||'',${js(SITE + '/')})}catch(e){continue}
      if(u.origin!==${js(BOOK_HOST)})continue;
      if(u.pathname!=='/book')continue;
      a.setAttribute('data-ps-restored','1');
      if(BOOK.anchor){a.setAttribute('href',BOOK.anchor)}
      else{
        var q;try{q=new URL(BOOK.quote)}catch(e){continue}
        q.searchParams.set('utm_content',BOOK.slug+'_'+pos);
        var next=q.toString();
        var fwd=psRestoreRewrite(next,psRestoreIncoming());
        a.setAttribute('href',fwd?fwd:next)
      }
      if(a.textContent!==BOOK.label)a.textContent=BOOK.label;
      if(a.getAttribute('aria-label'))a.setAttribute('aria-label',BOOK.label);
      a.removeAttribute('data-ps-book')
    }
  }
  function psRestoreRun(){psRestoreApply();psRestoreBook()}
  /* Run only once the whole document is parsed: this inline script sits mid-page, and markup AFTER it
     (e.g. the preview's sticky CTA) must be rewritten too. */
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',psRestoreRun);
  else psRestoreRun();
  if(BOOK){if(typeof MutationObserver!=='undefined'){
    var rootEl=document.documentElement||document.body;
    if(rootEl){try{new MutationObserver(psRestoreBook).observe(rootEl,{childList:true,subtree:true})}catch(e){}}
  }}
})();
</script>`
  if (script.includes('&')) throw new Error('attribution script contains a literal ampersand; WordPress entity-encodes script text and breaks execution')
  return script
}

/** CTA to the ONE estimate funnel on the booking host, carrying website attribution + the landing-page slug. */
export function ctaUrl(page: LandingPage, position: string, service = page.service): string {
  const svc = service ?? 'vandalism'
  const q = new URLSearchParams({ service: svc, utm_source: 'website', utm_medium: 'landing', utm_campaign: CAMPAIGN, utm_content: `${page.slug}_${position}`, lp: page.slug })
  return `${BOOK_HOST}/quote?${q.toString()}`
}

/** `[[slug|text]]` → internal link to another landing page; validated (unknown slug throws at build time). */
export function inline(text: string): string {
  return esc(text).replace(/\[\[([a-z0-9-]+)\|([^\]]+)\]\]/g, (_m, slug: string, label: string) => {
    if (!pageBySlug(slug)) throw new Error(`unknown internal link target: ${slug}`)
    return `<a href="${pageUrl(slug)}">${label}</a>`
  })
}

function section(s: Section): string {
  const parts = [`<h2>${esc(s.heading)}</h2>`]
  for (const p of s.paras ?? []) parts.push(`<p>${inline(p)}</p>`)
  if (s.bullets?.length) parts.push(`<ul>${s.bullets.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>`)
  if (s.steps?.length) parts.push(`<ol class="steps">${s.steps.map((b) => `<li>${inline(b)}</li>`).join('')}</ol>`)
  if (s.callout) parts.push(`<div class="callout${s.callout.tone === 'navy' ? ' navy' : ''}"><p>${inline(s.callout.text)}</p></div>`)
  return parts.join('\n')
}

function hubCards(page: LandingPage, assets: AssetManifest): string {
  if (page.service) return ''
  const cards = PAGES.filter((p) => p.service).map((p) => `
    <div class="card">
      ${illustrationFigure(p.illustrationId, assets, true)}
      <span class="tag">${esc(p.kicker)}</span>
      <h3><a href="${pageUrl(p.slug)}">${esc(p.h1)}</a></h3>
      <p class="note">${esc(p.lede.split('. ')[0])}.</p>
      <a class="btn btn-red" href="${ctaUrl(page, `card_${p.service}`, p.service)}">${esc(p.ctaLabel)}</a>
    </div>`).join('')
  return `<h2 id="types">Start with the kind of damage</h2><div class="grid2">${cards}</div>`
}

function faqHtml(page: LandingPage): string {
  return `<h2 id="faq">Questions people ask</h2>` + page.faqs.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('\n')
}

function relatedHtml(page: LandingPage): string {
  const links = page.related.map((slug) => { const p = pageBySlug(slug); if (!p) throw new Error(`unknown related page: ${slug}`); return `<li><a href="${pageUrl(slug)}">${esc(p.h1)}</a></li>` })
  return `<h2>Related</h2><ul>${links.join('')}<li><a href="${SITE}/detailing/">Detailing services</a></li><li><a href="${SITE}/contact/">Contact the shop</a></li></ul>`
}

function ctaBlock(page: LandingPage, position: string): string {
  const primary = page.service ? `<a class="btn btn-red" href="${ctaUrl(page, position)}">${esc(page.ctaLabel)}</a>` : `<a class="btn btn-red" href="#types">${esc(page.ctaLabel)}</a>`
  return `<div class="btns">${primary}<a class="btn btn-line" href="tel:${SHOP.tel}">Call ${esc(SHOP.phone)}</a></div>`
}

/** Figures for the OPTIONAL real-photo slots. A generated image may never stand in for a real-photo slot. */
function figures(page: LandingPage, assets: AssetManifest, placeholders: boolean): string {
  const items = page.photos.map((ph) => {
    const a = assetEntry(assets, ph.id)
    if (a) {
      if (a.provenance === GENERATED_PROVENANCE) throw new Error(`photo slot ${ph.id}: generated illustrations may not stand in for real shop photos`)
      return `<figure><img src="${esc(a.src)}" alt="${esc(a.alt ?? ph.caption)}" loading="lazy"><figcaption>${esc(a.caption ?? ph.caption)}</figcaption></figure>`
    }
    if (!placeholders) return ''
    return `<figure class="ph"><div class="ph-box">OPTIONAL REAL PHOTO<br><small>${esc(ph.id)}</small></div><figcaption>${esc(ph.caption)} — <em>${esc(ph.note)}</em></figcaption></figure>`
  }).filter(Boolean)
  return items.length ? `<div class="grid2">${items.join('')}</div>` : ''
}

export function faqJsonLd(page: LandingPage): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: page.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  }
}

export function serviceJsonLd(page: LandingPage): Record<string, unknown> {
  const provider = {
    '@type': 'AutoRepair', name: SHOP.name, telephone: SHOP.tel, url: SITE,
    address: { '@type': 'PostalAddress', streetAddress: SHOP.street, addressLocality: SHOP.city, addressRegion: SHOP.state, postalCode: SHOP.zip, addressCountry: 'US' },
    openingHours: SHOP.openingHours, areaServed: ['College Station, TX', 'Bryan, TX'],
  }
  return { '@context': 'https://schema.org', '@type': 'Service', name: page.h1, serviceType: page.service ? QUOTE_SERVICES[page.service].label : 'Insurance-related auto restoration', description: page.metaDescription, url: pageUrl(page.slug), provider, areaServed: provider.areaServed }
}

// Production styles for the WP body. EVERY rule is scoped under `.ps-restore` (including the custom
// properties) so nothing leaks into or depends on the Avada theme. Light palette only — the page lives
// inside the site's light theme. Responsive grids + 44px touch targets + visible focus preserved.
export const WP_CSS = `
.ps-restore{--psr-fg:#0b1f33;--psr-muted:#4b5b6b;--psr-navy:#0d4469;--psr-bar:#0a2f4a;--psr-red:#c8102e;--psr-yellow:#f5c518;--psr-line:#d9e1ea;--psr-panel:#f3f6f9;--psr-ok:#1a7f4b;color:var(--psr-fg);font-size:16px;line-height:1.55}
.ps-restore h1,.ps-restore h2,.ps-restore h3{line-height:1.2}
.ps-restore h2{font-size:1.6rem;margin:40px 0 12px;color:var(--psr-fg)}
.ps-restore h3{font-size:1.15rem;margin:0 0 8px}
.ps-restore p{margin:0 0 12px}
.ps-restore a{color:var(--psr-navy)}
.ps-restore .ps-hero{background:var(--psr-bar);color:#fff;padding:36px 20px 28px;border-radius:14px}
.ps-restore .ps-hero h1{font-size:clamp(1.9rem,5vw,2.6rem);margin:0 0 10px;color:#fff}
.ps-restore .ps-hero .lede{font-size:1.1rem;max-width:40rem;color:#e8eef4}
.ps-restore .kick{display:inline-block;background:var(--psr-yellow);color:#0b1f33;font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:3px 10px;border-radius:4px;margin-bottom:12px}
.ps-restore .btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.ps-restore .btn{display:inline-block;padding:12px 18px;border-radius:8px;font-weight:700;text-decoration:none;border:2px solid transparent;min-height:44px;box-sizing:border-box}
.ps-restore .btn:focus-visible{outline:3px solid var(--psr-yellow);outline-offset:2px}
.ps-restore .btn-red{background:var(--psr-red);color:#fff}
.ps-restore .btn-line{border-color:currentColor;color:inherit;background:transparent}
.ps-restore .ps-hero .btn-line{color:#fff}
.ps-restore .trust{display:flex;flex-wrap:wrap;gap:8px 20px;margin:14px 0 0;padding:0;list-style:none;font-size:14px;color:var(--psr-muted)}
.ps-restore .trust li::before{content:"\\2713 ";color:var(--psr-ok);font-weight:700}
.ps-restore .grid2{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.ps-restore .card{background:#fff;border:1px solid var(--psr-line);border-radius:12px;padding:18px;min-width:0}
.ps-restore .card .btn{margin-top:8px}
.ps-restore .tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:var(--psr-panel);border:1px solid var(--psr-line);border-radius:999px;padding:2px 10px;color:var(--psr-muted)}
.ps-restore .note{font-size:14px;color:var(--psr-muted)}
.ps-restore ul{padding-left:20px}
.ps-restore .steps{counter-reset:s;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));padding:0;margin:0;list-style:none}
.ps-restore .steps li{counter-increment:s;background:var(--psr-panel);border-radius:10px;padding:14px 14px 14px 52px;position:relative;min-width:0}
.ps-restore .steps li::before{content:counter(s);position:absolute;left:14px;top:12px;width:28px;height:28px;border-radius:50%;background:var(--psr-navy);color:#fff;font-weight:800;display:grid;place-items:center}
.ps-restore .callout{background:var(--psr-panel);border-left:5px solid var(--psr-yellow);padding:14px 16px;border-radius:0 10px 10px 0;margin:16px 0}
.ps-restore .callout.navy{border-left-color:var(--psr-navy)}
.ps-restore figure{margin:0 0 12px;min-width:0}
.ps-restore figure img{width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;border-radius:10px;display:block}
.ps-restore figcaption{font-size:13px;color:var(--psr-muted);margin-top:6px}
.ps-restore .lead-fig{margin:20px 0}
.ps-restore .card-fig{margin:0 0 12px}
.ps-restore .illus-note{display:inline-block;font-style:italic;color:var(--psr-muted)}
.ps-restore details{border:1px solid var(--psr-line);border-radius:10px;padding:10px 14px;margin:8px 0;background:#fff}
.ps-restore summary{font-weight:700;cursor:pointer;min-height:24px}
.ps-restore details p{margin:8px 0 0}
`

/** The body to paste into a WordPress Custom HTML block — self-contained: scoped CSS + content + JSON-LD + script. */
export function wpBody(page: LandingPage, assets: AssetManifest = {}): string {
  return [
    `<!-- Pitt Stop insurance-restoration landing page: ${page.slug}. Generated from website/wordpress/insurance-restoration/pages.ts — edit the source, not this file. -->`,
    `<div class="ps-restore">`,
    `<style>${WP_CSS}</style>`,
    `<section class="ps-hero"><span class="kick">${esc(page.kicker)}</span><h1>${esc(page.h1)}</h1><p class="lede">${esc(page.lede)}</p>${ctaBlock(page, 'hero')}</section>`,
    `<ul class="trust">${page.trust.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`,
    illustrationFigure(page.illustrationId, assets),
    hubCards(page, assets),
    ...page.sections.map(section),
    figures(page, assets, false),
    `<h2>${esc(page.insurance.heading)}</h2>${page.insurance.paras.map((p) => `<p>${inline(p)}</p>`).join('')}`,
    `<div class="callout navy"><p><strong>Ready when you are.</strong> Send photos and we will reply with next steps during business hours (${esc(SHOP.hours)}). ${esc(SHOP.street)}, ${esc(SHOP.city)}, ${SHOP.state} ${SHOP.zip}.</p>${ctaBlock(page, 'mid')}</div>`,
    faqHtml(page),
    relatedHtml(page),
    `</div>`,
    `<script type="application/ld+json">${JSON.stringify(faqJsonLd(page))}</script>`,
    `<script type="application/ld+json">${JSON.stringify(serviceJsonLd(page))}</script>`,
    attributionScript(page),
  ].filter(Boolean).join('\n')
}

// Preview-only chrome (review bar, placeholder boxes, review notes, sticky CTA). The page content itself
// is styled by the SAME scoped WP_CSS the production body ships, so the preview shows production styling.
const PREVIEW_CSS = `
body{background:#fff;color:#0b1f33;font:16px/1.55 Roboto,Arial,Helvetica,sans-serif;margin:0}
.wrap{max-width:900px;margin:0 auto;padding:0 16px 96px}
.bar{background:#0a2f4a;color:#fff;text-align:center;padding:8px 16px;font-size:14px}
.ph-box{height:220px;border:2px dashed #b45309;border-radius:10px;display:grid;place-items:center;text-align:center;color:#b45309;font-weight:800;background:#fff4e0}
.sticky{position:fixed;left:0;right:0;bottom:0;background:#0a2f4a;display:flex;gap:8px;padding:10px;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:5}
.sticky a{flex:1;text-align:center;padding:12px 8px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px;min-height:44px;box-sizing:border-box}
.review-box{background:#fff4e0;border:1px dashed #b45309;border-radius:10px;padding:12px 14px;margin:28px 0 0;font-size:14px}.review-box b{color:#b45309}.review-box ul{margin:6px 0 0;padding-left:18px}
footer{color:#4b5b6b;font-size:14px;margin-top:40px;border-top:1px solid #d9e1ea;padding-top:16px}
`

/** Standalone preview for owner review. Contains everything the WP body does, plus placeholders + review notes. */
export function previewHtml(page: LandingPage, assets: AssetManifest = {}): string {
  const body = wpBody(page, assets)
  // inject optional-photo placeholders where the WP body omitted missing figures
  const withPlaceholders = body.replace(`<h2>${esc(page.insurance.heading)}</h2>`, `${figures(page, assets, true)}\n<h2>${esc(page.insurance.heading)}</h2>`)
  const missingIllustration = page.service && page.illustrationId && !assetEntry(assets, page.illustrationId)
  const missingPhotos = page.photos.filter((p) => !assetEntry(assets, p.id))
  const sticky = page.service
    ? `<div class="sticky ps-restore"><a class="btn-red" style="background:#c8102e;color:#fff" href="${ctaUrl(page, 'sticky')}">${esc(page.ctaLabel)}</a><a style="background:#fff;color:#0a2f4a" href="tel:${SHOP.tel}">Call</a></div>`
    : `<div class="sticky ps-restore"><a class="btn-red" style="background:#c8102e;color:#fff" href="#types">${esc(page.ctaLabel)}</a><a style="background:#fff;color:#0a2f4a" href="tel:${SHOP.tel}">Call</a></div>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.seoTitle)}</title><meta name="description" content="${esc(page.metaDescription)}"><meta name="robots" content="noindex">
<link rel="canonical" href="${pageUrl(page.slug)}"><style>${PREVIEW_CSS}</style></head>
<body>
<div class="bar">Draft for owner review · proposed new page <b>/${esc(page.slug)}/</b> on the WordPress site · nothing on this page is live</div>
<div class="wrap">
${withPlaceholders}
<div class="review-box"><b>Review notes (not part of the published page)</b>
<ul>
<li>SEO title (${page.seoTitle.length} chars): ${esc(page.seoTitle)}</li>
<li>Meta description (${page.metaDescription.length} chars): ${esc(page.metaDescription)}</li>
<li>Estimate CTA → ${esc(ctaUrl(page, 'hero'))} (ad-click parameters are forwarded onto the CTAs by the included script)</li>
<li>${missingIllustration ? `Generated illustration pending (${page.illustrationId}): supply it via assets.json; it will render with the visible caption “${ILLUSTRATION_NOTICE}”.` : page.illustrationId ? `Illustration supplied; the caption “${ILLUSTRATION_NOTICE}” renders under it.` : 'Hub page: reuses the four service illustrations on its cards once supplied.'}</li>
<li>${missingPhotos.length ? `Optional real shop photos (${missingPhotos.length}): ${missingPhotos.map((m) => esc(m.id)).join(', ')} — upgrades, NOT publish blockers. Real jobs only, never a generated image.` : 'All optional real-photo slots supplied.'}</li>
</ul></div>
<footer>${esc(SHOP.name)} · ${esc(SHOP.street)}, ${esc(SHOP.city)}, ${SHOP.state} ${SHOP.zip} · ${esc(SHOP.phone)} · ${esc(SHOP.hours)}</footer>
</div>
${sticky}
</body></html>`
}

export function seoSidecar(page: LandingPage, assets: AssetManifest = {}) {
  const illus = page.service ? [page.illustrationId].filter((x): x is string => !!x) : PAGES.filter((p) => p.service && p.illustrationId).map((p) => p.illustrationId as string)
  return {
    slug: page.slug,
    url: pageUrl(page.slug),
    title: page.seoTitle,
    metaDescription: page.metaDescription,
    canonical: pageUrl(page.slug),
    robots: 'index, follow',
    h1: page.h1,
    primaryCta: page.service ? ctaUrl(page, 'hero') : null,
    internalLinks: page.related.map(pageUrl),
    illustrations: illus.map((id) => ({ id, supplied: !!assetEntry(assets, id), notice: ILLUSTRATION_NOTICE })),
    optionalRealPhotos: page.photos.filter((p) => !assetEntry(assets, p.id)),
    schema: [faqJsonLd(page), serviceJsonLd(page)],
    publishChecklist: [
      'Create the page in wp-admin → Pages → Add New with this slug; paste dist/<slug>.wp.html into a Custom HTML block. The block is self-contained (scoped styles + attribution script) — no theme CSS or JS dependency.',
      'Rank Math: set the SEO title and meta description from this file; keep "index, follow"; confirm the canonical URL.',
      'Upload the generated illustration(s) to the WordPress media library, record each URL in website/wordpress/insurance-restoration/assets.json with provenance "generated illustration", rebuild (npx tsx scripts/build-restoration-pages.ts) and re-paste. Verify the visible caption "Illustrative image — not a completed Pitt Stop job." renders under each generated image.',
      'Optional: replace/augment illustrations with real shop photos (optionalRealPhotos list) — real jobs with permission only; never present a generated image as a completed job or before/after.',
      'Link the page from /detailing/ and the footer or services menu; the hub page links to the four service pages.',
      'After publishing: request indexing in Search Console (owner reports access was granted — verify before relying on it) and add the URL to the Google Ads final-URL list for its campaign.',
    ],
  }
}
