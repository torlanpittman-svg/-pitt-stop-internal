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
  /** Abort after this many ms (the caller must treat an abort as an AMBIGUOUS write outcome). */
  timeoutMs?: number
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
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
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

/**
 * Read-only binary fetch (e.g. GET /invoice/{id}/pdf → application/pdf). Same auth, host and
 * one-401-retry behavior as qbApiRequest; returns the raw bytes.
 */
export async function qbApiRequestBinary(opts: { path: string; accept: string }): Promise<ArrayBuffer> {
  const doCall = async (): Promise<Response> => {
    const { accessToken, realmId, environment } = await getValidAccessToken()
    const url = new URL(`${QB_API_BASE[environment]}/v3/company/${realmId}${opts.path}`)
    url.searchParams.set('minorversion', QB_MINOR_VERSION)
    return fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}`, Accept: opts.accept } })
  }
  let res = await doCall()
  if (res.status === 401) { logger.warn(APP, 'retry_after_401', { path: opts.path }); res = await doCall() }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new QBApiError(res.status, `QuickBooks API ${opts.path} failed (${res.status}): ${text}`)
  }
  return res.arrayBuffer()
}

/**
 * Upload one binary file and its metadata to QBO's multipart `/upload` endpoint (same auth, host and
 * one-401-retry behavior as qbApiRequest). The ordinary client JSON-stringifies its body, which would
 * corrupt binary bytes; this helper posts a real `multipart/form-data` request with the paired parts
 * QBO expects — `file_metadata_0` (JSON) and `file_content_0` (the raw bytes, with filename + type) —
 * letting `fetch` set the multipart boundary itself.
 *
 * Returns the parsed JSON unchanged: QBO reports per-file problems as a `Fault` inside
 * `AttachableResponse` even on HTTP 200, so the CALLER must inspect the body, not just the status.
 * Pass a deterministic `requestid` so a timed-out retry does not create a duplicate attachment.
 */
export async function qbUploadAttachment<T = unknown>(opts: {
  metadata: unknown
  content: Uint8Array
  contentType: string
  filename: string
  query?: Record<string, string>
  timeoutMs?: number
}): Promise<T> {
  const doCall = async (): Promise<Response> => {
    const { accessToken, realmId, environment } = await getValidAccessToken()
    const url = new URL(`${QB_API_BASE[environment]}/v3/company/${realmId}/upload`)
    url.searchParams.set('minorversion', QB_MINOR_VERSION)
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)

    const form = new FormData()
    form.append('file_metadata_0', new Blob([JSON.stringify(opts.metadata)], { type: 'application/json' }))
    // Actual binary bytes (NOT JSON-stringified) with the declared content type + filename. Copy into a
    // fresh ArrayBuffer-backed Uint8Array so the bytes are an unambiguous BlobPart (a shared-buffer view
    // is not assignable to BlobPart under current lib types).
    form.append('file_content_0', new Blob([new Uint8Array(opts.content)], { type: opts.contentType }), opts.filename)

    return fetch(url.toString(), {
      method: 'POST',
      // Let fetch set `Content-Type: multipart/form-data; boundary=...` itself.
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      body: form,
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    })
  }

  let res = await doCall()
  if (res.status === 401) {
    logger.warn(APP, 'retry_after_401', { path: '/upload' })
    res = await doCall()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new QBApiError(res.status, `QuickBooks API /upload failed (${res.status}): ${text}`)
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
