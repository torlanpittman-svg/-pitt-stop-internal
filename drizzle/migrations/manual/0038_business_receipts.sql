-- Business Receipts / Expense Capture — general business-wide expense receipts.
-- ADDITIVE ONLY (new table; no existing table touched). Idempotent (IF NOT EXISTS everywhere).
-- The GENERAL expense path (Detail AND Auto Sales). A general shop expense needs no vehicle;
-- inventory_vehicle_id is a nullable FK to inventory_vehicles with ON DELETE SET NULL (an optional
-- canonical link that clears — never cascades a delete — if a vehicle is removed/merged).
-- Applied via the generic manual runner (scripts/apply-qb-migration.mjs <this file>): statements are
-- split on ';' and each is idempotent, so there are NO multi-statement DO blocks here.
-- NOTE: no inline column comments — the manual applier strips only full-line comments.
--
-- FRESH INSTALL: CREATE TABLE below adds the inventory_vehicle_id FK inline (correct on first apply).
-- ALREADY-CREATED TABLE (rare — 0038 was never applied in prod, but a partial/aborted apply is possible):
-- CREATE TABLE IF NOT EXISTS is a no-op and will NOT add a missing FK. If the table already exists WITHOUT
-- the FK, add it once manually (idempotent guard shown; run in psql, not via the ';'-splitting runner):
--   DO $$ BEGIN
--     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_receipts_inv_veh_fk') THEN
--       ALTER TABLE business_receipts
--         ADD CONSTRAINT business_receipts_inv_veh_fk
--         FOREIGN KEY (inventory_vehicle_id) REFERENCES inventory_vehicles(id) ON DELETE SET NULL;
--     END IF;
--   END $$;
-- Application-level validation (db.inventoryVehicleExists) independently blocks a nonexistent vehicle id
-- at review/approve time, so an approved receipt can never reference a missing vehicle even without the FK.

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
  inventory_vehicle_id  uuid REFERENCES inventory_vehicles(id) ON DELETE SET NULL,
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
