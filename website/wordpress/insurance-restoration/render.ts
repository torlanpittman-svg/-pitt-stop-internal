/**
 * Renders a LandingPage (pages.ts) into:
 *   - wpBody(page)     — the HTML body for a WordPress Custom HTML block (no <html>/<head>, no preview-only
 *                        chrome, no photo placeholders — only the figures whose asset exists in `assets`);
 *   - previewHtml(page) — a standalone page for owner review, in the same visual language as the approved
 *                        ceramic landing draft, with labelled PHOTO NEEDED placeholders and a review box;
 *   - faqJsonLd(page) / serviceJsonLd(page) — structured data for Rank Math's schema or a Custom HTML block;
 *   - seoSidecar(page) — title / description / slug / canonical / schema for the publisher.
 * Pure functions, no I/O (the build script writes files; pages.test.ts asserts on the output).
 */
import { PAGES, SHOP, SITE, BOOK_HOST, CAMPAIGN, pageBySlug, type LandingPage, type Section } from './pages'
import { QUOTE_SERVICES } from '@/apps/marketing/quote-shared'

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const pageUrl = (slug: string): string => `${SITE}/${slug}/`

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

function hubCards(page: LandingPage): string {
  if (page.service) return ''
  const cards = PAGES.filter((p) => p.service).map((p) => `
    <div class="card">
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

/** Figures for photos whose real asset exists. `assets` maps photo id → published image URL (WordPress media). */
function figures(page: LandingPage, assets: Record<string, string>, placeholders: boolean): string {
  const items = page.photos.map((ph) => {
    const src = assets[ph.id]
    if (src) return `<figure><img src="${esc(src)}" alt="${esc(ph.caption)}" loading="lazy"><figcaption>${esc(ph.caption)}</figcaption></figure>`
    if (!placeholders) return ''
    return `<figure class="ph"><div class="ph-box">PHOTO NEEDED<br><small>${esc(ph.id)}</small></div><figcaption>${esc(ph.caption)} — <em>${esc(ph.note)}</em></figcaption></figure>`
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

/** The body to paste into a WordPress Custom HTML block (structured data included as inline scripts). */
export function wpBody(page: LandingPage, assets: Record<string, string> = {}): string {
  return [
    `<!-- Pitt Stop insurance-restoration landing page: ${page.slug}. Generated from website/wordpress/insurance-restoration/pages.ts — edit the source, not this file. -->`,
    `<section class="ps-hero"><span class="kick">${esc(page.kicker)}</span><h1>${esc(page.h1)}</h1><p class="lede">${esc(page.lede)}</p>${ctaBlock(page, 'hero')}</section>`,
    `<ul class="trust">${page.trust.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`,
    hubCards(page),
    ...page.sections.map(section),
    figures(page, assets, false),
    `<h2>${esc(page.insurance.heading)}</h2>${page.insurance.paras.map((p) => `<p>${inline(p)}</p>`).join('')}`,
    `<div class="callout navy"><p><strong>Ready when you are.</strong> Send photos and we will reply with next steps during business hours (${esc(SHOP.hours)}). ${esc(SHOP.street)}, ${esc(SHOP.city)}, ${SHOP.state} ${SHOP.zip}.</p>${ctaBlock(page, 'mid')}</div>`,
    faqHtml(page),
    relatedHtml(page),
    `<script type="application/ld+json">${JSON.stringify(faqJsonLd(page))}</script>`,
    `<script type="application/ld+json">${JSON.stringify(serviceJsonLd(page))}</script>`,
  ].filter(Boolean).join('\n')
}

const PREVIEW_CSS = `
:root{--bg:#fff;--fg:#0b1f33;--muted:#4b5b6b;--navy:#0d4469;--navy-bar:#0a2f4a;--red:#c8102e;--yellow:#f5c518;--line:#d9e1ea;--panel:#f3f6f9;--ok:#1a7f4b;--flag:#b45309;--flagbg:#fff4e0;--card:#fff;color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0b1620;--fg:#e8eef4;--muted:#a9b6c3;--navy:#8fc1ec;--navy-bar:#071a2a;--line:#22364a;--panel:#10202e;--card:#0f1c28;--flag:#f0b358;--flagbg:#2a1f0c;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0b1620;--fg:#e8eef4;--muted:#a9b6c3;--navy:#8fc1ec;--navy-bar:#071a2a;--line:#22364a;--panel:#10202e;--card:#0f1c28;--flag:#f0b358;--flagbg:#2a1f0c;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:16px/1.55 Roboto,Arial,Helvetica,sans-serif;margin:0}
.wrap{max-width:900px;margin:0 auto;padding:0 16px 96px}
h1,h2,h3{text-wrap:balance;line-height:1.2}h2{font-size:1.6rem;margin:40px 0 12px}h3{font-size:1.15rem;margin:0 0 8px}p{margin:0 0 12px}
.bar{background:var(--navy-bar);color:#fff;text-align:center;padding:8px 16px;font-size:14px}
.ps-hero{background:var(--navy-bar);color:#fff;padding:48px 16px 28px}.ps-hero>*{max-width:900px;margin-left:auto;margin-right:auto}
.ps-hero h1{font-size:clamp(1.9rem,5vw,2.8rem);margin:0 0 10px}.ps-hero .lede{font-size:1.1rem;max-width:40rem;color:#e8eef4}
.kick{display:inline-block;background:var(--yellow);color:#0b1f33;font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:3px 10px;border-radius:4px;margin-bottom:12px}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.btn{display:inline-block;padding:12px 18px;border-radius:8px;font-weight:700;text-decoration:none;border:2px solid transparent;min-height:44px;box-sizing:border-box}
.btn-red{background:var(--red);color:#fff}.btn-line{border-color:currentColor;color:inherit;background:transparent}.ps-hero .btn-line{color:#fff}
.trust{display:flex;flex-wrap:wrap;gap:8px 20px;margin:14px 0 0;padding:0;list-style:none;font-size:14px;color:var(--muted)}.trust li::before{content:"✓ ";color:var(--ok);font-weight:700}
.grid2{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;min-width:0}.card .btn{margin-top:8px}
.tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:2px 10px;color:var(--muted)}
.note{font-size:14px;color:var(--muted)}
.steps{counter-reset:s;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));padding:0;margin:0;list-style:none}
.steps li{counter-increment:s;background:var(--panel);border-radius:10px;padding:14px 14px 14px 52px;position:relative;min-width:0}
.steps li::before{content:counter(s);position:absolute;left:14px;top:12px;width:28px;height:28px;border-radius:50%;background:var(--navy);color:#fff;font-weight:800;display:grid;place-items:center}
.callout{background:var(--panel);border-left:5px solid var(--yellow);padding:14px 16px;border-radius:0 10px 10px 0;margin:16px 0}.callout.navy{border-left-color:var(--navy)}
figure{margin:0;min-width:0}figure img{width:100%;height:220px;object-fit:cover;border-radius:10px;display:block}figcaption{font-size:13px;color:var(--muted);margin-top:6px}
.ph-box{height:220px;border:2px dashed var(--flag);border-radius:10px;display:grid;place-items:center;text-align:center;color:var(--flag);font-weight:800;background:var(--flagbg)}
details{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0;background:var(--card)}summary{font-weight:700;cursor:pointer;min-height:24px}details p{margin:8px 0 0}
.sticky{position:fixed;left:0;right:0;bottom:0;background:var(--navy-bar);display:flex;gap:8px;padding:10px;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:5}
.sticky a{flex:1;text-align:center;padding:12px 8px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px;min-height:44px;box-sizing:border-box}
.review-box{background:var(--flagbg);border:1px dashed var(--flag);border-radius:10px;padding:12px 14px;margin:28px 0 0;font-size:14px}.review-box b{color:var(--flag)}.review-box ul{margin:6px 0 0;padding-left:18px}
footer{color:var(--muted);font-size:14px;margin-top:40px;border-top:1px solid var(--line);padding-top:16px}
a{color:var(--navy)}
`

/** Standalone preview for owner review. Contains everything the WP body does, plus placeholders + review notes. */
export function previewHtml(page: LandingPage, assets: Record<string, string> = {}): string {
  const body = wpBody(page, assets)
  // inject placeholders where the WP body omitted missing figures
  const withPlaceholders = body.replace(`<h2>${esc(page.insurance.heading)}</h2>`, `${figures(page, assets, true)}\n<h2>${esc(page.insurance.heading)}</h2>`)
  const missing = page.photos.filter((p) => !assets[p.id])
  const sticky = page.service
    ? `<div class="sticky"><a class="btn-red" style="background:var(--red);color:#fff" href="${ctaUrl(page, 'sticky')}">${esc(page.ctaLabel)}</a><a style="background:#fff;color:var(--navy-bar)" href="tel:${SHOP.tel}">Call</a></div>`
    : `<div class="sticky"><a class="btn-red" style="background:var(--red);color:#fff" href="#types">${esc(page.ctaLabel)}</a><a style="background:#fff;color:var(--navy-bar)" href="tel:${SHOP.tel}">Call</a></div>`
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
<li>Estimate CTA → ${esc(ctaUrl(page, 'hero'))}</li>
<li>${missing.length ? `Photos still needed (${missing.length}): ${missing.map((m) => esc(m.id)).join(', ')}. The published body ships WITHOUT images until real shop photos are supplied.` : 'All photo assets supplied.'}</li>
<li>Owner decisions: confirm the glass-coordination wording and the no-direct-billing statement match what staff will actually do.</li>
</ul></div>
<footer>${esc(SHOP.name)} · ${esc(SHOP.street)}, ${esc(SHOP.city)}, ${SHOP.state} ${SHOP.zip} · ${esc(SHOP.phone)} · ${esc(SHOP.hours)}</footer>
</div>
${sticky}
</body></html>`
}

export function seoSidecar(page: LandingPage, assets: Record<string, string> = {}) {
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
    photosNeeded: page.photos.filter((p) => !assets[p.id]),
    schema: [faqJsonLd(page), serviceJsonLd(page)],
    publishChecklist: [
      'Create the page in wp-admin → Pages → Add New with this slug; paste dist/<slug>.wp.html into a Custom HTML block.',
      'Rank Math: set the SEO title and meta description from this file; keep "index, follow"; confirm the canonical URL.',
      'Add real shop photos for each photosNeeded id with the listed caption as alt text (no stock images).',
      'Link the page from /detailing/ and the footer or services menu; the hub page links to the four service pages.',
      'After publishing: request indexing in Search Console (access still to be granted) and add the URL to the Google Ads final-URL list for its campaign.',
    ],
  }
}
