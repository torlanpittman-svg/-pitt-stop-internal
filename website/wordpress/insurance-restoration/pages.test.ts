/**
 * Content + output guardrails for the insurance-restoration landing pages. Every page must: carry qualified
 * insurance language (no coverage / free-repair / deductible / billing-status promises and no absolute
 * glass-removal or adjuster-meeting promises), have exactly one H1 and unique metadata within length
 * limits, link to the ONE estimate funnel with full attribution, forward incoming allow-listed ad-click
 * parameters (gclid / utm_*) onto CTAs and cross-page links via the shipped script, ship self-contained
 * CSS scoped under `.ps-restore` (no theme dependency, no global leaks), expose valid FAQ + Service
 * JSON-LD matching the visible text, and render images ONLY for supplied manifest assets — generated
 * illustrations always with the visible provenance caption, never on real-photo slots.
 * Live fixes 2026-11-07: the emitted script must contain NO literal ampersand (WordPress entity-encodes
 * script text, a SyntaxError that disabled attribution), and the theme's own data-ps-book booking anchors
 * (mobile bar + header, outside .ps-restore) are retargeted at the page's quote CTA (hub → #types).
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
  // so it must defer to DOMContentLoaded, rewrite markup that appears AFTER it (the preview sticky CTA),
  // and retarget the theme's data-ps-book booking anchors that live OUTSIDE .ps-restore.
  interface FakeAnchor { attrs: Record<string, string>; textContent: string; getAttribute: (k: string) => string | null; setAttribute: (k: string, v: string) => void; removeAttribute: (k: string) => void }
  const anchor = (href: string, attrs: Record<string, string> = {}, text = ''): FakeAnchor => ({
    attrs: { href, ...attrs },
    textContent: text,
    getAttribute(k) { return this.attrs[k] ?? null },
    setAttribute(k, v) { this.attrs[k] = v },
    removeAttribute(k) { delete this.attrs[k] },
  })
  function scriptSrc(page = vandal): string {
    const m = wpBody(page).match(/<script>\n\/\* Pitt Stop attribution pass-through([\s\S]*?)<\/script>/)
    expect(m, 'attribution script present in the WP body').toBeTruthy()
    return `/*${m![1]}`
  }
  function execute(src: string, search: string, pageAnchors: FakeAnchor[], readyState: 'loading' | 'complete', themeAnchors: FakeAnchor[] = []) {
    const listeners: Record<string, Array<() => void>> = {}
    const observerCbs: Array<() => void> = []
    const fakeDocument = {
      readyState,
      documentElement: {}, // lets the MutationObserver attach
      addEventListener(ev: string, fn: () => void) { (listeners[ev] ??= []).push(fn) },
      querySelectorAll(sel: string) {
        if (sel === 'a[data-ps-book]') return themeAnchors.filter((a) => a.attrs['data-ps-book'] !== undefined)
        expect(sel).toBe('.ps-restore a[href]')
        return pageAnchors
      },
    }
    class FakeMutationObserver {
      private cb: () => void
      constructor(cb: () => void) { this.cb = cb }
      observe(target: unknown, opts: Record<string, boolean>) {
        expect(target).toBe(fakeDocument.documentElement)
        expect(opts).toEqual({ childList: true, subtree: true }) // no attribute/characterData observation → no self-trigger on setAttribute
        observerCbs.push(this.cb)
      }
    }
    new Function('document', 'window', 'MutationObserver', src)(fakeDocument, { location: { search } }, FakeMutationObserver)
    return { fire: (ev: string) => (listeners[ev] ?? []).forEach((f) => f()), mutate: () => observerCbs.forEach((f) => f()) }
  }
  it('while the document is still parsing it defers, then rewrites EVERY CTA including the late sticky one', () => {
    const hero = anchor(ctaUrl(vandal, 'hero')); const sticky = anchor(ctaUrl(vandal, 'sticky')); const tel = anchor(`tel:${SHOP.tel}`)
    const { fire } = execute(scriptSrc(), '?gclid=G7&utm_source=google&utm_medium=cpc', [hero, sticky, tel], 'loading')
    expect([hero, sticky, tel].map((a) => a.attrs.href)).toEqual([ctaUrl(vandal, 'hero'), ctaUrl(vandal, 'sticky'), `tel:${SHOP.tel}`]) // nothing touched pre-DOMContentLoaded
    fire('DOMContentLoaded')
    for (const a of [hero, sticky]) {
      const u = new URL(a.attrs.href)
      expect(u.searchParams.get('gclid')).toBe('G7'); expect(u.searchParams.get('utm_source')).toBe('google'); expect(u.searchParams.get('utm_medium')).toBe('cpc')
      expect(u.searchParams.get('service')).toBe('vandalism'); expect(u.searchParams.get('lp')).toBe(vandal.slug)
    }
    expect(new URL(sticky.attrs.href).searchParams.get('utm_content')).toBe(`${vandal.slug}_sticky`) // the sticky CTA carries the click too
    expect(tel.attrs.href).toBe(`tel:${SHOP.tel}`)
  })
  it('runs immediately on an already-complete document, and without incoming params it changes nothing', () => {
    const done = anchor(ctaUrl(vandal, 'hero'))
    execute(scriptSrc(), '?gclid=G7', [done], 'complete')
    expect(new URL(done.attrs.href).searchParams.get('gclid')).toBe('G7') // no listener needed
    const organic = anchor(ctaUrl(vandal, 'hero'))
    execute(scriptSrc(), '', [organic], 'complete')
    expect(organic.attrs.href).toBe(ctaUrl(vandal, 'hero'))
    const hostile = anchor(ctaUrl(vandal, 'hero'))
    execute(scriptSrc(), '?gclid=%3Cscript%3E&utm_source=google', [hostile], 'complete')
    expect(new URL(hostile.attrs.href).searchParams.get('gclid')).toBe('script') // cleaned, not dropped raw
  })

  // ── Live bug 1 (2026-11-07): WordPress entity-encoded `&&` inside the script text (`&#038;&#038;`),
  // a SyntaxError that disabled ALL attribution forwarding on the published pages.
  describe('WordPress ampersand encoding', () => {
    it('every page ships an attribution script with NO literal ampersand anywhere', () => {
      for (const p of PAGES) {
        const m = wpBody(p).match(/<script>\n\/\* Pitt Stop attribution pass-through[\s\S]*?<\/script>/)
        expect(m, p.slug).toBeTruthy()
        expect(m![0].includes('&'), `literal ampersand in the ${p.slug} script`).toBe(false)
      }
      expect(attributionScript().includes('&'), 'page-less export').toBe(false)
    })
    it('survives simulated WP entity-encoding: the transform is a no-op and tracking still forwards', () => {
      const src = scriptSrc()
      const wpEncoded = src.replace(/&/g, '&#038;') // what WordPress does to raw ampersands in script text
      expect(wpEncoded).toBe(src) // nothing left for WordPress to mangle
      const cta = anchor(ctaUrl(vandal, 'hero'))
      execute(wpEncoded, '?gclid=G1&utm_source=google', [cta], 'complete')
      const u = new URL(cta.attrs.href)
      expect(u.searchParams.get('gclid')).toBe('G1')
      expect(u.searchParams.get('utm_source')).toBe('google')
      expect(u.searchParams.get('service')).toBe('vandalism')
      expect(u.searchParams.get('lp')).toBe(vandal.slug)
    })
  })

  // ── Live bug 2 (2026-11-07): Avada injects a fixed mobile booking bar + header booking links OUTSIDE
  // .ps-restore, all pointing at the generic /book page. On these five pages they must point at the
  // page's own quote CTA (hub → #types) without touching phone/external/unrelated links.
  describe('theme booking links (data-ps-book, outside .ps-restore)', () => {
    const themeBar = () => [
      anchor('tel:+19796966640', {}, 'Call'),
      anchor(`${BOOK_HOST}/book?utm_source=website&utm_content=mobile_bar`, { 'data-ps-book': 'mobile_bar' }, 'Book Appointment'),
      anchor(`${BOOK_HOST}/book?utm_source=website&utm_content=sticky_header`, { 'data-ps-book': 'sticky_header', 'aria-label': 'Book an appointment' }, 'Book Appointment'),
      anchor('https://evil.example/book', { 'data-ps-book': 'header' }, 'Book'),
      anchor(`${BOOK_HOST}/quote?service=glass&lp=auto-glass-repair`, { 'data-ps-book': 'header' }, 'Book'),
    ]
    it('service page, organic: book-host /book anchors become this page’s quote CTA labelled Request Estimate; all else untouched', () => {
      const bar = themeBar()
      execute(scriptSrc(vandal), '', [], 'complete', bar)
      for (const a of [bar[1], bar[2]]) {
        const u = new URL(a.attrs.href)
        expect(u.origin + u.pathname).toBe(`${BOOK_HOST}/quote`)
        expect(u.searchParams.get('service')).toBe('vandalism')
        expect(u.searchParams.get('lp')).toBe(vandal.slug)
        expect(u.searchParams.get('utm_source')).toBe('website') // organic stays organic
        expect(a.textContent).toBe('Request Estimate')
      }
      expect(new URL(bar[1].attrs.href).searchParams.get('utm_content')).toBe(`${vandal.slug}_mobile_bar`)
      expect(new URL(bar[2].attrs.href).searchParams.get('utm_content')).toBe(`${vandal.slug}_sticky_header`)
      expect(bar[2].attrs['aria-label']).toBe('Request Estimate')
      // retargeted anchors no longer match the theme's delegated 'a[data-ps-book]' booking-click listener,
      // so the quote funnel never emits the old booking GA4 conversion; untouched anchors keep the attribute
      expect(bar[1].attrs['data-ps-book']).toBeUndefined()
      expect(bar[2].attrs['data-ps-book']).toBeUndefined()
      expect(bar[3].attrs['data-ps-book']).toBe('header')
      expect(bar[4].attrs['data-ps-book']).toBe('header')
      expect(bar[0].attrs.href).toBe('tel:+19796966640'); expect(bar[0].textContent).toBe('Call')          // phone link intact
      expect(bar[3].attrs.href).toBe('https://evil.example/book'); expect(bar[3].textContent).toBe('Book') // wrong host → untouched
      expect(bar[4].attrs.href).toBe(`${BOOK_HOST}/quote?service=glass&lp=auto-glass-repair`)              // /quote, not /book → untouched
    })
    it('paid click: gclid + UTMs are forwarded onto the retargeted CTA; lp/service/email can never leak in', () => {
      const bar = themeBar()
      execute(scriptSrc(vandal), '?gclid=G7&utm_source=google&utm_medium=cpc&lp=evil-page&service=glass&email=a%40b.com', [], 'complete', bar)
      const u = new URL(bar[1].attrs.href)
      expect(u.searchParams.get('gclid')).toBe('G7')
      expect(u.searchParams.get('utm_source')).toBe('google')
      expect(u.searchParams.get('utm_medium')).toBe('cpc')
      expect(u.searchParams.get('lp')).toBe(vandal.slug)      // incoming lp never overrides the page's own
      expect(u.searchParams.get('service')).toBe('vandalism') // nor the service
      expect(u.searchParams.get('email')).toBeNull()          // non-allow-listed PII is never propagated
    })
    it('hub: retargeted to the #types chooser (an in-page anchor keeps the incoming query in the browser)', () => {
      const bar = themeBar()
      execute(scriptSrc(hub), '?gclid=G7', [], 'complete', bar)
      expect(bar[1].attrs.href).toBe('#types')
      expect(bar[1].textContent).toBe('Choose Damage Type')
      expect(bar[1].attrs['data-ps-book']).toBeUndefined() // the old booking-click listener no longer matches
      expect(bar[2].attrs.href).toBe('#types')
      expect(bar[0].attrs.href).toBe('tel:+19796966640')
    })
    it('theme markup inserted AFTER the initial run is corrected by the observer, idempotently (no loops)', () => {
      const bar: FakeAnchor[] = []
      const { mutate } = execute(scriptSrc(vandal), '?gclid=G7', [], 'complete', bar)
      const late = anchor(`${BOOK_HOST}/book?utm_source=website&utm_content=mobile_bar`, { 'data-ps-book': 'mobile_bar' }, 'Book Appointment')
      bar.push(late)
      mutate()
      const first = late.attrs.href
      expect(new URL(first).searchParams.get('gclid')).toBe('G7') // late markup still carries the click
      expect(late.attrs['data-ps-restored']).toBe('1')
      expect(late.attrs['data-ps-book']).toBeUndefined() // the old booking-click listener no longer matches
      expect(late.textContent).toBe('Request Estimate')
      mutate() // the relabel itself fires one childList mutation; the re-scan must change nothing
      expect(late.attrs.href).toBe(first)
    })
    it('the page-less attributionScript() export has no retarget config and leaves theme anchors alone', () => {
      const m = attributionScript().match(/<script>\n\/\* Pitt Stop attribution pass-through([\s\S]*?)<\/script>/)
      expect(m).toBeTruthy()
      const bar = themeBar()
      execute(`/*${m![1]}`, '?gclid=G7', [], 'complete', bar)
      expect(bar[1].attrs.href).toBe(`${BOOK_HOST}/book?utm_source=website&utm_content=mobile_bar`)
      expect(bar[1].textContent).toBe('Book Appointment')
      expect(bar[1].attrs['data-ps-book']).toBe('mobile_bar') // untouched → still a booking link for the theme listener
    })
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
