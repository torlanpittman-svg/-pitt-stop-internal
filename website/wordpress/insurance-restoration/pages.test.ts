/**
 * Content + output guardrails for the insurance-restoration landing pages. Every page must: carry qualified
 * insurance language (no coverage / free-repair / deductible / billing-status promises and no absolute
 * glass-removal or adjuster-meeting promises), have exactly one H1 and unique metadata within length
 * limits, link to the ONE estimate funnel with full attribution, forward incoming allow-listed ad-click
 * parameters (gclid / utm_*) onto CTAs and cross-page links via the shipped script, ship self-contained
 * CSS scoped under `.ps-restore` (no theme dependency, no global leaks), expose valid FAQ + Service
 * JSON-LD matching the visible text, and render images ONLY for supplied manifest assets — generated
 * illustrations always with the visible provenance caption, never on real-photo slots.
 */
import { describe, it, expect } from 'vitest'
import { PAGES, INSURER_DECIDES, CLAIM_PROCESS, SHOP, BOOK_HOST, SITE, ILLUSTRATIONS } from './pages'
import {
  wpBody, previewHtml, faqJsonLd, serviceJsonLd, seoSidecar, ctaUrl, attributionScript,
  FORWARDED_ATTRIBUTION_KEYS, ILLUSTRATION_NOTICE, WP_CSS, type AssetManifest,
} from './render'
import { QUOTE_SERVICES, isRestorationService } from '@/apps/marketing/quote-shared'
import { ATTRIBUTION_KEYS } from '@/apps/appointments/attribution'

const text = (html: string) => html
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')

/**
 * Promises the shop must never make. Billing arrangements are UNVERIFIED either way (owner, 2026-11-07),
 * so both "we bill your insurer" AND the old blanket "we don't bill your insurance company" are forbidden;
 * pages state only the neutral claim process.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bguarantee/i, 'guarantee'],
  [/\bfree (repair|fix|replacement)/i, 'free repair'],
  [/\b(waive|waived|cover|covers|pay|pays|eat|absorb)[a-z]*\s+(your\s+)?deductible/i, 'deductible promise'],
  [/\bwe (can |will |also )?(bill|invoice|charge) (your |the )?insur/i, 'direct billing claim'],
  [/\bwe don[’']t bill\b|\bwe do not bill\b/i, 'unverified billing-status claim'],
  [/\bno out[- ]of[- ]pocket/i, 'no out-of-pocket'],
  [/\b(is|are|will be|always|fully|100%) covered\b/i, 'unqualified coverage'],
  [/\bapproved claim\b|\bclaim (is|will be) approved/i, 'approval promise'],
  [/\breimburse/i, 'reimbursement promise'],
  [/\bcovered by insurance\b/i, 'unqualified "covered by insurance"'],
  [/\bsame[- ]day guarantee|\bwithin 24 hours\b/i, 'turnaround promise'],
  [/\bevery (single )?(shard|piece|fragment)\b|\ball (of )?the glass\b|\bnobody finds\b|\bevery cavity\b/i, 'absolute glass-removal promise'],
  [/\b(walk|meet with|speak (to|with)|talk (to|with)) (the |your |an? )?adjuster/i, 'adjuster meeting promise'],
  [/\bprotect (your|their) rates?\b|\bdo(es)? not affect your (rate|premium)\b|\braise (my|your) rates?\b/i, 'insurance-premium advice'],
  [/\bshould be totaled\b|\btotal[- ]loss (conversation|talk)\b/i, 'speculative total-loss determination'],
]

/** Extract the shipped attribution script and return its pure functions (the IIFE no-ops without a DOM). */
function scriptFns(body: string): { rewrite: (href: string, incoming: Record<string, string>) => string | null; clean: (v: string) => string } {
  const m = body.match(/<script>\n\/\* Pitt Stop attribution pass-through([\s\S]*?)<\/script>/)
  expect(m, 'attribution script present in the WP body').toBeTruthy()
  const src = `/*${m![1]}`
  const fns = new Function(`${src}; return { rewrite: psRestoreRewrite, clean: psRestoreClean }`)() as { rewrite: (h: string, i: Record<string, string>) => string | null; clean: (v: string) => string }
  return fns
}

const GEN = (id: string, over: Partial<{ src: string; alt: string; caption: string; provenance: string }> = {}): AssetManifest => ({
  [id]: { src: `${SITE}/wp-content/uploads/2026/11/${id}.jpg`, alt: `Illustration: ${ILLUSTRATIONS[id]?.caption ?? id}`, provenance: 'generated illustration', ...over } as never,
})

describe('insurance-restoration landing pages', () => {
  it('has the five required slugs, one per damage type plus the hub, with unique metadata within limits', () => {
    expect(PAGES.map((p) => p.slug).sort()).toEqual(['auto-glass-repair', 'car-overspray-removal', 'car-vandalism-repair', 'car-water-damage', 'insurance-auto-repair'])
    const titles = new Set(PAGES.map((p) => p.seoTitle)); const descs = new Set(PAGES.map((p) => p.metaDescription)); const h1s = new Set(PAGES.map((p) => p.h1))
    expect(titles.size).toBe(5); expect(descs.size).toBe(5); expect(h1s.size).toBe(5)
    for (const p of PAGES) {
      expect(p.seoTitle.length, `${p.slug} title`).toBeLessThanOrEqual(60)
      expect(p.metaDescription.length, `${p.slug} description`).toBeGreaterThanOrEqual(90)
      expect(p.metaDescription.length, `${p.slug} description`).toBeLessThanOrEqual(155) // the contract declared in pages.ts
      if (p.service) expect(isRestorationService(p.service)).toBe(true)
      if (p.service) expect(p.illustrationId && ILLUSTRATIONS[p.illustrationId], `${p.slug} illustration slot`).toBeTruthy()
    }
    const services = PAGES.map((p) => p.service).filter(Boolean).sort()
    expect(services).toEqual(['glass', 'overspray', 'vandalism', 'water_damage'])
  })

  for (const page of PAGES) {
    describe(page.slug, () => {
      const body = wpBody(page)
      const preview = previewHtml(page)
      const visible = text(body)

      it('never promises coverage, free repairs, deductible help, approval, billing status, total glass removal or adjuster meetings', () => {
        for (const [re, label] of FORBIDDEN) {
          const m = visible.match(re)
          expect(m, `${label}: "${m?.[0]}" in ${page.slug}`).toBeNull()
        }
        for (const f of page.faqs) for (const [re, label] of FORBIDDEN) expect(f.a.match(re), `${label} in FAQ "${f.q}"`).toBeNull()
      })
      it('states that the insurer decides and carries the neutral claim-process sentence', () => {
        expect(visible).toContain(INSURER_DECIDES.replace(/\s+/g, ' '))
        expect(visible).toContain('Contact your insurer to open or discuss a claim')
        expect(CLAIM_PROCESS).not.toMatch(/bill/i) // the process sentence itself asserts nothing about billing
      })
      it('has exactly one H1, H2 sections, and an FAQ with at least four questions', () => {
        expect(body.match(/<h1[ >]/g)?.length).toBe(1)
        expect((body.match(/<h2[ >]/g) ?? []).length).toBeGreaterThanOrEqual(4)
        expect(page.faqs.length).toBeGreaterThanOrEqual(4)
        expect(body).toContain('<details>')
      })
      it('links to the single estimate funnel with service + website attribution + landing-page slug, plus a tel: link', () => {
        if (page.service) {
          const u = new URL(ctaUrl(page, 'hero'))
          expect(u.origin + u.pathname).toBe(`${BOOK_HOST}/quote`)
          expect(u.searchParams.get('service')).toBe(page.service)
          expect(u.searchParams.get('utm_source')).toBe('website'); expect(u.searchParams.get('utm_medium')).toBe('landing'); expect(u.searchParams.get('utm_campaign')).toBe('insurance_restoration')
          expect(u.searchParams.get('lp')).toBe(page.slug)
          expect(body).toContain(ctaUrl(page, 'hero').replace(/&/g, '&amp;').replace(/&amp;/g, '&')) // raw URL is present in an href
          // both production CTA positions exist (hero + mid); the preview adds the sticky one
          expect(body).toContain(`utm_content=${page.slug}_hero`)
          expect(body).toContain(`utm_content=${page.slug}_mid`)
          expect(preview).toContain(`utm_content=${page.slug}_sticky`)
        } else {
          // hub: one CTA per damage type, each carrying that type
          for (const p of PAGES.filter((x) => x.service)) {
            expect(body).toContain(`service=${p.service}`)
            expect(body).toContain(`utm_content=${page.slug}_card_${p.service}`)
          }
          expect(body).toContain(`lp=${page.slug}`)
        }
        expect(body).toContain(`href="tel:${SHOP.tel}"`)
        expect(visible).toContain(SHOP.phone)
      })
      it('links to the related landing pages and the main site, never to external competitors', () => {
        for (const slug of page.related) expect(body).toContain(`${SITE}/${slug}/`)
        const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
        for (const h of hrefs) expect(h.startsWith(SITE) || h.startsWith(BOOK_HOST) || h.startsWith('tel:') || h.startsWith('#'), h).toBe(true)
      })
      it('ships scoped, self-contained styles: every rule under .ps-restore, no globals, all used classes covered', () => {
        expect(body).toContain(`<style>${WP_CSS}</style>`)
        expect(body).toContain('<div class="ps-restore">')
        const selectors = WP_CSS.split('}').map((r) => r.split('{')[0].trim()).filter(Boolean)
        for (const sel of selectors) for (const part of sel.split(',')) expect(part.trim().startsWith('.ps-restore'), `unscoped CSS selector: ${part}`).toBe(true)
        expect(WP_CSS).not.toMatch(/(^|\})\s*(body|html|:root|\*)\s*[,{]/)
        // every class used in the markup has a rule (no reliance on undefined theme classes)
        const used = new Set([...body.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))
        used.delete('ps-restore')
        for (const cls of used) expect(WP_CSS.includes(`.${cls}`), `no CSS for class "${cls}"`).toBe(true)
      })
      it('exposes valid FAQPage + Service JSON-LD whose FAQ text matches the visible FAQ', () => {
        const scripts = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]))
        expect(scripts).toHaveLength(2)
        const faq = scripts[0] as ReturnType<typeof faqJsonLd> & { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> }
        expect(faq['@type']).toBe('FAQPage'); expect(faq.mainEntity).toHaveLength(page.faqs.length)
        for (const q of faq.mainEntity) { expect(visible).toContain(q.name); expect(visible).toContain(q.acceptedAnswer.text) }
        const svc = scripts[1] as ReturnType<typeof serviceJsonLd> & { provider: { telephone: string; address: { postalCode: string } }; url: string }
        expect(svc['@type']).toBe('Service'); expect(svc.provider.telephone).toBe(SHOP.tel); expect(svc.provider.address.postalCode).toBe(SHOP.zip); expect(svc.url).toBe(`${SITE}/${page.slug}/`)
        if (page.service) expect(svc).toMatchObject({ serviceType: QUOTE_SERVICES[page.service].label })
      })
      it('has a sidecar with publish steps, and the preview is noindex with the real title', () => {
        const sc = seoSidecar(page)
        expect(sc.optionalRealPhotos).toHaveLength(page.photos.length); expect(sc.publishChecklist.length).toBeGreaterThanOrEqual(4); expect(sc.robots).toBe('index, follow')
        expect(sc.illustrations.length).toBeGreaterThanOrEqual(1)
        for (const i of sc.illustrations) { expect(i.supplied).toBe(false); expect(i.notice).toBe(ILLUSTRATION_NOTICE) }
        expect(sc.publishChecklist.join(' ')).toMatch(/Illustrative image — not a completed Pitt Stop job/)
        expect(preview).toContain('<meta name="robots" content="noindex">'); expect(preview).toContain(`<title>${page.seoTitle.replace(/&/g, '&amp;')}</title>`)
        expect(preview).toContain('nothing on this page is live')
      })
      it('mentions the service area and does not fabricate reviews, prices or star ratings', () => {
        expect(visible).toMatch(/College Station/)
        expect(visible).not.toMatch(/\$\d/)
        expect(visible).not.toMatch(/★|stars?\b|5\.0|testimonial/i)
      })
    })
  }

  it('the glass page states third-party glass coordination without naming the partner, and the water page separates flood from repairable damage', () => {
    const glass = text(wpBody(PAGES.find((p) => p.slug === 'auto-glass-repair')!))
    expect(glass).toMatch(/third-party glass partner/i); expect(glass).toMatch(/do not stock or install glass/i); expect(glass).toMatch(/We do not repair windshields/)
    const water = text(wpBody(PAGES.find((p) => p.slug === 'car-water-damage')!))
    expect(water).toMatch(/total loss/i); expect(water).toMatch(/Repairable:/); expect(water).toMatch(/Flooded:/)
  })
})

describe('attribution pass-through script', () => {
  const vandal = PAGES.find((p) => p.slug === 'car-vandalism-repair')!
  const hub = PAGES.find((p) => p.slug === 'insurance-auto-repair')!
  const { rewrite, clean } = scriptFns(wpBody(vandal))

  it('allow-list matches apps/appointments/attribution.ts exactly (minus lp, which stays the page’s own)', () => {
    expect(FORWARDED_ATTRIBUTION_KEYS).toEqual(ATTRIBUTION_KEYS.filter((k) => k !== 'lp'))
    const script = attributionScript()
    for (const k of FORWARDED_ATTRIBUTION_KEYS) expect(script).toContain(`"${k}"`)
    expect(script).not.toContain('"lp"')
    expect(script).not.toMatch(/localStorage|sessionStorage|document\.cookie|fetch\(|XMLHttpRequest|sendBeacon/)
  })
  it('forwards an incoming gclid + UTMs onto a quote CTA, preserving the service and the page slug', () => {
    const href = ctaUrl(vandal, 'hero')
    const out = rewrite(href, { gclid: 'G123', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'restoration_vandalism' })
    expect(out).toBeTruthy()
    const u = new URL(out!)
    expect(u.origin + u.pathname).toBe(`${BOOK_HOST}/quote`)
    expect(u.searchParams.get('gclid')).toBe('G123')
    expect(u.searchParams.get('utm_source')).toBe('google')       // paid source overrides the website default
    expect(u.searchParams.get('utm_medium')).toBe('cpc')
    expect(u.searchParams.get('utm_campaign')).toBe('restoration_vandalism')
    expect(u.searchParams.get('service')).toBe('vandalism')       // never overridden
    expect(u.searchParams.get('lp')).toBe('car-vandalism-repair') // never overridden
  })
  it('forwards incoming params onto hub → child and cross-page landing links so the chain survives navigation', () => {
    const out = rewrite(`${SITE}/car-overspray-removal/`, { gclid: 'G9', utm_source: 'google', utm_medium: 'cpc' })
    expect(out).toBeTruthy()
    const cross = new URL(out!)
    expect(cross.origin + cross.pathname).toBe(`${SITE}/car-overspray-removal/`)
    expect(cross.searchParams.get('gclid')).toBe('G9'); expect(cross.searchParams.get('utm_source')).toBe('google'); expect(cross.searchParams.get('utm_medium')).toBe('cpc')
    // every hub card target is rewritable
    for (const p of PAGES.filter((x) => x.service)) expect(rewrite(`${SITE}/${p.slug}/`, { gclid: 'G9' })).toContain('gclid=G9')
    // hub quote CTAs (one per damage type) also carry the click through
    const hubBody = wpBody(hub)
    for (const p of PAGES.filter((x) => x.service)) {
      const cta = ctaUrl(hub, `card_${p.service}`, p.service)
      expect(hubBody).toContain(cta.replace(/&/g, '&amp;').replace(/&amp;/g, '&'))
      const u = new URL(rewrite(cta, { gclid: 'G9' })!)
      expect(u.searchParams.get('gclid')).toBe('G9')
      expect(u.searchParams.get('service')).toBe(p.service)
      expect(u.searchParams.get('lp')).toBe(hub.slug)
    }
  })
  it('without incoming paid params nothing changes: organic/direct keeps the website defaults', () => {
    expect(rewrite(ctaUrl(vandal, 'hero'), {})).toBeNull()
    const u = new URL(ctaUrl(vandal, 'mid'))
    expect(u.searchParams.get('utm_source')).toBe('website')
    expect(u.searchParams.get('utm_medium')).toBe('landing')
  })
  it('never touches tel:, anchors, non-landing site pages, third-party or javascript: URLs', () => {
    for (const href of [`tel:${SHOP.tel}`, '#faq', `${SITE}/detailing/`, `${SITE}/contact/`, 'https://evil.example/quote', 'javascript:alert(1)', 'data:text/html,x', `${BOOK_HOST}/book`]) {
      expect(rewrite(href, { gclid: 'G1' }), href).toBeNull()
    }
  })
  it('cleans hostile parameter values the same way the server does (printable subset, 120 chars max)', () => {
    expect(clean('<script>alert(1)</script>')).toBe('scriptalert1/script')
    expect(clean('abc"onmouseover="x')).toBe('abconmouseoverx')
    expect(clean('x'.repeat(500))).toHaveLength(120)
    expect(clean('CjwKCAjw_abc-123.DEF')).toBe('CjwKCAjw_abc-123.DEF') // real click-id shapes survive
  })

  // ── Actual execution against a fake DOM (not just the pure helpers): the inline script sits mid-page,
  // so it must defer to DOMContentLoaded and rewrite markup that appears AFTER it (the preview sticky CTA).
  interface FakeAnchor { href: string; getAttribute: (k: string) => string; setAttribute: (k: string, v: string) => void }
  function execute(search: string, hrefs: string[], readyState: 'loading' | 'complete') {
    const m = wpBody(vandal).match(/<script>\n\/\* Pitt Stop attribution pass-through([\s\S]*?)<\/script>/)
    expect(m).toBeTruthy()
    const anchors: FakeAnchor[] = hrefs.map((h) => ({ href: h, getAttribute() { return this.href }, setAttribute(_k: string, v: string) { this.href = v } }))
    const listeners: Record<string, Array<() => void>> = {}
    const fakeDocument = {
      readyState,
      addEventListener(ev: string, fn: () => void) { (listeners[ev] ??= []).push(fn) },
      querySelectorAll(sel: string) { expect(sel).toBe('.ps-restore a[href]'); return anchors },
    }
    const fakeWindow = { location: { search } }
    new Function('document', 'window', `/*${m![1]}`)(fakeDocument, fakeWindow)
    return { anchors, fire: (ev: string) => (listeners[ev] ?? []).forEach((f) => f()) }
  }
  it('while the document is still parsing it defers, then rewrites EVERY CTA including the late sticky one', () => {
    const hero = ctaUrl(vandal, 'hero'); const sticky = ctaUrl(vandal, 'sticky')
    const { anchors, fire } = execute('?gclid=G7&utm_source=google&utm_medium=cpc', [hero, sticky, `tel:${SHOP.tel}`], 'loading')
    expect(anchors.map((a) => a.href)).toEqual([hero, sticky, `tel:${SHOP.tel}`]) // nothing touched pre-DOMContentLoaded
    fire('DOMContentLoaded')
    for (const a of [anchors[0], anchors[1]]) {
      const u = new URL(a.href)
      expect(u.searchParams.get('gclid')).toBe('G7'); expect(u.searchParams.get('utm_source')).toBe('google'); expect(u.searchParams.get('utm_medium')).toBe('cpc')
      expect(u.searchParams.get('service')).toBe('vandalism'); expect(u.searchParams.get('lp')).toBe(vandal.slug)
    }
    expect(new URL(anchors[1].href).searchParams.get('utm_content')).toBe(`${vandal.slug}_sticky`) // the sticky CTA carries the click too
    expect(anchors[2].href).toBe(`tel:${SHOP.tel}`)
  })
  it('runs immediately on an already-complete document, and without incoming params it changes nothing', () => {
    const hero = ctaUrl(vandal, 'hero')
    const done = execute('?gclid=G7', [hero], 'complete')
    expect(new URL(done.anchors[0].href).searchParams.get('gclid')).toBe('G7') // no listener needed
    const organic = execute('', [hero], 'complete')
    expect(organic.anchors[0].href).toBe(hero)
    const hostile = execute('?gclid=%3Cscript%3E&utm_source=google', [hero], 'complete')
    expect(new URL(hostile.anchors[0].href).searchParams.get('gclid')).toBe('script') // cleaned, not dropped raw
  })
})

describe('illustrations and the asset manifest', () => {
  const vandal = PAGES.find((p) => p.slug === 'car-vandalism-repair')!
  const hub = PAGES.find((p) => p.slug === 'insurance-auto-repair')!

  it('ships NO images until assets are really supplied — URLs are never invented', () => {
    for (const p of PAGES) expect(wpBody(p)).not.toMatch(/<img\b/)
  })
  it('a supplied generated illustration renders with alt text and the visible provenance caption', () => {
    const body = wpBody(vandal, GEN('illustration-vandalism'))
    expect(body).toMatch(/<img[^>]+illustration-vandalism\.jpg/)
    expect(body).toContain(`alt="Illustration: ${ILLUSTRATIONS['illustration-vandalism'].caption}"`)
    expect(text(body)).toContain(ILLUSTRATION_NOTICE)
  })
  it('the hub reuses the service illustrations on its cards, each with the provenance caption', () => {
    const assets = { ...GEN('illustration-vandalism'), ...GEN('illustration-overspray'), ...GEN('illustration-water-damage'), ...GEN('illustration-glass-cleanup') }
    const body = wpBody(hub, assets)
    expect(body.match(/<img\b/g)).toHaveLength(4)
    expect(body.match(new RegExp(ILLUSTRATION_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(4)
  })
  it('a generated image is rejected on a real-photo slot and may not claim real-job results', () => {
    expect(() => wpBody(vandal, GEN('vandal-glass-cleanup'))).toThrow(/generated illustrations may not stand in for real shop photos/)
    expect(() => wpBody(vandal, GEN('illustration-vandalism', { caption: 'Keyed panel before and after our repair' }))).toThrow(/may not claim real-job results/)
  })
  it('rejects unsafe asset sources and unknown provenance', () => {
    expect(() => wpBody(vandal, GEN('illustration-vandalism', { src: 'javascript:alert(1)' }))).toThrow(/src must be/)
    expect(() => wpBody(vandal, GEN('illustration-vandalism', { src: '//evil.example/x.jpg' }))).toThrow(/src must be/)
    expect(() => wpBody(vandal, GEN('illustration-vandalism', { src: 'http://insecure.example/x.jpg' }))).toThrow(/src must be/)
    expect(() => wpBody(vandal, GEN('illustration-vandalism', { provenance: 'stock photo' }))).toThrow(/provenance/)
  })
  it('a real shop photo (string shorthand) renders on its slot without the illustration caption', () => {
    const body = wpBody(vandal, { 'vandal-glass-cleanup': `${SITE}/wp-content/uploads/2026/11/real.jpg` })
    expect(body).toMatch(/<img[^>]+real\.jpg/)
    const fig = body.slice(body.indexOf('real.jpg'), body.indexOf('real.jpg') + 400)
    expect(fig).not.toContain(ILLUSTRATION_NOTICE)
  })
  it('the preview labels pending illustrations and optional real-photo slots (not blockers)', () => {
    const preview = previewHtml(vandal)
    expect(preview).toContain('Generated illustration pending (illustration-vandalism)')
    expect(preview).toMatch(/OPTIONAL REAL PHOTO/)
    expect(preview).toContain('NOT publish blockers')
  })
})
