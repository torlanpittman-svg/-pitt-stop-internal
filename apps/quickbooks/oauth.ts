/**
 * Intuit OAuth 2.0 authorization-code flow (confidential server-side client).
 *
 * CSRF protection uses the `state` parameter (set as an httpOnly cookie in the
 * connect route, verified in the callback). Token requests authenticate with
 * HTTP Basic (client_id:client_secret) per Intuit's server-side flow.
 */
import { getQBConfig, QB_OAUTH, QB_ACCOUNTING_SCOPE } from './config'

export interface TokenResponse {
  token_type:                 string // 'bearer'
  access_token:               string
  refresh_token:              string
  expires_in:                 number // seconds, typically 3600
  x_refresh_token_expires_in: number // seconds, typically ~8726400 (101 days)
}

function basicAuthHeader(): string {
  const { clientId, clientSecret } = getQBConfig()
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

/** Build the Intuit authorization URL the user's browser is redirected to. */
export function buildAuthorizeUrl(state: string): string {
  const { clientId, redirectUri } = getQBConfig()
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    scope:         QB_ACCOUNTING_SCOPE,
    redirect_uri:  redirectUri,
    state,
  })
  return `${QB_OAUTH.authorizeUrl}?${params.toString()}`
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(QB_OAUTH.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization:  basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json',
    },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Intuit token request failed (${res.status}): ${text}`)
  }
  return (await res.json()) as TokenResponse
}

/** Exchange an authorization code (from the callback) for tokens. */
export function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const { redirectUri } = getQBConfig()
  return postToken(new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: redirectUri,
  }))
}

/**
 * Refresh the access token. Intuit ROTATES the refresh token on each call —
 * the response's refresh_token must be persisted, replacing the old one.
 */
export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return postToken(new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  }))
}

/** Revoke a token (access or refresh) — used on explicit disconnect. */
export async function revokeToken(token: string): Promise<void> {
  const res = await fetch(QB_OAUTH.revokeUrl, {
    method: 'POST',
    headers: {
      Authorization:  basicAuthHeader(),
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify({ token }),
  })
  // Intuit returns 200 on success. Treat 200/204 as success; anything else throws.
  if (res.status !== 200 && res.status !== 204) {
    const text = await res.text().catch(() => '')
    throw new Error(`Intuit token revoke failed (${res.status}): ${text}`)
  }
}
