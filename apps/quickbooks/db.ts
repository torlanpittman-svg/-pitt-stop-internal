/**
 * QuickBooks connection persistence.
 *
 * Stores exactly one active connection per (realm_id, environment). Tokens are
 * encrypted before they touch the database and decrypted only in-process.
 */
import { eq, and, desc } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { qbConnections } from './schema'
import { encrypt } from './crypto'
import { getEnvironment } from './config'
import type { TokenResponse } from './oauth'
import type { QBEnvironment } from './config'

export interface QBConnectionRow {
  id:                    string
  realmId:               string
  environment:           QBEnvironment
  accessTokenEnc:        string
  refreshTokenEnc:       string
  accessTokenExpiresAt:  Date
  refreshTokenExpiresAt: Date
  status:                string
  connectedBy:           string | null
  lastUsedAt:            Date | null
  lastRefreshedAt:       Date | null
  lastError:             string | null
  createdAt:             Date
  updatedAt:             Date
}

function requireDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured; cannot store QuickBooks connection.')
  }
  return getDb()
}

function expiryDates(tok: TokenResponse) {
  const now = Date.now()
  return {
    accessTokenExpiresAt:  new Date(now + tok.expires_in * 1000),
    refreshTokenExpiresAt: new Date(now + tok.x_refresh_token_expires_in * 1000),
  }
}

/**
 * Insert or update the connection for a realm+environment (upsert on the unique
 * index). Called after a successful OAuth callback.
 */
export async function saveConnection(params: {
  realmId:     string
  environment: QBEnvironment
  tokens:      TokenResponse
  connectedBy?: string | null
}): Promise<void> {
  const db = requireDb()
  const { accessTokenExpiresAt, refreshTokenExpiresAt } = expiryDates(params.tokens)

  const values = {
    realmId:         params.realmId,
    environment:     params.environment,
    accessTokenEnc:  encrypt(params.tokens.access_token),
    refreshTokenEnc: encrypt(params.tokens.refresh_token),
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    status:          'active' as const,
    connectedBy:     params.connectedBy ?? null,
    lastRefreshedAt: new Date(),
    lastError:       null as string | null,
    updatedAt:       new Date(),
  }

  await db
    .insert(qbConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [qbConnections.realmId, qbConnections.environment],
      set:    values,
    })
}

/** The active connection for the current environment, or null. */
export async function getActiveConnection(): Promise<QBConnectionRow | null> {
  if (!process.env.DATABASE_URL) return null
  const db  = getDb()
  const env = getEnvironment()
  const [row] = await db
    .select()
    .from(qbConnections)
    .where(and(eq(qbConnections.environment, env), eq(qbConnections.status, 'active')))
    .orderBy(desc(qbConnections.updatedAt))
    .limit(1)
  return (row as QBConnectionRow) ?? null
}

/** The most recent connection row regardless of status (for status display). */
export async function getLatestConnection(): Promise<QBConnectionRow | null> {
  if (!process.env.DATABASE_URL) return null
  const db  = getDb()
  const env = getEnvironment()
  const [row] = await db
    .select()
    .from(qbConnections)
    .where(eq(qbConnections.environment, env))
    .orderBy(desc(qbConnections.updatedAt))
    .limit(1)
  return (row as QBConnectionRow) ?? null
}

/** Persist rotated tokens after a successful refresh. */
export async function updateTokensAfterRefresh(id: string, tok: TokenResponse): Promise<void> {
  const db = requireDb()
  const { accessTokenExpiresAt, refreshTokenExpiresAt } = expiryDates(tok)
  await db
    .update(qbConnections)
    .set({
      accessTokenEnc:  encrypt(tok.access_token),
      refreshTokenEnc: encrypt(tok.refresh_token),
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      status:          'active',
      lastRefreshedAt: new Date(),
      lastError:       null,
      updatedAt:       new Date(),
    })
    .where(eq(qbConnections.id, id))
}

export async function touchLastUsed(id: string): Promise<void> {
  const db = requireDb()
  await db.update(qbConnections).set({ lastUsedAt: new Date() }).where(eq(qbConnections.id, id))
}

export async function markExpired(id: string, reason: string): Promise<void> {
  const db = requireDb()
  await db
    .update(qbConnections)
    .set({ status: 'expired', lastError: reason, updatedAt: new Date() })
    .where(eq(qbConnections.id, id))
}

export async function markRevoked(id: string): Promise<void> {
  const db = requireDb()
  await db
    .update(qbConnections)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(eq(qbConnections.id, id))
}

export async function recordError(id: string, reason: string): Promise<void> {
  const db = requireDb()
  await db
    .update(qbConnections)
    .set({ lastError: reason, updatedAt: new Date() })
    .where(eq(qbConnections.id, id))
}
