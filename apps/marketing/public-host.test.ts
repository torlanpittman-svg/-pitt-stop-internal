import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { isMarketingPublicHost, publicMarketingRoute } from './public-host'

vi.mock('@/apps/auth/employee-session', () => ({
  EMP_COOKIE: 'ps_emp', employeeAuthConfigured: () => true, verifyEmployeeToken: async () => false,
}))
import { proxy } from '@/proxy'

describe('dedicated public SMS host', () => {
  it('recognizes only the exact customer subdomains', () => {
    expect(isMarketingPublicHost('text.pittstopdetailandautosales.com')).toBe(true)
    expect(isMarketingPublicHost('pitt-stop-internal.vercel.app')).toBe(false)
    expect(isMarketingPublicHost('text.pittstopdetailandautosales.com.attacker.test')).toBe(false)
  })
  it('allows public pages and consent submissions, denying internal routes and APIs', async () => {
    for (const path of ['/sms-opt-in', '/privacy', '/terms']) {
      const r = await proxy(new NextRequest(`https://text.pittstopdetailandautosales.com${path}`))
      expect(r.headers.get('x-middleware-next')).toBe('1')
    }
    for (const path of ['/marketing', '/orders', '/admin', '/api/workflow/orders', '/api/auto-sales/session', '/api/twilio/sms/inbound', '/sw.js', '/manifest.json']) {
      const r = await proxy(new NextRequest(`https://text.pittstopdetailandautosales.com${path}`))
      expect(r.status).toBe(404)
    }
    expect(publicMarketingRoute('/sms-opt-in', 'POST')).toBe('allow')
    expect(publicMarketingRoute('/privacy', 'POST')).toBe('deny')
  })
  it('redirects only the public root to the signup page', async () => {
    const r = await proxy(new NextRequest('https://text.pittstopdetailandautosales.com/?next=/admin'))
    expect(r.headers.get('location')).toBe('https://text.pittstopdetailandautosales.com/sms-opt-in')
  })
})
