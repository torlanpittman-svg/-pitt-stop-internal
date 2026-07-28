/**
 * QuickBooks integration — database schema.
 * Imported by drizzle/schema.ts (the platform aggregator).
 *
 * Holds one row per connected QuickBooks Online company (realm).
 * OAuth access/refresh tokens are stored ENCRYPTED (AES-256-GCM) — never plaintext.
 * The (realm_id, environment) unique index supports future multi-company use:
 * one active connection per company per environment, upserted on reconnect.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'

export const qbConnections = pgTable(
  'qb_connections',
  {
    id:      uuid('id').primaryKey().defaultRandom(),

    // Intuit company identifier returned on the OAuth callback.
    realmId: varchar('realm_id', { length: 100 }).notNull(),

    // 'sandbox' | 'production' — OAuth endpoints are shared, but API base differs.
    environment: varchar('environment', { length: 20 }).notNull().default('production'),

    // Encrypted token payloads. Format: v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
    accessTokenEnc:  text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc').notNull(),

    accessTokenExpiresAt:  timestamp('access_token_expires_at',  { withTimezone: true }).notNull(),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }).notNull(),

    // active | expired | revoked
    status: varchar('status', { length: 20 }).notNull().default('active'),

    connectedBy:     varchar('connected_by', { length: 200 }),
    lastUsedAt:      timestamp('last_used_at',      { withTimezone: true }),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    lastError:       text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('qb_conn_realm_env_uniq').on(t.realmId, t.environment),
    index('qb_conn_status_idx').on(t.status),
  ]
)
