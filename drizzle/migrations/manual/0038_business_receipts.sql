-- Business Receipts / Expense Capture — general business-wide expense receipts.
-- ADDITIVE ONLY (new table; no existing table touched). Idempotent (IF NOT EXISTS everywhere).
-- The GENERAL expense path (Detail AND Auto Sales). A general shop expense needs no vehicle;
-- inventory_vehicle_id is a plain nullable uuid (no hard FK) so this module stays decoupled from the
-- auto-sales lifecycle while still allowing an optional canonical link.
-- NOTE: no inline column comments — the manual applier strips only full-line comments.

CREATE TABLE IF NOT EXISTS business_receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status                varchar(20) NOT NULL DEFAULT 'needs_review',
  entity                varchar(20) NOT NULL DEFAULT 'unassigned',
  category              varchar(40) NOT NULL DEFAULT 'uncategorized',
  vendor                varchar(200),
  receipt_date          date,
  subtotal_cents        integer,
  tax_cents             integer,
  total_cents           integer,
  payment_method        varchar(20),
  payment_last4         varchar(4),
  account_ref           varchar(40),
  memo                  text,
  inventory_vehicle_id  uuid,
  storage               varchar(16) NOT NULL DEFAULT 'blob_public',
  storage_ref           text,
  filename              varchar(300),
  content_type          varchar(60),
  image_hash            varchar(64),
  byte_size             integer,
  ai_status             varchar(16) NOT NULL DEFAULT 'pending',
  ai_model              varchar(60),
  ai_raw                jsonb,
  ai_extracted          jsonb,
  confidence            jsonb,
  reviewed_by           varchar(200),
  reviewed_at           timestamptz,
  approved_by           varchar(200),
  approved_at           timestamptz,
  rejected_reason       text,
  audit_log             jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by           varchar(200),
  qb_sync_status        varchar(16) NOT NULL DEFAULT 'none',
  qb_entity_ref         varchar(60),
  qb_synced_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_receipts_status_idx  ON business_receipts (status);
CREATE INDEX IF NOT EXISTS business_receipts_hash_idx    ON business_receipts (image_hash);
CREATE INDEX IF NOT EXISTS business_receipts_entity_idx  ON business_receipts (entity);
CREATE INDEX IF NOT EXISTS business_receipts_date_idx    ON business_receipts (receipt_date);
CREATE INDEX IF NOT EXISTS business_receipts_vehicle_idx ON business_receipts (inventory_vehicle_id);
