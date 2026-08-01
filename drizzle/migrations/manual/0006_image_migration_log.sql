-- Phase 1: base64 → Vercel Blob migration scaffold (metadata only; no image bytes).
-- Drives idempotency, verification, error tracking, and rollback for moving
-- estimate_photos + vehicle_entries base64 image columns to Blob URLs.
-- Additive and safe: creates one small table, touches no existing data.

CREATE TABLE IF NOT EXISTS image_migration_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table  text        NOT NULL,                 -- 'estimate_photos' | 'vehicle_entries'
  row_id        uuid        NOT NULL,                 -- PK of the source row
  column_name   text        NOT NULL,                 -- e.g. 'photo_url'
  old_kind      varchar(10) NOT NULL DEFAULT 'base64',-- what we migrated FROM
  old_bytes     integer,                              -- decoded image size (no base64 stored)
  old_sha256    varchar(64),                          -- integrity/rollback checksum of decoded bytes
  blob_url      text,                                 -- new Vercel Blob URL
  status        varchar(12) NOT NULL DEFAULT 'pending', -- pending|migrated|verified|failed|cleaned
  error         text,                                 -- failure detail (no secrets / no base64)
  created_at    timestamptz NOT NULL DEFAULT now(),
  migrated_at   timestamptz,                          -- Blob upload + verify succeeded
  cleaned_at    timestamptz,                          -- base64 removed from source column (Phase 4)
  -- one log row per (row, column): enforces idempotency of the migration
  CONSTRAINT image_migration_log_uniq UNIQUE (source_table, row_id, column_name)
);

CREATE INDEX IF NOT EXISTS image_migration_log_status_idx ON image_migration_log (status);
CREATE INDEX IF NOT EXISTS image_migration_log_source_idx ON image_migration_log (source_table, column_name);
