-- Phase 0a — QuickBooks OAuth connection storage.
-- Applied via scripts/apply-qb-migration.mjs (idempotent). This project syncs
-- schema with `drizzle-kit push`; the formal migration journal is not the source
-- of truth for the live DB, so this table is created directly + recorded here.

CREATE TABLE IF NOT EXISTS "qb_connections" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "realm_id"                  varchar(100) NOT NULL,
  "environment"               varchar(20) DEFAULT 'production' NOT NULL,
  "access_token_enc"          text NOT NULL,
  "refresh_token_enc"         text NOT NULL,
  "access_token_expires_at"   timestamp with time zone NOT NULL,
  "refresh_token_expires_at"  timestamp with time zone NOT NULL,
  "status"                    varchar(20) DEFAULT 'active' NOT NULL,
  "connected_by"              varchar(200),
  "last_used_at"              timestamp with time zone,
  "last_refreshed_at"         timestamp with time zone,
  "last_error"                text,
  "created_at"                timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"                timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "qb_conn_realm_env_uniq" ON "qb_connections" ("realm_id", "environment");
CREATE INDEX IF NOT EXISTS "qb_conn_status_idx" ON "qb_connections" ("status");
