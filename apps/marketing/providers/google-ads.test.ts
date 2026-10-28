import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import {
  resolveGoogleAdsConfig,
  googleAdsConfigFromEnv,
  googleAdsConfigFingerprint,
  buildServiceAccountJwt,
  fetchAccessToken,
  fetchGoogleAdsReporting,
  type AdFetchResponse,
  type GoogleAdsConfig,
  type FetchLike,
} from './google-ads'

// A real RSA keypair so RS256 signing/verification is exercised without the network.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const CLIENT_EMAIL = 'svc@proj.iam.gserviceaccount.com'
const SA = { client_email: CLIENT_EMAIL, private_key: privateKey }
const SA_JSON = JSON.stringify(SA)
const env = (over: Record<string, string>) => over as unknown as NodeJS.ProcessEnv

function cfg(over: Partial<GoogleAdsConfig> = {}): GoogleAdsConfig {
  return { serviceAccount: SA, customerId: '6843748548', apiVersion: 'v26', campaignCategories: {}, ...over }
}

function resp(body: unknown, status = 200): AdFetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
}

interface MockResponses {
  tokenResp?: AdFetchResponse; token?: unknown; tokenStatus?: number
  account?: unknown; accountStatus?: number
  campaign?: unknown; campaignStatus?: number
}
function mockFetch(r: MockResponses) {
  const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string; redirect?: string; signal?: AbortSignal } }> = []
  const fn = (async (url: string, init: { headers: Record<string, string>; body: string; redirect?: string; signal?: AbortSignal }) => {
    calls.push({ url, init })
    if (url === 'https://oauth2.googleapis.com/token') return r.tokenResp ?? resp(r.token ?? { access_token: 'tok-123' }, r.tokenStatus ?? 200)
    if (url.includes('googleAds:searchStream')) {
      const q = (JSON.parse(init.body) as { query: string }).query
      if (q.includes('FROM customer')) return resp(r.account, r.accountStatus ?? 200)
      return resp(r.campaign, r.campaignStatus ?? 200)
    }
    throw new Error(`unexpected url ${url}`)
  }) as unknown as FetchLike
  return { fn, calls }
}

const ACCOUNT_OK = [{ results: [{ customer: { id: '6843748548', descriptiveName: 'Pitt Stop', currencyCode: 'USD', timeZone: 'America/Chicago' } }] }]
const RANGE = { from: '2026-10-01', to: '2026-10-28' }

describe('resolveGoogleAdsConfig — absent vs invalid vs configured', () => {
  it('is ABSENT only when no reporting env is present at all', () => {
    expect(resolveGoogleAdsConfig(env({})).state).toBe('absent')
  })

  it('is INVALID (never absent/manual) when any reporting env is present but incomplete/malformed', () => {
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: SA_JSON })).error).toBe('config_missing_customer_id')
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_CUSTOMER_ID: '6843748548' })).error).toBe('config_missing_service_account')
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: '{not json', GOOGLE_ADS_CUSTOMER_ID: '6843748548' })).error).toBe('config_bad_service_account_json')
    const noKey = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: 'nope' })
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: noKey, GOOGLE_ADS_CUSTOMER_ID: '6843748548' })).error).toBe('config_bad_private_key')
    const badPem = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: '-----BEGIN PRIVATE KEY-----\nnotbase64\n-----END PRIVATE KEY-----' })
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: badPem, GOOGLE_ADS_CUSTOMER_ID: '6843748548' })).error).toBe('config_bad_private_key')
    // present-but-incomplete is INVALID (never absent → never silently manual)
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: SA_JSON })).state).toBe('invalid')
  })

  it('rejects an id with arbitrary letters rather than stripping them', () => {
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_ADS_CUSTOMER_ID: '68abc43748548' })).error).toBe('config_bad_customer_id')
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_ADS_CUSTOMER_ID: '12345' })).error).toBe('config_bad_customer_id')
  })

  it('rejects an invalid login id, api version, or category map instead of silently ignoring them', () => {
    const base = { GOOGLE_ADS_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_ADS_CUSTOMER_ID: '6843748548' }
    expect(resolveGoogleAdsConfig(env({ ...base, GOOGLE_ADS_LOGIN_CUSTOMER_ID: 'abc' })).error).toBe('config_bad_login_customer_id')
    expect(resolveGoogleAdsConfig(env({ ...base, GOOGLE_ADS_API_VERSION: 'nope' })).error).toBe('config_bad_api_version')
    expect(resolveGoogleAdsConfig(env({ ...base, GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON: '{not json' })).error).toBe('config_bad_category_map')
    expect(resolveGoogleAdsConfig(env({ ...base, GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON: JSON.stringify({ '111': 'nope' }) })).error).toBe('config_bad_category_map')
    expect(resolveGoogleAdsConfig(env({ ...base, GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON: JSON.stringify({ abc: 'ceramic' }) })).error).toBe('config_bad_category_map')
  })

  it('rejects a service-account token_uri that is not the pinned Google endpoint', () => {
    const sneaky = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: privateKey, token_uri: 'https://evil.example.com/token' })
    expect(resolveGoogleAdsConfig(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: sneaky, GOOGLE_ADS_CUSTOMER_ID: '6843748548' })).error).toBe('config_bad_token_uri')
  })

  it('accepts a valid config: documented dashes/spaces in the id, default v26, strict category map', () => {
    const r = resolveGoogleAdsConfig(env({
      GOOGLE_ADS_SERVICE_ACCOUNT_JSON: SA_JSON,
      GOOGLE_ADS_CUSTOMER_ID: '684-374 8548',
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-456-7890',
      GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON: JSON.stringify({ '111': 'ceramic', '333': 'interior' }),
    }))
    expect(r.state).toBe('configured')
    expect(r.config!.customerId).toBe('6843748548')
    expect(r.config!.loginCustomerId).toBe('1234567890')
    expect(r.config!.apiVersion).toBe('v26')
    expect(r.config!.campaignCategories).toEqual({ '111': 'ceramic', '333': 'interior' })
    expect(googleAdsConfigFromEnv(env({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_ADS_CUSTOMER_ID: '6843748548' }))).not.toBeNull()
  })
})

describe('googleAdsConfigFingerprint', () => {
  it('changes on key rotation and on a category-map change, but is stable otherwise', () => {
    const a = googleAdsConfigFingerprint(cfg({ campaignCategories: { '111': 'ceramic' } }))
    const same = googleAdsConfigFingerprint(cfg({ campaignCategories: { '111': 'ceramic' } }))
    const mapChanged = googleAdsConfigFingerprint(cfg({ campaignCategories: { '111': 'interior' } }))
    const rotated = googleAdsConfigFingerprint(cfg({ serviceAccount: { client_email: CLIENT_EMAIL, private_key: generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey } }))
    expect(a).toBe(same)
    expect(a).not.toBe(mapChanged)
    expect(a).not.toBe(rotated)
    expect(a).not.toContain('PRIVATE KEY') // never embeds key material
  })
})

describe('buildServiceAccountJwt', () => {
  it('signs an RS256 JWT with PINNED aud/scope and no private key material (now is milliseconds)', () => {
    const jwt = buildServiceAccountJwt(SA, { now: 1_000_000 })
    const [h, p, sig] = jwt.split('.')
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(claims.iss).toBe(CLIENT_EMAIL)
    expect(claims.scope).toBe('https://www.googleapis.com/auth/adwords')
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token')
    expect(claims.iat).toBe(1000)   // 1_000_000 ms → 1000 s
    expect(claims.exp).toBe(4600)
    const v = createVerify('RSA-SHA256'); v.update(`${h}.${p}`); v.end()
    expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true)
    expect(jwt).not.toContain('PRIVATE KEY')
  })
})

describe('fetchAccessToken', () => {
  it('posts a JWT bearer grant to the PINNED endpoint with redirect:error, returns the token', async () => {
    const { fn, calls } = mockFetch({ token: { access_token: 'ya29.secret' } })
    const token = await fetchAccessToken(cfg(), { fetchImpl: fn, now: 1_000_000 })
    expect(token).toBe('ya29.secret')
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer')
    expect(calls[0].init.body).toContain('assertion=')
  })

  it('throws a sanitized error on a non-ok response (no raw body)', async () => {
    const { fn } = mockFetch({ token: { error: 'invalid_grant', error_description: 'leaky detail' }, tokenStatus: 400 })
    await expect(fetchAccessToken(cfg(), { fetchImpl: fn })).rejects.toThrow('google_ads_token_http_400')
    await expect(fetchAccessToken(cfg(), { fetchImpl: fn })).rejects.not.toThrow(/leaky detail/)
  })

  it('throws when Google returns no access token or unparseable JSON', async () => {
    await expect(fetchAccessToken(cfg(), { fetchImpl: mockFetch({ token: {} }).fn })).rejects.toThrow('google_ads_token_missing')
    await expect(fetchAccessToken(cfg(), { fetchImpl: mockFetch({ tokenResp: resp('not json') }).fn })).rejects.toThrow('google_ads_token_malformed')
  })

  it('aborts a slow body by the deadline rather than hanging', async () => {
    const neverResp: AdFetchResponse = {
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({ pull() { /* never enqueue or close */ } }),
      text: async () => new Promise<string>(() => {}),
    }
    await expect(fetchAccessToken(cfg(), { fetchImpl: mockFetch({ tokenResp: neverResp }).fn, timeoutMs: 20 })).rejects.toThrow('google_ads_timeout')
  })

  it('rejects an over-cap body under the byte limit', async () => {
    const bigResp: AdFetchResponse = {
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(50)); c.close() } }),
      text: async () => 'x'.repeat(50),
    }
    await expect(fetchAccessToken(cfg(), { fetchImpl: mockFetch({ tokenResp: bigResp }).fn, maxResponseBytes: 10 })).rejects.toThrow('google_ads_response_too_large')
  })
})

describe('fetchGoogleAdsReporting', () => {
  it('rolls up by mapped category, buckets unmapped to "other", sums micros before rounding, keeps fractional conversions + raw assigned value', async () => {
    const campaign = [{ results: [
      { campaign: { id: '111', name: 'Ceramic' }, segments: { date: '2026-10-01' }, metrics: { costMicros: '5000', impressions: '10', clicks: '2', conversions: 0.5, conversionsValue: 0.005 } },
      { campaign: { id: '111', name: 'Ceramic' }, segments: { date: '2026-10-02' }, metrics: { costMicros: '5000', impressions: '10', clicks: '2', conversions: 0.5, conversionsValue: 0.005 } },
      { campaign: { id: '999', name: 'Unmapped' }, segments: { date: '2026-10-01' }, metrics: { costMicros: '1235286882', impressions: '100', clicks: '586', conversions: 8.536687, conversionsValue: 6.536687 } },
    ] }]
    const { fn, calls } = mockFetch({ account: ACCOUNT_OK, campaign })
    const res = await fetchGoogleAdsReporting(cfg({ campaignCategories: { '111': 'ceramic' } }), RANGE, { fetchImpl: fn })

    expect(res.account).toEqual({ customerId: '6843748548', name: 'Pitt Stop', currency: 'USD', timeZone: 'America/Chicago', timeZoneMismatch: false })

    const ceramic = res.byCategory.find((c) => c.serviceCategory === 'ceramic')!
    expect(ceramic.spendCents).toBe(1)          // 5000+5000 micros summed THEN rounded (per-row would be 2)
    expect(ceramic.conversions).toBe(1)
    expect(ceramic.conversionValue).toBeCloseTo(0.01, 6) // raw Google-assigned value preserved
    expect(ceramic.revenueCents).toBe(1)         // legacy internal compat

    const other = res.byCategory.find((c) => c.serviceCategory === 'other')!
    expect(other.spendCents).toBe(123529)        // round(1235286882 / 10000)
    expect(other.conversions).toBeCloseTo(8.536687, 6)
    expect(other.conversionValue).toBeCloseTo(6.536687, 6)

    // credential-bearing requests pin redirect:error and carry the bearer token
    const stream = calls.find((c) => c.url.includes('searchStream'))!
    expect(stream.init.headers.Authorization).toBe('Bearer tok-123')
    expect(stream.init.redirect).toBe('error')
    expect(stream.init.headers['login-customer-id']).toBeUndefined()
  })

  it('flags a timezone mismatch without failing', async () => {
    const account = [{ results: [{ customer: { id: '6843748548', descriptiveName: 'X', currencyCode: 'USD', timeZone: 'America/New_York' } }] }]
    const res = await fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account, campaign: [{ results: [] }] }).fn })
    expect(res.account.timeZone).toBe('America/New_York')
    expect(res.account.timeZoneMismatch).toBe(true)
  })

  it('sends login-customer-id when a manager id is configured', async () => {
    const { fn, calls } = mockFetch({ account: ACCOUNT_OK, campaign: [{ results: [] }] })
    await fetchGoogleAdsReporting(cfg({ loginCustomerId: '1234567890' }), RANGE, { fetchImpl: fn })
    expect(calls.find((c) => c.url.includes('searchStream'))!.init.headers['login-customer-id']).toBe('1234567890')
  })

  it('treats an empty-but-well-formed result as a legitimate zero', async () => {
    const res = await fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: [{ results: [] }] }).fn })
    expect(res.byCategory).toEqual([])
  })

  it('rejects a non-USD account and a different customer id', async () => {
    const eur = [{ results: [{ customer: { id: '6843748548', currencyCode: 'EUR', timeZone: 'America/Chicago' } }] }]
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: eur, campaign: [{ results: [] }] }).fn })).rejects.toThrow('google_ads_unsupported_currency')
    const wrong = [{ results: [{ customer: { id: '9999999999', currencyCode: 'USD' } }] }]
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: wrong, campaign: [{ results: [] }] }).fn })).rejects.toThrow('google_ads_customer_mismatch')
  })

  it('rejects malformed metrics: present null, empty string, boolean, non-numeric, negative, non-integer count', async () => {
    const bad = (metrics: unknown) => [{ results: [{ campaign: { id: '111', name: 'C' }, segments: { date: '2026-10-01' }, metrics }] }]
    for (const metrics of [
      { costMicros: null, impressions: '1', clicks: '1', conversions: 1, conversionsValue: 1 },
      { costMicros: '', impressions: '1', clicks: '1', conversions: 1, conversionsValue: 1 },
      { costMicros: true, impressions: '1', clicks: '1', conversions: 1, conversionsValue: 1 },
      { costMicros: 'abc', impressions: '1', clicks: '1', conversions: 1, conversionsValue: 1 },
      { costMicros: '-5', impressions: '1', clicks: '1', conversions: 1, conversionsValue: 1 },
      { costMicros: '10', impressions: '1.5', clicks: '1', conversions: 1, conversionsValue: 1 }, // impressions must be integer
    ]) {
      await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: bad(metrics) }).fn })).rejects.toThrow('google_ads_bad_metric')
    }
  })

  it('treats OMITTED metric fields as proto3 zero (not malformed)', async () => {
    const campaign = [{ results: [{ campaign: { id: '111', name: 'C' }, segments: { date: '2026-10-01' }, metrics: { clicks: '3' } }] }]
    const res = await fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign }).fn })
    const other = res.byCategory.find((c) => c.serviceCategory === 'other')!
    expect(other).toMatchObject({ spendCents: 0, impressions: 0, clicks: 3, conversions: 0, conversionValue: 0 })
  })

  it('rejects a non-numeric campaign id and a date outside the requested range', async () => {
    const badId = [{ results: [{ campaign: { id: 'abc', name: 'C' }, segments: { date: '2026-10-01' }, metrics: { costMicros: '1' } }] }]
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: badId }).fn })).rejects.toThrow('google_ads_malformed_response')
    const outOfRange = [{ results: [{ campaign: { id: '111', name: 'C' }, segments: { date: '2026-11-15' }, metrics: { costMicros: '1' } }] }]
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: outOfRange }).fn })).rejects.toThrow('google_ads_date_out_of_range')
  })

  it('surfaces a sanitized HTTP error (no raw body) and rejects a non-array payload', async () => {
    const permResponses = { account: ACCOUNT_OK, campaign: { error: { message: 'PERMISSION_DENIED for 6843748548' } }, campaignStatus: 403 }
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch(permResponses).fn })).rejects.toThrow('google_ads_http_403')
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch(permResponses).fn })).rejects.not.toThrow(/PERMISSION_DENIED/)
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: { results: 'nope' }, campaign: [{ results: [] }] }).fn })).rejects.toThrow('google_ads_malformed_response')
  })

  it('validates the date range before any fetch', async () => {
    const { fn, calls } = mockFetch({ account: ACCOUNT_OK, campaign: [{ results: [] }] })
    await expect(fetchGoogleAdsReporting(cfg(), { from: '2026-10-28', to: '2026-10-01' }, { fetchImpl: fn })).rejects.toThrow('google_ads_bad_range')
    await expect(fetchGoogleAdsReporting(cfg(), { from: '2026-02-30', to: '2026-03-01' }, { fetchImpl: fn })).rejects.toThrow('google_ads_bad_date')
    expect(calls).toHaveLength(0)
  })

  it('rejects array/non-record shapes for metrics, campaign, or segments (never a false zero)', async () => {
    const withMetrics = (metrics: unknown) => [{ results: [{ campaign: { id: '111', name: 'C' }, segments: { date: '2026-10-01' }, metrics }] }]
    // metrics: [] is an array, not a record — must reject, not read every field as 0.
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: withMetrics([]) }).fn })).rejects.toThrow('google_ads_malformed_response')
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: withMetrics('oops') }).fn })).rejects.toThrow('google_ads_malformed_response')
    const campaignArray = [{ results: [{ campaign: [], segments: { date: '2026-10-01' }, metrics: { costMicros: '1' } }] }]
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: campaignArray }).fn })).rejects.toThrow('google_ads_malformed_response')
    const segmentsArray = [{ results: [{ campaign: { id: '111' }, segments: [], metrics: { costMicros: '1' } }] }]
    await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: segmentsArray }).fn })).rejects.toThrow('google_ads_malformed_response')
  })

  it('enforces aggregate count bounds across summed rows (impressions/clicks/conversions)', async () => {
    // Each per-row value is within MAX_COUNT (1e12) but the SUM across two rows exceeds it.
    const twoRows = (field: 'impressions' | 'clicks' | 'conversions') => [{ results: [
      { campaign: { id: '111', name: 'C' }, segments: { date: '2026-10-01' }, metrics: { [field]: 1e12 } },
      { campaign: { id: '111', name: 'C' }, segments: { date: '2026-10-02' }, metrics: { [field]: 1e12 } },
    ] }]
    for (const field of ['impressions', 'clicks', 'conversions'] as const) {
      await expect(fetchGoogleAdsReporting(cfg(), RANGE, { fetchImpl: mockFetch({ account: ACCOUNT_OK, campaign: twoRows(field) }).fn })).rejects.toThrow('google_ads_overflow')
    }
  })
})
