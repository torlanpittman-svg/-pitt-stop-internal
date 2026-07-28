/**
 * High-level connection access. Callers ask for a valid access token and never
 * deal with expiry or refresh — that happens transparently here.
 */
import { decrypt } from './crypto'
import { refreshAccessToken } from './oauth'
import {
  getActiveConnection,
  getLatestConnection,
  updateTokensAfterRefresh,
  touchLastUsed,
  markExpired,
  recordError,
  type QBConnectionRow,
} from './db'
import { QBNotConnectedError, QBReauthRequiredError } from './errors'
import { getEnvironment, type QBEnvironment } from './config'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:connection'
const REFRESH_WINDOW_MS = 5 * 60 * 1000 // refresh if <5 min of access-token life left

export interface ValidToken {
  accessToken: string
  realmId:     string
  environment: QBEnvironment
}

/**
 * Return a currently-valid access token, refreshing first if it is within the
 * refresh window. Throws QBNotConnectedError / QBReauthRequiredError so API
 * callers can surface the right message and prompt a reconnect.
 */
export async function getValidAccessToken(): Promise<ValidToken> {
  const conn = await getActiveConnection()
  if (!conn) throw new QBNotConnectedError()

  const now = Date.now()
  const msLeft = conn.accessTokenExpiresAt.getTime() - now

  if (msLeft > REFRESH_WINDOW_MS) {
    await touchLastUsed(conn.id)
    return { accessToken: decrypt(conn.accessTokenEnc), realmId: conn.realmId, environment: conn.environment as QBEnvironment }
  }

  // Access token expiring/expired — refresh, unless the refresh token is dead.
  if (conn.refreshTokenExpiresAt.getTime() <= now) {
    await markExpired(conn.id, 'refresh_token expired')
    logger.warn(APP, 'refresh_token.expired', { realmId: conn.realmId })
    throw new QBReauthRequiredError()
  }

  try {
    const refreshToken = decrypt(conn.refreshTokenEnc)
    const tok = await refreshAccessToken(refreshToken)
    await updateTokensAfterRefresh(conn.id, tok)
    await touchLastUsed(conn.id)
    logger.info(APP, 'token.refreshed', { realmId: conn.realmId })
    return { accessToken: tok.access_token, realmId: conn.realmId, environment: conn.environment as QBEnvironment }
  } catch (err) {
    const msg = String(err)
    await recordError(conn.id, msg)
    // A failed refresh usually means the refresh token was revoked/rotated away.
    if (msg.includes('400') || msg.includes('invalid_grant')) {
      await markExpired(conn.id, 'refresh failed: ' + msg)
      throw new QBReauthRequiredError()
    }
    throw err
  }
}

export interface ConnectionStatus {
  connected:             boolean
  realmId:               string | null
  environment:           QBEnvironment
  status:                string | null // active | expired | revoked
  accessTokenExpiresAt:  string | null
  refreshTokenExpiresAt: string | null
  connectedBy:           string | null
  lastUsedAt:            string | null
  lastRefreshedAt:       string | null
  lastError:             string | null
}

function toStatus(row: QBConnectionRow | null): ConnectionStatus {
  if (!row) {
    return {
      connected: false, realmId: null, environment: getEnvironment(), status: null,
      accessTokenExpiresAt: null, refreshTokenExpiresAt: null, connectedBy: null,
      lastUsedAt: null, lastRefreshedAt: null, lastError: null,
    }
  }
  return {
    connected:             row.status === 'active',
    realmId:               row.realmId,
    environment:           row.environment as QBEnvironment,
    status:                row.status,
    accessTokenExpiresAt:  row.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: row.refreshTokenExpiresAt.toISOString(),
    connectedBy:           row.connectedBy,
    lastUsedAt:            row.lastUsedAt?.toISOString() ?? null,
    lastRefreshedAt:       row.lastRefreshedAt?.toISOString() ?? null,
    lastError:             row.lastError,
  }
}

/** Connection status for the admin panel — never exposes token material. */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const row = await getLatestConnection()
  return toStatus(row)
}
