/**
 * Authenticated QuickBooks API client.
 *
 * Every call obtains a valid access token (auto-refreshing as needed), targets
 * the correct environment host, and retries once on a 401 after forcing a token
 * refresh. Higher-level invoice/customer helpers (Phases 1–8) build on this.
 */
import { getValidAccessToken } from './connection'
import { QB_API_BASE, QB_MINOR_VERSION } from './config'
import { QBApiError } from './errors'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:client'

interface QBFetchOptions {
  method?: 'GET' | 'POST'
  /** Path after /v3/company/{realmId} — e.g. `/companyinfo/{realmId}`. */
  path: string
  body?: unknown
  query?: Record<string, string>
  /** Extra request headers (e.g. the invoice send endpoint needs an explicit Content-Type). */
  headers?: Record<string, string>
}

/**
 * Low-level authenticated request against the QBO Accounting API.
 * Returns parsed JSON. Throws QBApiError on non-2xx (after one 401 retry).
 */
export async function qbApiRequest<T = unknown>(opts: QBFetchOptions): Promise<T> {
  const doCall = async (): Promise<Response> => {
    const { accessToken, realmId, environment } = await getValidAccessToken()
    const base = QB_API_BASE[environment]
    const url = new URL(`${base}/v3/company/${realmId}${opts.path}`)
    url.searchParams.set('minorversion', QB_MINOR_VERSION)
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)

    return fetch(url.toString(), {
      method: opts.method ?? 'GET',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        Accept:         'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    })
  }

  let res = await doCall()
  if (res.status === 401) {
    // Token may have just gone stale; getValidAccessToken will refresh on retry.
    logger.warn(APP, 'retry_after_401', { path: opts.path })
    res = await doCall()
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new QBApiError(res.status, `QuickBooks API ${opts.path} failed (${res.status}): ${text}`)
  }
  return (await res.json()) as T
}

/** Escape a value for safe use inside a QBO query string literal. */
export function qboEscape(value: string): string {
  return value.replace(/'/g, "\\'")
}

/**
 * Run a read-only QBO SQL-like query. Returns the `QueryResponse` object,
 * e.g. `{ Customer: [...] }` or `{ Invoice: [...] }` (empty object if no rows).
 */
export async function queryQBO<T = Record<string, unknown>>(query: string): Promise<T> {
  const data = await qbApiRequest<{ QueryResponse?: T }>({ path: '/query', query: { query } })
  return (data.QueryResponse ?? {}) as T
}

export interface CompanyInfo {
  companyName: string
  legalName:   string
  country:     string
}

/**
 * Read-only connectivity check: fetch the connected company's profile.
 * Safe to call anytime — makes no changes in QuickBooks.
 */
export async function getCompanyInfo(): Promise<CompanyInfo> {
  const { realmId } = await getValidAccessToken()
  const data = await qbApiRequest<{ CompanyInfo?: Record<string, string> }>({
    path: `/companyinfo/${realmId}`,
  })
  const ci = data.CompanyInfo ?? {}
  return {
    companyName: ci.CompanyName ?? '',
    legalName:   ci.LegalName ?? '',
    country:     ci.Country ?? '',
  }
}
