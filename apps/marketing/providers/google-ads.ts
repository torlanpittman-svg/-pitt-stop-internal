/**
 * Google Ads READ-ONLY reporting client.
 *
 * Auth model (2026): a Google Cloud **service account** with read-only access to the Ads account,
 * authorized via an OAuth 2.0 JWT bearer grant. No developer token is used — Google officially
 * sunset developer tokens on 2026-09-09 (see docs). We sign an RS256 JWT with the service account's
 * private key (iss = client_email, aud = the PINNED token endpoint, scope = adwords), exchange it at
 * https://oauth2.googleapis.com/token for an access token, then call the Ads API `searchStream`.
 *
 * Boundaries (credential safety):
 *   • The OAuth token endpoint AND the JWT `aud` are PINNED to https://oauth2.googleapis.com/token.
 *     A service-account JSON that supplies a DIFFERENT token_uri is rejected as a config error — a
 *     supplied value can never redirect the credential-bearing request elsewhere.
 *   • The Ads API host is fixed (https://googleads.googleapis.com); only the validated `vNN` version
 *     and the numeric customer id vary in the path.
 *   • Credential-bearing requests use `redirect: 'error'` so a 3xx cannot bounce the bearer token to
 *     an arbitrary destination.
 *   • SERVER-ONLY: this module reads key material from env and NEVER logs it, returns it, embeds it
 *     in an error, or places it in a cache key. It is imported only by server code.
 *
 * Money: metrics.cost_micros is micros of the account currency (1 cent = 10,000 micros); we SUM
 * micros across a rollup and round ONCE to cents (no per-row rounding error). metrics.conversions and
 * metrics.conversions_value are doubles — fractional values are preserved; "conversion value" is a
 * Google-ASSIGNED value, NOT Pitt Stop invoiced/collected revenue.
 */
import { createSign, createHash, createPrivateKey } from 'node:crypto'
import { ACCOUNT_TIME_ZONE } from '../ad-dates'
import { SERVICE_CATEGORIES, type ServiceCategory } from '../types'
import type { CategoryAdRollup } from '../ads'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const ADS_API_HOST = 'https://googleads.googleapis.com'
const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const DEFAULT_API_VERSION = 'v26'

const DEFAULT_TIMEOUT_MS = 15_000        // whole-request deadline (incl. bounded body read)
const DEFAULT_MAX_RESPONSE_BYTES = 8_000_000 // byte cap on a single response body
const MAX_RESULT_ROWS = 50_000           // row cap: refuse an implausibly large payload
const MAX_RANGE_DAYS = 400               // request-bounds guard on the reporting window
const MAX_MICROS = 1e15                  // per-value + aggregate sanity bound for cost micros
const MAX_COUNT = 1e12                   // per-value + aggregate sanity bound for counts/values

// ── Config ───────────────────────────────────────────────────────────────────

export interface GoogleAdsServiceAccount {
  client_email: string
  private_key: string
}

export interface GoogleAdsConfig {
  serviceAccount: GoogleAdsServiceAccount
  customerId: string                       // 10 digits, no separators
  loginCustomerId?: string                 // optional manager (MCC) id, 10 digits
  apiVersion: string                       // validated `vNN`, e.g. 'v26'
  /** Explicit campaign-id → canonical category mapping. We NEVER guess a category from a name. */
  campaignCategories: Record<string, ServiceCategory>
}

/**
 * Three-state resolution so "absent" (no reporting config at all → use manual data) is strictly
 * distinct from "invalid" (some reporting env present but malformed/partial → configuration error,
 * NEVER a silent fall-back to manual and NEVER a live fetch). `error` is a sanitized `config_*` code.
 */
export type GoogleAdsConfigState = 'absent' | 'invalid' | 'configured'
export interface GoogleAdsConfigResolution {
  state: GoogleAdsConfigState
  config: GoogleAdsConfig | null
  error: string | null
}

const ENV_KEYS = [
  'GOOGLE_ADS_SERVICE_ACCOUNT_JSON',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_API_VERSION',
  'GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON',
] as const

const API_VERSION_RE = /^v\d+$/
// A Google customer id: 10 digits, optionally grouped by single dashes OR single spaces (the two
// documented separators). Arbitrary letters/punctuation are rejected — we never strip them away.
const CUSTOMER_ID_RE = /^\d{3}[- ]?\d{3}[- ]?\d{4}$/

function isServiceCategory(x: unknown): x is ServiceCategory {
  return typeof x === 'string' && (SERVICE_CATEGORIES as readonly string[]).includes(x)
}

type Parsed<T> = 'absent' | 'invalid' | T

function parseCustomerId(raw: string | undefined): Parsed<string> {
  if (raw == null) return 'absent'
  const t = raw.trim()
  if (t === '') return 'absent'
  if (!CUSTOMER_ID_RE.test(t)) return 'invalid'
  return t.replace(/[- ]/g, '')
}

function parseApiVersion(raw: string | undefined): Parsed<string> {
  if (raw == null) return 'absent'
  const t = raw.trim()
  if (t === '') return 'absent'
  return API_VERSION_RE.test(t) ? t : 'invalid'
}

function parseCategories(raw: string | undefined): Parsed<Record<string, ServiceCategory>> {
  if (raw == null) return 'absent'
  const t = raw.trim()
  if (t === '') return 'absent'
  let parsed: unknown
  try { parsed = JSON.parse(t) } catch { return 'invalid' }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid'
  const out: Record<string, ServiceCategory> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) return 'invalid'       // keys must be numeric campaign ids
    if (!isServiceCategory(v)) return 'invalid'  // values must be a canonical category — strict, no silent drop
    out[k] = v
  }
  return out
}

/** Parse + validate the service-account JSON WITHOUT leaking any key material into errors. */
function parseServiceAccount(raw: string): { error: string } | { sa: GoogleAdsServiceAccount } {
  let parsed: Record<string, unknown>
  try {
    const p = JSON.parse(raw)
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'config_bad_service_account_shape' }
    parsed = p as Record<string, unknown>
  } catch {
    return { error: 'config_bad_service_account_json' }
  }
  if (typeof parsed.client_email !== 'string' || !parsed.client_email.includes('@')) return { error: 'config_bad_service_account_shape' }
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY')) return { error: 'config_bad_private_key' }
  // A supplied token_uri must be the pinned endpoint — never let it steer the credential request.
  if (parsed.token_uri != null && parsed.token_uri !== TOKEN_ENDPOINT) return { error: 'config_bad_token_uri' }
  // Prove the key actually loads as a private key (no material is logged or surfaced).
  try { createPrivateKey(parsed.private_key) } catch { return { error: 'config_bad_private_key' } }
  return { sa: { client_email: parsed.client_email, private_key: parsed.private_key } }
}

/**
 * Resolve the Google Ads reporting config from server env. Absent (no vars at all) → use manual data.
 * Any present-but-invalid/partial piece → `invalid` with a sanitized `config_*` code (never manual,
 * never a fetch). Never logs or echoes key material.
 */
export function resolveGoogleAdsConfig(env: NodeJS.ProcessEnv = process.env): GoogleAdsConfigResolution {
  const anyPresent = ENV_KEYS.some((k) => (env[k] ?? '').trim() !== '')
  if (!anyPresent) return { state: 'absent', config: null, error: null }

  const invalid = (error: string): GoogleAdsConfigResolution => ({ state: 'invalid', config: null, error })

  const rawJson = (env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON ?? '').trim()
  if (rawJson === '') return invalid('config_missing_service_account')

  const cid = parseCustomerId(env.GOOGLE_ADS_CUSTOMER_ID)
  if (cid === 'absent') return invalid('config_missing_customer_id')
  if (cid === 'invalid') return invalid('config_bad_customer_id')

  const saRes = parseServiceAccount(rawJson)
  if ('error' in saRes) return invalid(saRes.error)

  const login = parseCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
  if (login === 'invalid') return invalid('config_bad_login_customer_id')

  const ver = parseApiVersion(env.GOOGLE_ADS_API_VERSION)
  if (ver === 'invalid') return invalid('config_bad_api_version')

  const cats = parseCategories(env.GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON)
  if (cats === 'invalid') return invalid('config_bad_category_map')

  return {
    state: 'configured',
    error: null,
    config: {
      serviceAccount: saRes.sa,
      customerId: cid,
      loginCustomerId: login === 'absent' ? undefined : login,
      apiVersion: ver === 'absent' ? DEFAULT_API_VERSION : ver,
      campaignCategories: cats === 'absent' ? {} : cats,
    },
  }
}

/** Convenience: the valid config, or null when absent/invalid. */
export function googleAdsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleAdsConfig | null {
  return resolveGoogleAdsConfig(env).config
}

/**
 * Stable NON-SECRET cache identity for a config. A SHA-256 over the full config — INCLUDING the
 * private key (so a key rotation changes the fingerprint) and the sorted category map — is returned
 * as hex. The raw key / JWT are never exposed; only this digest is used as a cache key.
 */
export function googleAdsConfigFingerprint(cfg: GoogleAdsConfig): string {
  const sortedCats = Object.keys(cfg.campaignCategories).sort()
    .map((k) => `${k}=${cfg.campaignCategories[k]}`).join(',')
  const material = [
    cfg.serviceAccount.client_email,
    cfg.serviceAccount.private_key,
    cfg.customerId,
    cfg.loginCustomerId ?? '',
    cfg.apiVersion,
    sortedCats,
  ].join(' ')
  return createHash('sha256').update(material).digest('hex')
}

// ── JWT + token exchange ───────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Build a signed RS256 service-account JWT. `now` is MILLISECONDS (consistent everywhere); iat/exp
 * are derived in seconds. aud + scope are PINNED. The token carries only public claims — never the
 * private key.
 */
export function buildServiceAccountJwt(sa: GoogleAdsServiceAccount, opts: { now?: number } = {}): string {
  const nowMs = opts.now ?? Date.now()
  const iat = Math.floor(nowMs / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = { iss: sa.client_email, scope: ADWORDS_SCOPE, aud: TOKEN_ENDPOINT, iat, exp: iat + 3600 }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  return `${signingInput}.${base64url(signer.sign(sa.private_key))}`
}

/** Minimal Response-compatible shape — a real `fetch` Response satisfies it; tests inject an equal. */
export interface AdFetchResponse {
  ok: boolean
  status: number
  body?: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
}

export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
    redirect?: 'error' | 'follow' | 'manual'
  },
) => Promise<AdFetchResponse>

export interface FetchDeps {
  fetchImpl?: FetchLike
  now?: number            // milliseconds
  timeoutMs?: number
  maxResponseBytes?: number
}

function resolveFetch(deps: FetchDeps): FetchLike {
  return deps.fetchImpl ?? (fetch as unknown as FetchLike)
}

/** Read a response body under a byte cap. Streams when possible so the cap applies as bytes arrive. */
async function readBodyBounded(res: AdFetchResponse, maxBytes: number): Promise<string> {
  const body = res.body
  if (body && typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let out = ''
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          bytes += value.byteLength
          if (bytes > maxBytes) throw new Error('google_ads_response_too_large')
          out += decoder.decode(value, { stream: true })
        }
      }
      out += decoder.decode()
      return out
    } catch (e) {
      try { await reader.cancel() } catch { /* ignore */ }
      throw e
    }
  }
  const text = await res.text()
  if (text.length > maxBytes) throw new Error('google_ads_response_too_large')
  return text
}

/**
 * Fetch with a single deadline that covers BOTH the request and the bounded body read. The timeout
 * aborts the request and loses the race even if an injected body never settles, so a slow body can
 * never hang indefinitely. Credential-bearing requests pin `redirect: 'error'`.
 */
async function fetchTextBounded(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  deps: FetchDeps,
): Promise<{ ok: boolean; status: number; text: string }> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('google_ads_timeout')) }, timeoutMs)
  })
  const work = (async () => {
    const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' })
    const text = await readBodyBounded(res, maxBytes)
    return { ok: res.ok, status: res.status, text }
  })()
  void work.catch(() => { /* swallow a late rejection if the deadline already won the race */ })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function networkCode(e: unknown, fallback: string): Error {
  if (e instanceof Error && /^google_ads_[a-z0-9_]+$/.test(e.message)) return e
  return new Error(fallback)
}

/** Exchange the JWT for an access token. Errors are sanitized — never the raw Google body. */
export async function fetchAccessToken(cfg: GoogleAdsConfig, deps: FetchDeps = {}): Promise<string> {
  const fetchImpl = resolveFetch(deps)
  const jwt = buildServiceAccountJwt(cfg.serviceAccount, { now: deps.now })
  const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion: jwt }).toString()

  let r: { ok: boolean; status: number; text: string }
  try {
    r = await fetchTextBounded(fetchImpl, TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, deps)
  } catch (e) {
    throw networkCode(e, 'google_ads_token_network_error')
  }
  if (!r.ok) throw new Error(`google_ads_token_http_${r.status}`)
  let data: { access_token?: unknown }
  try { data = (r.text ? JSON.parse(r.text) : {}) as { access_token?: unknown } } catch { throw new Error('google_ads_token_malformed') }
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('google_ads_token_missing')
  return data.access_token
}

// ── searchStream ─────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True only for a real calendar date in YYYY-MM-DD (rejects 2026-02-30 etc.). */
function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function validateRange(range: { from: string; to: string }): void {
  if (!isRealDate(range.from) || !isRealDate(range.to)) throw new Error('google_ads_bad_date')
  const from = Date.parse(`${range.from}T00:00:00Z`)
  const to = Date.parse(`${range.to}T00:00:00Z`)
  if (from > to) throw new Error('google_ads_bad_range')
  if ((to - from) / 86_400_000 > MAX_RANGE_DAYS) throw new Error('google_ads_range_too_large')
}

/** A loose IANA timezone shape (Region/City) or 'UTC'. */
function isPlausibleTimeZone(s: string): boolean {
  return s === 'UTC' || /^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(s)
}

/** A plain object record — NOT null, NOT an array. Arrays like `metrics: []` must be rejected. */
function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Read a numeric metric field. An OMITTED field (proto3 zero) → 0. A PRESENT-but-malformed value
 * (null / '' / boolean / non-finite / negative) → reject. Accepts int64-as-string (Google REST).
 */
function readNumeric(obj: Record<string, unknown>, key: string): number {
  if (!(key in obj)) return 0
  const v = obj[key]
  if (v === undefined) return 0
  if (v === null || v === '' || typeof v === 'boolean') throw new Error('google_ads_bad_metric')
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) throw new Error('google_ads_bad_metric')
  return n
}

/** Non-negative SAFE INTEGER within bound (cost micros, impressions, clicks). */
function readInteger(obj: Record<string, unknown>, key: string, max: number): number {
  const n = readNumeric(obj, key)
  if (!Number.isInteger(n) || n > max) throw new Error('google_ads_bad_metric')
  return n
}

/** Non-negative fractional value within bound (conversions, conversion value). */
function readFractional(obj: Record<string, unknown>, key: string, max: number): number {
  const n = readNumeric(obj, key)
  if (n > max) throw new Error('google_ads_bad_metric')
  return n
}

/** POST a GAQL query to searchStream and return the flat result rows. Errors are sanitized. */
async function searchStream(cfg: GoogleAdsConfig, accessToken: string, query: string, deps: FetchDeps): Promise<Record<string, unknown>[]> {
  const fetchImpl = resolveFetch(deps)
  const url = `${ADS_API_HOST}/${cfg.apiVersion}/customers/${cfg.customerId}/googleAds:searchStream`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
  if (cfg.loginCustomerId) headers['login-customer-id'] = cfg.loginCustomerId

  let r: { ok: boolean; status: number; text: string }
  try {
    r = await fetchTextBounded(fetchImpl, url, { method: 'POST', headers, body: JSON.stringify({ query }) }, deps)
  } catch (e) {
    throw networkCode(e, 'google_ads_network_error')
  }
  if (!r.ok) throw new Error(`google_ads_http_${r.status}`)

  let payload: unknown
  try { payload = r.text ? JSON.parse(r.text) : null } catch { throw new Error('google_ads_malformed_response') }
  // searchStream returns an array of batches: [{ results: [...] }, ...]. Reject other shapes.
  if (!Array.isArray(payload)) throw new Error('google_ads_malformed_response')
  const rows: Record<string, unknown>[] = []
  for (const batch of payload) {
    if (!batch || typeof batch !== 'object') throw new Error('google_ads_malformed_response')
    const results = (batch as { results?: unknown }).results
    if (results === undefined) continue // a batch may legitimately carry no results
    if (!Array.isArray(results)) throw new Error('google_ads_malformed_response')
    for (const row of results) {
      if (!row || typeof row !== 'object') throw new Error('google_ads_malformed_response')
      rows.push(row as Record<string, unknown>)
      if (rows.length > MAX_RESULT_ROWS) throw new Error('google_ads_response_too_large')
    }
  }
  return rows
}

// ── Public reporting fetch ─────────────────────────────────────────────────────

export interface GoogleAdsAccount {
  customerId: string
  name: string | null
  currency: string
  timeZone: string | null
  timeZoneMismatch: boolean // true when the account tz differs from the expected ACCOUNT_TIME_ZONE
}

export interface GoogleAdsReportResult {
  account: GoogleAdsAccount
  byCategory: CategoryAdRollup[]
  fetchedAt: string // ISO
}

/** Read the account's id/name/currency/timezone; reject a different customer or non-USD account. */
async function fetchAccount(cfg: GoogleAdsConfig, accessToken: string, deps: FetchDeps): Promise<GoogleAdsAccount> {
  const rows = await searchStream(
    cfg,
    accessToken,
    'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1',
    deps,
  )
  const customer = rows[0]?.customer as Record<string, unknown> | undefined
  if (!customer) throw new Error('google_ads_no_customer')
  const id = String(customer.id ?? '')
  if (id !== cfg.customerId) throw new Error('google_ads_customer_mismatch')
  const currency = typeof customer.currencyCode === 'string' ? customer.currencyCode : ''
  if (currency !== 'USD') throw new Error('google_ads_unsupported_currency')

  let timeZone: string | null = null
  if (customer.timeZone != null) {
    if (typeof customer.timeZone !== 'string' || !isPlausibleTimeZone(customer.timeZone)) throw new Error('google_ads_malformed_response')
    timeZone = customer.timeZone
  }
  return {
    customerId: id,
    name: typeof customer.descriptiveName === 'string' ? customer.descriptiveName : null,
    currency,
    timeZone,
    timeZoneMismatch: timeZone != null && timeZone !== ACCOUNT_TIME_ZONE,
  }
}

interface CategoryAcc {
  costMicros: number
  impressions: number
  clicks: number
  conversions: number
  conversionsValue: number
}

/**
 * Fetch campaign daily metrics for [from,to] (account-local ISO dates) and roll up per canonical
 * service category. Unmapped campaigns bucket to 'other'. Costs are summed in micros and rounded to
 * cents ONCE per category; conversion value is summed then rounded to cents (and kept raw as
 * `conversionValue`); conversions stay fractional. A malformed response is rejected rather than
 * reported as a false zero. An empty but well-formed response is a legitimate zero (returns []).
 */
export async function fetchGoogleAdsReporting(
  cfg: GoogleAdsConfig,
  range: { from: string; to: string },
  deps: FetchDeps = {},
): Promise<GoogleAdsReportResult> {
  validateRange(range)
  const accessToken = await fetchAccessToken(cfg, deps)
  const account = await fetchAccount(cfg, accessToken, deps)

  const query =
    'SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, ' +
    'metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign ' +
    `WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'`
  const rows = await searchStream(cfg, accessToken, query, deps)

  const acc = new Map<string, CategoryAcc>()
  const bucket = (cat: string): CategoryAcc => {
    let a = acc.get(cat)
    if (!a) { a = { costMicros: 0, impressions: 0, clicks: 0, conversions: 0, conversionsValue: 0 }; acc.set(cat, a) }
    return a
  }
  for (const row of rows) {
    // Each of these MUST be a plain object. An array (e.g. metrics: []) or any non-record is
    // malformed — reject it rather than letting absent fields read as a false all-zero rollup.
    if (!isPlainRecord(row.campaign) || !isPlainRecord(row.metrics) || !isPlainRecord(row.segments)) {
      throw new Error('google_ads_malformed_response')
    }
    const campaign = row.campaign
    const metrics = row.metrics
    const segments = row.segments
    // Campaign id must be numeric; category comes ONLY from the explicit map — never from the name.
    const idRaw = campaign.id
    const campaignId = typeof idRaw === 'number' ? String(idRaw) : typeof idRaw === 'string' ? idRaw : ''
    if (!/^\d+$/.test(campaignId)) throw new Error('google_ads_malformed_response')
    if (typeof segments.date !== 'string' || !isRealDate(segments.date)) throw new Error('google_ads_malformed_response')
    if (segments.date < range.from || segments.date > range.to) throw new Error('google_ads_date_out_of_range')

    const category = cfg.campaignCategories[campaignId] ?? 'other'
    const a = bucket(category)
    a.costMicros += readInteger(metrics, 'costMicros', MAX_MICROS)
    a.impressions += readInteger(metrics, 'impressions', MAX_COUNT)
    a.clicks += readInteger(metrics, 'clicks', MAX_COUNT)
    a.conversions += readFractional(metrics, 'conversions', MAX_COUNT)
    a.conversionsValue += readFractional(metrics, 'conversionsValue', MAX_COUNT)
  }

  const byCategory: CategoryAdRollup[] = Array.from(acc.entries())
    .map(([serviceCategory, a]) => {
      // Aggregate-bounds re-check: EVERY summed metric must still be finite, non-negative, and within
      // its declared bound (per-row validation alone can't catch a sum that crosses the limit).
      if (!Number.isFinite(a.costMicros) || a.costMicros < 0 || a.costMicros > MAX_MICROS || !Number.isSafeInteger(Math.round(a.costMicros))) throw new Error('google_ads_overflow')
      for (const sum of [a.impressions, a.clicks, a.conversions, a.conversionsValue]) {
        if (!Number.isFinite(sum) || sum < 0 || sum > MAX_COUNT) throw new Error('google_ads_overflow')
      }
      return {
        serviceCategory,
        spendCents: Math.round(a.costMicros / 10_000), // micros → cents, summed before rounding
        impressions: Math.round(a.impressions),
        clicks: Math.round(a.clicks),
        conversions: a.conversions,                    // fractional preserved
        conversionValue: a.conversionsValue,           // raw Google-ASSIGNED value (fractional, neutral units)
        revenueCents: Math.round(a.conversionsValue * 100), // legacy internal compat only
      }
    })
    .sort((x, y) => y.spendCents - x.spendCents || y.serviceCategory.localeCompare(x.serviceCategory))

  return { account, byCategory, fetchedAt: new Date(deps.now ?? Date.now()).toISOString() }
}
