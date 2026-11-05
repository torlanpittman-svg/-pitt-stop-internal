import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPublicAnalyticsPath, sanitizedPageLocation, sanitizedPageReferrer, initBookAnalytics, type AnalyticsWindow } from './analytics'

const ORIGIN = 'https://book.pittstopdetailandautosales.com'

function fakeWindow(pathname: string, referrer = ''): AnalyticsWindow {
  return { location: { origin: ORIGIN, pathname }, document: { referrer } }
}

/** dataLayer holds `arguments` objects; normalize to arrays for assertions. */
function pushed(w: AnalyticsWindow): unknown[][] {
  return (w.dataLayer ?? []).map((e) => Array.from(e as ArrayLike<unknown>))
}

describe('isPublicAnalyticsPath', () => {
  it('allows exactly the public booking and quote pages', () => {
    expect(isPublicAnalyticsPath('/book')).toBe(true)
    expect(isPublicAnalyticsPath('/book/')).toBe(true)
    expect(isPublicAnalyticsPath('/quote')).toBe(true)
  })
  it('refuses private token routes and everything else', () => {
    expect(isPublicAnalyticsPath('/book/a/AbC123-manage-token')).toBe(false)
    expect(isPublicAnalyticsPath('/book/r/AbC123-resume-token')).toBe(false)
    expect(isPublicAnalyticsPath('/book/a')).toBe(false)
    expect(isPublicAnalyticsPath('/booking')).toBe(false)
    expect(isPublicAnalyticsPath('/quote/x')).toBe(false)
    expect(isPublicAnalyticsPath('/')).toBe(false)
    expect(isPublicAnalyticsPath('')).toBe(false)
    expect(isPublicAnalyticsPath(null)).toBe(false)
    expect(isPublicAnalyticsPath(undefined)).toBe(false)
  })
})

describe('initBookAnalytics — private routes never initialize tracking', () => {
  it('does nothing on a private manage/cancel link', () => {
    const w = fakeWindow('/book/a/SECRET-TOKEN')
    expect(initBookAnalytics(['G-1'], w)).toBe(0)
    expect(w.dataLayer).toBeUndefined()
    expect(w.gtag).toBeUndefined()
  })
  it('does nothing on a private resume link', () => {
    const w = fakeWindow('/book/r/SECRET-TOKEN')
    expect(initBookAnalytics(['G-1', 'AW-2'], w)).toBe(0)
    expect(w.dataLayer).toBeUndefined()
    expect(w.gtag).toBeUndefined()
  })
  it('does nothing when no tag id is configured', () => {
    const w = fakeWindow('/book')
    expect(initBookAnalytics([], w)).toBe(0)
    expect(w.dataLayer).toBeUndefined()
  })
})

describe('initBookAnalytics — public pages get only sanitized values', () => {
  it('disables automatic page_views and sends one explicit sanitized page_view', () => {
    const w = fakeWindow('/book', 'https://www.google.com/search?q=jane+doe+pitt+stop')
    expect(initBookAnalytics(['G-1', 'AW-2'], w)).toBe(2)
    const entries = pushed(w)
    const page = { page_location: `${ORIGIN}/book`, page_referrer: 'https://www.google.com' }
    const configs = entries.filter((e) => e[0] === 'config')
    expect(configs.map((e) => e[1])).toEqual(['G-1', 'AW-2'])
    for (const [, , params] of configs) expect(params).toEqual({ ...page, send_page_view: false })
    const views = entries.filter((e) => e[0] === 'event' && e[1] === 'page_view')
    expect(views).toEqual([['event', 'page_view', page]])
  })
  it('drops a same-origin referrer entirely (it can be a private token URL)', () => {
    const w = fakeWindow('/book', `${ORIGIN}/book/a/SECRET-TOKEN`)
    initBookAnalytics(['G-1'], w)
    for (const [, , params] of pushed(w).filter((e) => e[0] === 'config' || e[1] === 'page_view')) {
      expect(params).toMatchObject({ page_referrer: '' })
    }
  })
  it('initializes once per document even if the layout remounts', () => {
    const w = fakeWindow('/quote')
    expect(initBookAnalytics(['G-1'], w)).toBe(1)
    expect(initBookAnalytics(['G-1'], w)).toBe(0)
    expect(pushed(w).filter((e) => e[0] === 'config')).toHaveLength(1)
  })
})

describe('sanitizers', () => {
  it('page_location never carries a querystring or hash, whatever the caller held', () => {
    expect(sanitizedPageLocation({ origin: ORIGIN, pathname: '/book' })).toBe(`${ORIGIN}/book`)
    expect(sanitizedPageLocation({ origin: ORIGIN, pathname: '/quote/' })).toBe(`${ORIGIN}/quote`)
  })
  it('cross-origin referrers keep the origin only — a foreign path can itself carry a token', () => {
    expect(sanitizedPageReferrer('https://alias.example.com/book/a/SECRET-TOKEN?x=1', ORIGIN)).toBe('https://alias.example.com')
  })
  it('never throws on an empty or malformed referrer', () => {
    expect(sanitizedPageReferrer('', ORIGIN)).toBe('')
    expect(sanitizedPageReferrer('not a url', ORIGIN)).toBe('')
    expect(sanitizedPageReferrer(null, ORIGIN)).toBe('')
  })
})

/**
 * The path gate is only sound while every transition between public (/book, /quote) and private
 * token routes is a HARD document navigation: a client-side navigation (next/link, router.push)
 * would carry an already-loaded gtag onto a token URL, where enhanced-measurement history events
 * could report it. These source scans fail the moment someone introduces client navigation on the
 * booking surfaces, forcing a conscious decision about the analytics boundary.
 */
describe('public/private navigation boundary stays hard', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const surfaces = [here, join(here, '..', 'quote')]
  const sources = surfaces.flatMap((dir) =>
    (readdirSync(dir, { recursive: true }) as string[])
      .filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.includes('.test.'))
      .map((rel) => {
        const path = join(dir, rel)
        return { path, text: readFileSync(path, 'utf8') }
      }),
  )

  it('scans the booking and quote surfaces', () => {
    expect(sources.map((s) => s.path).some((p) => p.endsWith('BookingFlow.tsx'))).toBe(true)
    expect(sources.map((s) => s.path).some((p) => p.endsWith('QuoteForm.tsx'))).toBe(true)
  })
  it('no next/link or router.push on any booking/quote surface', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/from ['"]next\/link['"]/)
      expect(text, path).not.toMatch(/router\.(push|replace)\(/)
    }
  })
  it('the gtag script is referenced only by the gated BookAnalytics component', () => {
    const loaders = sources.filter(({ text }) => text.includes('googletagmanager'))
    expect(loaders.map(({ path }) => path.split('/').pop())).toEqual(['BookAnalytics.tsx'])
  })
  it('the shared layout mounts the gated component (quote re-exports this layout)', () => {
    const layout = readFileSync(join(here, 'layout.tsx'), 'utf8')
    expect(layout).toContain('<BookAnalytics />')
  })
})
