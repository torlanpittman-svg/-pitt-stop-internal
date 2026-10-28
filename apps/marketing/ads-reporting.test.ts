import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'

// adMetricsByCategory (the manual-entry source) is mocked so we can prove it is used ONLY when
// the config is ABSENT — never for an INVALID config and never as a fallback for a failed fetch.
vi.mock('./ads', () => ({
  adMetricsByCategory: vi.fn(async () => [
    { serviceCategory: 'ceramic', spendCents: 100, impressions: 1, clicks: 1, conversions: 1, revenueCents: 200 },
  ]),
}))
import { adMetricsByCategory } from './ads'
import { loadAdReporting, classifyAdError, __resetAdReportingCacheForTests } from './ads-reporting'
import type { AdFetchResponse, FetchLike } from './providers/google-ads'

const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey
const saJson = (pk: string) => JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: pk })
const PK1 = key()
const envFor = (over: Record<string, string>) => over as unknown as NodeJS.ProcessEnv
const CONFIGURED = envFor({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: saJson(PK1), GOOGLE_ADS_CUSTOMER_ID: '6843748548' })
const RANGE = { from: '2026-10-01', to: '2026-10-28' }

function resp(body: unknown, status = 200): AdFetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}
const ACCOUNT_OK = [{ results: [{ customer: { id: '6843748548', descriptiveName: 'Pitt Stop', currencyCode: 'USD', timeZone: 'America/Chicago' } }] }]
const DEFAULT_CAMPAIGN = [{ results: [
  { campaign: { id: '111', name: 'C' }, segments: { date: '2026-10-01' }, metrics: { costMicros: '1000000', impressions: '5', clicks: '3', conversions: 2, conversionsValue: 4.25 } },
] }]

/** A fetch that counts report fetches (via token calls) and can be scripted per attempt. */
function countingFetch(opts: { tokenStatus?: () => number; campaign?: unknown } = {}): { fn: FetchLike; tokenCalls: () => number } {
  let tokenCalls = 0
  const fn = (async (url: string, init: { body: string }) => {
    if (url.includes('/token')) {
      const status = opts.tokenStatus ? opts.tokenStatus() : 200
      tokenCalls++
      return resp({ access_token: 'tok' }, status)
    }
    const q = (JSON.parse(init.body) as { query: string }).query
    if (q.includes('FROM customer')) return resp(ACCOUNT_OK)
    return resp(opts.campaign ?? DEFAULT_CAMPAIGN)
  }) as unknown as FetchLike
  return { fn, tokenCalls: () => tokenCalls }
}
const throwingFetch = (() => { throw new Error('must not fetch') }) as unknown as FetchLike

beforeEach(() => { vi.clearAllMocks(); __resetAdReportingCacheForTests() })

describe('classifyAdError', () => {
  it('maps codes to actionable kinds', () => {
    expect(classifyAdError('config_bad_customer_id')).toBe('config')
    expect(classifyAdError('google_ads_unsupported_currency')).toBe('config')
    expect(classifyAdError('google_ads_customer_mismatch')).toBe('config')
    expect(classifyAdError('google_ads_token_http_401')).toBe('auth')
    expect(classifyAdError('google_ads_http_403')).toBe('auth')
    expect(classifyAdError('google_ads_http_429')).toBe('quota')
    expect(classifyAdError('google_ads_network_error')).toBe('transient')
    expect(classifyAdError('google_ads_timeout')).toBe('transient')
  })
})

describe('loadAdReporting — provenance', () => {
  it('ABSENT config → manual data (reads the manual table)', async () => {
    const r = await loadAdReporting(RANGE, { env: envFor({}) })
    expect(r.meta.status).toBe('manual')
    expect(r.byCategory).toHaveLength(1)
    expect(adMetricsByCategory).toHaveBeenCalledOnce()
  })

  it('INVALID config → unavailable/config, with NO fetch and NO manual read', async () => {
    const r = await loadAdReporting(RANGE, { env: envFor({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: saJson(PK1), GOOGLE_ADS_CUSTOMER_ID: 'bad' }), fetchImpl: throwingFetch })
    expect(r.meta.status).toBe('unavailable')
    expect(r.meta.errorKind).toBe('config')
    expect(r.meta.error).toBe('config_bad_customer_id')
    expect(r.byCategory).toEqual([])
    expect(adMetricsByCategory).not.toHaveBeenCalled()
  })

  it('live success → live, raw assigned value preserved, manual NOT read', async () => {
    const r = await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: countingFetch().fn, now: 1_000_000 })
    expect(r.meta.status).toBe('live')
    expect(r.meta.account?.customerId).toBe('6843748548')
    expect(r.byCategory[0].spendCents).toBe(100)       // 1,000,000 micros = $1.00
    expect(r.byCategory[0].conversionValue).toBeCloseTo(4.25, 6)
    expect(adMetricsByCategory).not.toHaveBeenCalled()
  })

  it('auth / quota / transient failures classify correctly and never fall back to manual', async () => {
    const auth = await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: countingFetch({ tokenStatus: () => 401 }).fn })
    expect(auth.meta.status).toBe('unavailable')
    expect(auth.meta.error).toBe('google_ads_token_http_401')
    expect(auth.meta.errorKind).toBe('auth')

    const quota = await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: countingFetch({ tokenStatus: () => 429 }).fn })
    expect(quota.meta.errorKind).toBe('quota')

    const transient = await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: countingFetch({ tokenStatus: () => 503 }).fn })
    expect(transient.meta.errorKind).toBe('transient')

    expect(adMetricsByCategory).not.toHaveBeenCalled()
  })

  it('empty live result is a legitimate zero', async () => {
    const r = await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: countingFetch({ campaign: [{ results: [] }] }).fn })
    expect(r.meta.status).toBe('live')
    expect(r.byCategory).toEqual([])
  })
})

describe('loadAdReporting — cache', () => {
  it('serves a repeat call from cache within the TTL, refetches after expiry', async () => {
    const c = countingFetch()
    await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: c.fn, now: 1_000_000 })
    await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: c.fn, now: 1_000_000 + 60_000 }) // +1 min → cached
    expect(c.tokenCalls()).toBe(1)
    await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: c.fn, now: 1_000_000 + 6 * 60_000 }) // +6 min → expired
    expect(c.tokenCalls()).toBe(2)
  })

  it('coalesces identical concurrent requests into one upstream fetch', async () => {
    const c = countingFetch()
    await Promise.all([
      loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: c.fn, now: 2_000_000 }),
      loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: c.fn, now: 2_000_000 }),
    ])
    expect(c.tokenCalls()).toBe(1)
  })

  it('key rotation and a category-map change bust the cache', async () => {
    const c = countingFetch()
    await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: c.fn, now: 3_000_000 })
    // same range/time but a different private key → different fingerprint → refetch
    await loadAdReporting(RANGE, { env: envFor({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: saJson(key()), GOOGLE_ADS_CUSTOMER_ID: '6843748548' }), fetchImpl: c.fn, now: 3_000_000 })
    // same key but a changed category map → different fingerprint → refetch
    await loadAdReporting(RANGE, { env: envFor({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: saJson(PK1), GOOGLE_ADS_CUSTOMER_ID: '6843748548', GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON: JSON.stringify({ '111': 'ceramic' }) }), fetchImpl: c.fn, now: 3_000_000 })
    expect(c.tokenCalls()).toBe(3)
  })

  it('never caches a failed fetch — the next call retries and can succeed', async () => {
    let attempt = 0
    const c = countingFetch({ tokenStatus: () => (++attempt === 1 ? 500 : 200) })
    const first = await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: c.fn, now: 4_000_000 })
    expect(first.meta.status).toBe('unavailable')
    const second = await loadAdReporting(RANGE, { env: CONFIGURED, fetchImpl: c.fn, now: 4_000_000 })
    expect(second.meta.status).toBe('live')
    expect(c.tokenCalls()).toBe(2)
  })
})
