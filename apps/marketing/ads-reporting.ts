/**
 * Ad-reporting source resolver. ONE honest entry point the report + UI use to get Google Ads
 * rollups, with explicit provenance so the dashboards never pretend.
 *
 * Outcomes (live and manual data NEVER mix — no double counting):
 *   • config ABSENT (no reporting env at all) → status 'manual': read the manually-entered
 *     `marketing_ad_metrics` rows (adMetricsByCategory). The long-standing V1 behavior.
 *   • config INVALID/partial (some reporting env present but malformed) → status 'unavailable',
 *     errorKind 'config': NO manual read, NO fetch. A misconfiguration must never masquerade as
 *     manual data or as $0.
 *   • config valid + live fetch OK → status 'live': rollups come from the Google Ads API for this
 *     exact account/range; the manual table is NOT read. Empty-but-OK is a legitimate zero.
 *   • config valid + fetch FAILS → status 'unavailable' with a sanitized error + classified kind
 *     (auth / quota / transient). We do NOT fall back to manual and do NOT invent zeros/ROAS.
 *
 * Google metrics are the platform's own reported numbers. "Conversion value" is a Google-ASSIGNED
 * value, NOT Pitt Stop invoiced or collected revenue, and ad conversions are NOT completed jobs.
 */
import { adMetricsByCategory, type CategoryAdRollup } from './ads'
import {
  fetchGoogleAdsReporting,
  googleAdsConfigFingerprint,
  resolveGoogleAdsConfig,
  type FetchLike,
  type GoogleAdsAccount,
  type GoogleAdsConfig,
  type GoogleAdsReportResult,
} from './providers/google-ads'

export type AdDataStatus = 'manual' | 'live' | 'unavailable'
export type AdDataSource = 'manual_entry' | 'google_ads_api'
export type AdErrorKind = 'config' | 'auth' | 'quota' | 'transient'

export interface AdDataMeta {
  status: AdDataStatus
  source: AdDataSource
  fetchedAt: string | null   // ISO, only when a live fetch succeeded
  error: string | null       // sanitized code, only when unavailable
  errorKind: AdErrorKind | null // why it's unavailable (drives the UI copy + whether retry helps)
  account: GoogleAdsAccount | null
}

export interface AdReporting {
  meta: AdDataMeta
  byCategory: CategoryAdRollup[] // active-source rollups; EMPTY when unavailable
}

/** Classify a sanitized error code into an actionable kind for the UI. */
export function classifyAdError(code: string): AdErrorKind {
  if (code.startsWith('config_')) return 'config'
  if (/_http_401$|_http_403$/.test(code)) return 'auth'
  if (/_http_429$/.test(code)) return 'quota'
  // Account-level API responses that really mean "fix the configuration/account".
  if (code === 'google_ads_customer_mismatch' || code === 'google_ads_unsupported_currency') return 'config'
  return 'transient'
}

function manualMeta(): AdDataMeta {
  return { status: 'manual', source: 'manual_entry', fetchedAt: null, error: null, errorKind: null, account: null }
}
function unavailableMeta(error: string, kind: AdErrorKind): AdDataMeta {
  return { status: 'unavailable', source: 'google_ads_api', fetchedAt: null, error, errorKind: kind, account: null }
}

// ── Bounded success cache + concurrent-request coalescing (per server instance, best-effort) ──
// Keyed by a SHA-256 fingerprint of the FULL config (service-account identity + key rotation +
// sorted category map + ids + version) and the range. The raw key / JWT never appear in a key.
// ONLY successes are cached; a failed fetch is never cached as a zero, and the next call retries.
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX = 64
interface CacheEntry { at: number; value: GoogleAdsReportResult }
const successCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<GoogleAdsReportResult>>()

function cacheKey(cfg: GoogleAdsConfig, range: { from: string; to: string }): string {
  return `${googleAdsConfigFingerprint(cfg)}|${range.from}|${range.to}`
}
function prune(): void {
  while (successCache.size > CACHE_MAX) {
    const oldest = successCache.keys().next().value
    if (oldest === undefined) break
    successCache.delete(oldest)
  }
}

async function cachedFetch(key: string, nowMs: number, fetcher: () => Promise<GoogleAdsReportResult>): Promise<GoogleAdsReportResult> {
  const hit = successCache.get(key)
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return hit.value
  const pending = inflight.get(key)
  if (pending) return pending // coalesce identical concurrent requests into one upstream call
  const p = fetcher().then((value) => { successCache.set(key, { at: nowMs, value }); prune(); return value })
  inflight.set(key, p)
  try {
    return await p
  } finally {
    inflight.delete(key) // a rejection leaves nothing cached → the next call retries
  }
}

/** Test-only: clear the per-instance cache + in-flight map between cases. */
export function __resetAdReportingCacheForTests(): void {
  successCache.clear()
  inflight.clear()
}

export interface LoadAdReportingOpts {
  env?: NodeJS.ProcessEnv
  /** Injected fetch for tests. The cache still applies, keyed by config fingerprint + range. */
  fetchImpl?: FetchLike
  now?: number           // milliseconds (cache clock + JWT iat are both derived from this)
  timeoutMs?: number
  maxResponseBytes?: number
}

/**
 * Resolve ad rollups for a range with explicit provenance. `range` is account-local YYYY-MM-DD.
 * Never throws for a live outage or a misconfiguration — it returns status 'unavailable' with a
 * sanitized error + kind.
 */
export async function loadAdReporting(
  range: { from: string; to: string },
  opts: LoadAdReportingOpts = {},
): Promise<AdReporting> {
  const env = opts.env ?? process.env
  const resolution = resolveGoogleAdsConfig(env)

  if (resolution.state === 'absent') {
    const byCategory = await adMetricsByCategory(range)
    return { meta: manualMeta(), byCategory }
  }
  if (resolution.state === 'invalid') {
    const code = resolution.error ?? 'config_error'
    return { meta: unavailableMeta(code, 'config'), byCategory: [] }
  }

  const cfg = resolution.config!
  const nowMs = opts.now ?? Date.now()
  try {
    const value = await cachedFetch(cacheKey(cfg, range), nowMs, () =>
      fetchGoogleAdsReporting(cfg, range, {
        fetchImpl: opts.fetchImpl, now: nowMs, timeoutMs: opts.timeoutMs, maxResponseBytes: opts.maxResponseBytes,
      }))
    return {
      meta: { status: 'live', source: 'google_ads_api', fetchedAt: value.fetchedAt, error: null, errorKind: null, account: value.account },
      byCategory: value.byCategory,
    }
  } catch (err) {
    // Sanitized: our thrown errors are stable codes; anything else collapses so no raw Google body
    // (which can echo account identifiers) leaks into the UI or logs.
    const code = err instanceof Error && /^(google_ads|config)_[a-z0-9_]+$/.test(err.message) ? err.message : 'google_ads_error'
    return { meta: unavailableMeta(code, classifyAdError(code)), byCategory: [] }
  }
}
