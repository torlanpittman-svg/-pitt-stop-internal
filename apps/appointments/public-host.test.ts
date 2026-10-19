import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { BOOKING_PUBLIC_HOSTS, isBookingPublicHost, publicBookingRoute } from './public-host'
import { classifySource, cleanAttribution, attributionConfidence, campaignIdFrom } from './attribution'
import { ATTRIBUTION_SOURCES, REPORT_CHANNEL_LABELS, reportChannelForSource } from '@/apps/marketing/types'

vi.mock('@/apps/auth/employee-session', () => ({
  EMP_COOKIE: 'ps_emp', employeeAuthConfigured: () => true, verifyEmployeeToken: async () => false,
}))
import { proxy, config } from '@/proxy'

const TOKEN = 'A'.repeat(32)

describe('dedicated booking host', () => {
  it('recognizes only the exact booking subdomain', () => {
    expect(isBookingPublicHost('book.pittstopdetailandautosales.com')).toBe(true)
    expect(isBookingPublicHost('BOOK.pittstopdetailandautosales.com:443')).toBe(true)
    expect(isBookingPublicHost('book.pittstopdetailandautosales.com.attacker.test')).toBe(false)
    expect(isBookingPublicHost('pitt-stop-internal.vercel.app')).toBe(false)
    expect(isBookingPublicHost('book.pittstopdetail.com')).toBe(true)
    expect(isBookingPublicHost('book.pittstopdetail.com.attacker.test')).toBe(false)
    expect(isBookingPublicHost('www.pittstopdetail.com')).toBe(false)
    expect(isBookingPublicHost('pittstopdetail.com')).toBe(false)
  })

  it('the proxy runs on every booking host (matcher covers each one)', () => {
    const hostValues = config.matcher.flatMap((m) => (typeof m === 'string' ? [] : m.has?.map((h) => h.value) ?? []))
    for (const host of BOOKING_PUBLIC_HOSTS) expect(hostValues.some((v) => new RegExp(`^${v}$`).test(host)), host).toBe(true)
  })

  it.each(BOOKING_PUBLIC_HOSTS)('%s serves only booking pages + their APIs; everything internal is 404', async (host) => {
    for (const path of ['/book', `/book/a/${TOKEN}`, '/api/book/availability', `/api/book/a/${TOKEN}/ics`, '/privacy', '/terms']) {
      const r = await proxy(new NextRequest(`https://${host}${path}`))
      expect(r.headers.get('x-middleware-next'), path).toBe('1')
    }
    for (const path of ['/appointments', '/appointments/settings', '/work-board', '/orders', '/customers', '/admin', '/auto-sales/login',
      '/api/workflow/orders', '/api/search', '/api/customers/search', '/sms-opt-in', '/book/a/short', `/api/book/a/${TOKEN}/cancel`]) {
      const r = await proxy(new NextRequest(`https://${host}${path}`))
      expect(r.status, path).toBe(404)
    }
    expect(publicBookingRoute('/api/book/appointments', 'POST')).toBe('allow')
    expect(publicBookingRoute('/api/book/appointments', 'GET')).toBe('deny')
    expect(publicBookingRoute(`/api/book/a/${TOKEN}/cancel`, 'POST')).toBe('allow')
  })

  it.each(BOOKING_PUBLIC_HOSTS)('%s redirects the bare host to the booking page', async (host) => {
    const r = await proxy(new NextRequest(`https://${host}/`))
    expect(r.headers.get('location')).toBe(`https://${host}/book`)
  })
})

describe('staff appointment admin stays private on the app domain', () => {
  it('an anonymous visitor cannot open the appointments pages or settings', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'test-admin-password') // production-like: no open dev fallback
    for (const path of ['/appointments', '/appointments/new', '/appointments/settings', '/appointments/11111111-1111-1111-1111-111111111111']) {
      const r = await proxy(new NextRequest(`https://pitt-stop-internal.vercel.app${path}`))
      expect(r.status, path).toBe(307)
      expect(r.headers.get('location')).toContain('/auto-sales/login')
    }
  })
})

describe('public booking on the app domain', () => {
  it('/book and /api/book/* are outside the employee/admin matcher (customers never see a PIN prompt)', () => {
    const paths = config.matcher.filter((m): m is string => typeof m === 'string')
    expect(paths.some((m) => m.startsWith('/book') || m.startsWith('/api/book'))).toBe(false)
    expect(paths).toContain('/appointments/:path*')
  })
})

describe('booking attribution', () => {
  it('maps campaign parameters onto Marketing Agent sources and never fakes one', () => {
    expect(classifySource({})).toBe('unknown')
    expect(attributionConfidence({})).toBe('unknown')
    expect(classifySource({ gclid: 'x' })).toBe('google_ads')
    expect(classifySource({ utm_source: 'google', utm_medium: 'cpc' })).toBe('google_ads')
    expect(classifySource({ utm_source: 'gbp' })).toBe('google_organic')
    expect(classifySource({ utm_source: 'facebook', utm_medium: 'paid' })).toBe('facebook_paid')
    expect(classifySource({ utm_source: 'instagram' })).toBe('facebook_organic')
    expect(classifySource({ utm_source: 'email', utm_campaign: 'fall' })).toBe('email')
    expect(classifySource({ utm_medium: 'sms' })).toBe('sms')
    expect(attributionConfidence({ gclid: 'x' })).toBe('direct')
    expect(classifySource({ utm_source: 'website' })).toBe('website')
    expect(classifySource({ utm_source: 'Website' })).toBe('website')
    expect(attributionConfidence({ utm_source: 'website' })).toBe('direct')
    expect(classifySource({ utm_source: 'website', gclid: 'x' })).toBe('google_ads') // a paid click still wins
    expect(classifySource({ utm_source: 'websites' })).toBe('unknown')
  })

  it('website is a Marketing source with its own Website report channel; Google/GBP unchanged', () => {
    expect(ATTRIBUTION_SOURCES).toContain('website')
    expect(reportChannelForSource('website')).toBe('website')
    expect(REPORT_CHANNEL_LABELS[reportChannelForSource('website')]).toBe('Website')
    expect(reportChannelForSource('google_organic')).toBe('organic')
    expect(reportChannelForSource('google_ads')).toBe('google_ads')
    expect(reportChannelForSource('unknown')).toBe('other')
  })

  it('keeps only known, short, printable parameters', () => {
    const a = cleanAttribution({ utm_source: 'google<script>', evil: 'x', gclid: 'a'.repeat(500), utm_medium: 7 })
    expect(a).toEqual({ utm_source: 'googlescript', gclid: 'a'.repeat(120) })
    expect(campaignIdFrom({ ps_cid: 'not-a-uuid' })).toBeNull()
    expect(campaignIdFrom({ ps_cid: '11111111-1111-4111-8111-111111111111' })).toBe('11111111-1111-4111-8111-111111111111')
  })
})
