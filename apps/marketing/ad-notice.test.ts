import { describe, it, expect } from 'vitest'
import { adNoticeContent, unavailableAdGuidance } from './ad-notice'
import type { AdDataMeta } from './ads-reporting'

const account = (over: Partial<NonNullable<AdDataMeta['account']>> = {}) => ({
  customerId: '6843748548', name: 'Pitt Stop', currency: 'USD', timeZone: 'America/Chicago', timeZoneMismatch: false, ...over,
})
const meta = (over: Partial<AdDataMeta>): AdDataMeta => ({
  status: 'manual', source: 'manual_entry', fetchedAt: null, error: null, errorKind: null, account: null, ...over,
})

describe('adNoticeContent', () => {
  it('live: status note that conversion value is Google-assigned, not revenue', () => {
    const c = adNoticeContent(meta({ status: 'live', source: 'google_ads_api', fetchedAt: '2026-10-28T20:00:00Z', account: account() }))
    expect(c.role).toBe('status')
    expect(c.tone).toBe('live')
    expect(c.body).toMatch(/not Pitt Stop invoiced or collected revenue/)
    expect(c.body).toMatch(/conversion value/i)
  })

  it('live: discloses an account timezone mismatch', () => {
    const c = adNoticeContent(meta({ status: 'live', source: 'google_ads_api', account: account({ timeZone: 'America/New_York', timeZoneMismatch: true }) }))
    expect(c.body).toMatch(/America\/New_York/)
    expect(c.body).toMatch(/America\/Chicago/)
  })

  it('manual: explains figures are manually entered', () => {
    const c = adNoticeContent(meta({ status: 'manual' }))
    expect(c.role).toBe('status')
    expect(c.heading).toMatch(/not connected/i)
    expect(c.body).toMatch(/manually/)
  })

  it('config error: ALERT needing setup attention — never "clears itself"', () => {
    const c = adNoticeContent(meta({ status: 'unavailable', source: 'google_ads_api', error: 'config_bad_customer_id', errorKind: 'config' }))
    expect(c.role).toBe('alert')
    expect(c.heading).toMatch(/needs configuration/i)
    expect(c.body).toMatch(/setup attention/i)
    expect(c.body).not.toMatch(/clear/i)
    expect(c.body).not.toMatch(/reload/i)
  })

  it('auth error: setup attention, explicitly will not clear on its own', () => {
    const c = adNoticeContent(meta({ status: 'unavailable', source: 'google_ads_api', error: 'google_ads_http_403', errorKind: 'auth' }))
    expect(c.heading).toMatch(/needs attention/i)
    expect(c.body).toMatch(/will not clear on its own/i)
  })

  it('quota error: rate-limited, no automatic retries', () => {
    const c = adNoticeContent(meta({ status: 'unavailable', source: 'google_ads_api', error: 'google_ads_http_429', errorKind: 'quota' }))
    expect(c.heading).toMatch(/rate-limited/i)
    expect(c.body).toMatch(/no automatic retries/i)
  })

  it('transient error: temporary, reload shortly — ad figures hidden, shop data unaffected', () => {
    const c = adNoticeContent(meta({ status: 'unavailable', source: 'google_ads_api', error: 'google_ads_timeout', errorKind: 'transient' }))
    expect(c.heading).toMatch(/temporarily unavailable/i)
    expect(c.body).toMatch(/reload/i)
    expect(c.body).toMatch(/shop job and lead data is unaffected/i)
  })
})

describe('unavailableAdGuidance — never prompts launch/import as the fix', () => {
  const kinds = ['config', 'auth', 'quota', 'transient', null] as const
  for (const kind of kinds) {
    it(`${kind ?? 'unknown'} guidance gives no launch/import remedy`, () => {
      const g = unavailableAdGuidance(kind)
      expect(g.length).toBeGreaterThan(0)
      // It must NOT direct the owner to run a campaign or import metrics to resolve an outage/misconfig.
      expect(g).not.toMatch(/run a campaign/i)
      expect(g).not.toMatch(/import .*(metrics|google ads data)/i)
      expect(g).not.toMatch(/populate this report/i)
    })
  }
  it('config: points at fixing connection settings; auth: will not clear on its own', () => {
    expect(unavailableAdGuidance('config')).toMatch(/misconfigured|connection settings/i)
    expect(unavailableAdGuidance('auth')).toMatch(/will not clear on its own/i)
  })
  it('quota: returns on its own, no action needed; transient: reload', () => {
    expect(unavailableAdGuidance('quota')).toMatch(/rate-limited/i)
    expect(unavailableAdGuidance('quota')).toMatch(/no action/i)
    expect(unavailableAdGuidance('transient')).toMatch(/reload/i)
  })
})
