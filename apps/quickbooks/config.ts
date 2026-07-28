/**
 * QuickBooks Online configuration and Intuit OAuth 2.0 endpoints.
 *
 * The OAuth endpoints (authorize / token / revoke) are identical for sandbox
 * and production. Only the API data host (QB_API_BASE) differs by environment.
 */
import { encryptionKeyValid } from './crypto'

export type QBEnvironment = 'sandbox' | 'production'

export const QB_OAUTH = {
  authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
  tokenUrl:     'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revokeUrl:    'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
} as const

export const QB_API_BASE: Record<QBEnvironment, string> = {
  sandbox:    'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
}

// Accounting scope covers invoices, customers, items — everything the dealer
// check-in flow needs. We deliberately do NOT request the payments scope.
export const QB_ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting'

export const QB_MINOR_VERSION = '73'

export interface QBConfig {
  clientId:     string
  clientSecret: string
  redirectUri:  string
  environment:  QBEnvironment
}

/** Current environment from env (defaults to production). Never throws. */
export function getEnvironment(): QBEnvironment {
  return process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production'
}

/** Returns the full config, throwing a clear error listing any missing vars. */
export function getQBConfig(): QBConfig {
  const clientId     = process.env.QUICKBOOKS_CLIENT_ID
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
  const redirectUri  = process.env.QUICKBOOKS_REDIRECT_URI

  const missing: string[] = []
  if (!clientId)     missing.push('QUICKBOOKS_CLIENT_ID')
  if (!clientSecret) missing.push('QUICKBOOKS_CLIENT_SECRET')
  if (!redirectUri)  missing.push('QUICKBOOKS_REDIRECT_URI')
  if (missing.length) {
    throw new Error(`Missing QuickBooks environment variables: ${missing.join(', ')}`)
  }

  return {
    clientId:     clientId!,
    clientSecret: clientSecret!,
    redirectUri:  redirectUri!,
    environment:  getEnvironment(),
  }
}

/** True when all OAuth credentials + encryption key are present (no throw). */
export function isConfigured(): boolean {
  return Boolean(
    process.env.QUICKBOOKS_CLIENT_ID &&
    process.env.QUICKBOOKS_CLIENT_SECRET &&
    process.env.QUICKBOOKS_REDIRECT_URI &&
    encryptionKeyValid()
  )
}

/** Per-var readiness for the admin diagnostics panel (never exposes values). */
export function configDiagnostics() {
  return {
    clientId:      Boolean(process.env.QUICKBOOKS_CLIENT_ID),
    clientSecret:  Boolean(process.env.QUICKBOOKS_CLIENT_SECRET),
    redirectUri:   process.env.QUICKBOOKS_REDIRECT_URI ?? null,
    environment:   getEnvironment(),
    encryptionKey: encryptionKeyValid(),
  }
}
