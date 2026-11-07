/**
 * Content guardrails for the insurance-restoration landing pages. Every page must: carry qualified insurance
 * language (no coverage / free-repair / deductible / direct-billing promises), have exactly one H1 and unique
 * metadata within length limits, link to the ONE estimate funnel with full attribution, link to the other
 * pages, expose valid FAQ + Service JSON-LD whose text matches the visible FAQ, and ship no fabricated images.
 */
import { describe, it, expect } from 'vitest'
import { PAGES, INSURER_DECIDES, SHOP, BOOK_HOST, SITE } from './pages'
import { wpBody, previewHtml, faqJsonLd, serviceJsonLd, seoSidecar, ctaUrl } from './render'
import { QUOTE_SERVICES, isRestorationService } from '@/apps/marketing/quote-shared'

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

/** Promises the shop must never make. Negations like "We don’t bill your insurance company" are allowed. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bguarantee/i, 'guarantee'],
  [/\bfree (repair|fix|replacement)/i, 'free repair'],
  [/\b(waive|waived|cover|covers|pay|pays|eat|absorb)[a-z]*\s+(your\s+)?deductible/i, 'deductible promise'],
  [/\bwe (can |will |also )?(bill|invoice|charge) (your |the )?insur/i, 'direct billing claim'],
  [/\bno out[- ]of[- ]pocket/i, 'no out-of-pocket'],
  [/\b(is|are|will be|always|fully|100%) covered\b/i, 'unqualified coverage'],
  [/\bapproved claim\b|\bclaim (is|will be) approved/i, 'approval promise'],
  [/\breimburse/i, 'reimbursement promise'],
  [/\bcovered by insurance\b/i, 'unqualified "covered by insurance"'],
  [/\bsame[- ]day guarantee|\bwithin 24 hours\b/i, 'turnaround promise'],
]

describe('insurance-restoration landing pages', () => {
  it('has the five required slugs, one per damage type plus the hub, with unique metadata within limits', () => {
    expect(PAGES.map((p) => p.slug).sort()).toEqual(['auto-glass-repair', 'car-overspray-removal', 'car-vandalism-repair', 'car-water-damage', 'insurance-auto-repair'])
    const titles = new Set(PAGES.map((p) => p.seoTitle)); const descs = new Set(PAGES.map((p) => p.metaDescription)); const h1s = new Set(PAGES.map((p) => p.h1))
    expect(titles.size).toBe(5); expect(descs.size).toBe(5); expect(h1s.size).toBe(5)
    for (const p of PAGES) {
      expect(p.seoTitle.length, `${p.slug} title`).toBeLessThanOrEqual(60)
      expect(p.metaDescription.length, `${p.slug} description`).toBeGreaterThanOrEqual(90)
      expect(p.metaDescription.length, `${p.slug} description`).toBeLessThanOrEqual(160)
      if (p.service) expect(isRestorationService(p.service)).toBe(true)
    }
    const services = PAGES.map((p) => p.service).filter(Boolean).sort()
    expect(services).toEqual(['glass', 'overspray', 'vandalism', 'water_damage'])
  })

  for (const page of PAGES) {
    describe(page.slug, () => {
      const body = wpBody(page)
      const preview = previewHtml(page)
      const visible = text(body)

      it('never promises coverage, free repairs, deductible help, approval, reimbursement or direct billing', () => {
        for (const [re, label] of FORBIDDEN) {
          const m = visible.match(re)
          expect(m, `${label}: "${m?.[0]}" in ${page.slug}`).toBeNull()
        }
        for (const f of page.faqs) for (const [re, label] of FORBIDDEN) expect(f.a.match(re), `${label} in FAQ "${f.q}"`).toBeNull()
      })
      it('states that the insurer decides and that the shop does not bill insurers', () => {
        expect(visible).toContain(INSURER_DECIDES.replace(/\s+/g, ' '))
        expect(visible).toMatch(/We don’t bill your insurance company for you/)
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
        } else {
          // hub: one CTA per damage type, each carrying that type
          for (const p of PAGES.filter((x) => x.service)) expect(body).toContain(`service=${p.service}`)
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
      it('ships no images until real assets are supplied, and the preview labels every missing photo', () => {
        expect(body).not.toMatch(/<img\b/)
        expect(page.photos.length).toBeGreaterThanOrEqual(1)
        for (const ph of page.photos) expect(preview).toContain(ph.id)
        expect(preview.match(/PHOTO NEEDED/g)?.length).toBe(page.photos.length)
        // with a real asset the WP body gets the figure with the caption as alt text
        const withAsset = wpBody(page, { [page.photos[0].id]: `${SITE}/wp-content/uploads/2026/11/x.jpg` })
        expect(withAsset).toContain(`alt="${page.photos[0].caption.replace(/&/g, '&amp;')}"`)
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
      it('has a sidecar with publish steps and the photo list, and the preview is noindex with the real title', () => {
        const sc = seoSidecar(page)
        expect(sc.photosNeeded).toHaveLength(page.photos.length); expect(sc.publishChecklist.length).toBeGreaterThanOrEqual(4); expect(sc.robots).toBe('index, follow')
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

  it('the glass page is explicit that the shop does not replace glass, and the water page separates flood from repairable damage', () => {
    const glass = text(wpBody(PAGES.find((p) => p.slug === 'auto-glass-repair')!))
    expect(glass).toMatch(/not a glass shop/i); expect(glass).toMatch(/We do not repair windshields/)
    const water = text(wpBody(PAGES.find((p) => p.slug === 'car-water-damage')!))
    expect(water).toMatch(/total loss/i); expect(water).toMatch(/Repairable:/); expect(water).toMatch(/Flooded:/)
  })
})
