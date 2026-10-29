-- 0066_part_screenshot_imports.sql
-- Additive, non-destructive. "Import parts from a PartsTech screenshot" — upload 1–4 screenshots of a
-- NAPA/O'Reilly cart/quote/order against a specific Job, AI reads the line items into a PROPOSAL, a
-- manager reviews prices and applies it into ordinary job_parts rows (status 'needed').
--
-- This NEVER bills, never writes to QuickBooks, and never records received/paid. For a CONFIRMED purchase
-- screenshot (document_kind='purchase' with a supplier AND order reference) a manager may choose "already
-- placed" so new parts land 'ordered' with the supplier/order # in one tap — it still never marks received/
-- paid and never sends a real supplier order. It only adds new tables + one nullable provenance column on
-- job_parts. Ships behind PARTS_SCREENSHOT_IMPORT_ENABLED (default OFF) — safe to apply before the flag is
-- on. Safe to re-run.

-- ── Provenance on the existing tracked-parts table ─────────────────────────────────────────────────────
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS import_row_id uuid;

-- ── Batches: one upload session bound to a service order ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS part_import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id  uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  status            varchar(16) NOT NULL DEFAULT 'uploaded',   -- uploaded|reading|proposed|applied|failed|cancelled

  capture_id        varchar(64),
  batch_hash        varchar(64),

  document_kind     varchar(12) NOT NULL DEFAULT 'unknown',    -- purchase|quote|cart|unknown
  supplier          varchar(120),
  order_reference   varchar(120),
  tax_cents         integer,
  shipping_cents    integer,
  core_cents        integer,

  -- Manager "this order was already placed" choice (honored only for a confirmed purchase WITH supplier +
  -- order reference, re-validated at apply). + explicit legitimate-duplicate confirmation.
  mark_ordered        boolean NOT NULL DEFAULT false,
  duplicate_confirmed boolean NOT NULL DEFAULT false,

  -- Optimistic-concurrency revision (bumped on claim/read/review/apply/cancel).
  revision          integer NOT NULL DEFAULT 0,

  ai_status         varchar(16) NOT NULL DEFAULT 'pending',    -- pending|extracted|failed
  ai_model          varchar(60),
  ai_raw            jsonb,
  read_warnings     jsonb,                                     -- {supplier,orderReference,documentKind,unreadImages,truncated}
  processing_token  varchar(40),

  uploaded_by       varchar(200),
  uploaded_by_key   varchar(60),
  reviewed_by       varchar(200),
  reviewed_at       timestamptz,
  applied_by        varchar(200),
  applied_at        timestamptz,
  cancelled_at      timestamptz,
  notes             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT part_import_batches_status_chk    CHECK (status IN ('uploaded','reading','proposed','applied','failed','cancelled')),
  CONSTRAINT part_import_batches_kind_chk      CHECK (document_kind IN ('purchase','quote','cart','unknown')),
  CONSTRAINT part_import_batches_ai_status_chk CHECK (ai_status IN ('pending','extracted','failed')),
  CONSTRAINT part_import_batches_cents_chk     CHECK ((tax_cents IS NULL OR tax_cents >= 0) AND (shipping_cents IS NULL OR shipping_cents >= 0) AND (core_cents IS NULL OR core_cents >= 0))
);

CREATE INDEX IF NOT EXISTS part_import_batches_order_idx    ON part_import_batches (service_order_id);
CREATE INDEX IF NOT EXISTS part_import_batches_status_idx   ON part_import_batches (status);
CREATE INDEX IF NOT EXISTS part_import_batches_supplier_idx ON part_import_batches (service_order_id, supplier, order_reference);
-- A retry (same capture_id) or identical screenshots (same batch_hash) resume the active batch — one each per order.
CREATE UNIQUE INDEX IF NOT EXISTS part_import_batches_capture_uniq ON part_import_batches (service_order_id, capture_id) WHERE capture_id IS NOT NULL AND status <> 'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS part_import_batches_hash_uniq    ON part_import_batches (service_order_id, batch_hash) WHERE batch_hash IS NOT NULL AND status <> 'cancelled';
-- Applied-dedup GUARD: at most one APPLIED, non-duplicate-confirmed batch per (order, supplier, order ref).
-- Two concurrent applies of the same supplier order can't both reach 'applied'; a genuine additional import
-- is allowed only with duplicate_confirmed = true (explicit manager review).
CREATE UNIQUE INDEX IF NOT EXISTS part_import_batches_applied_order_uniq
  ON part_import_batches (service_order_id, lower(supplier), lower(order_reference))
  WHERE status = 'applied' AND duplicate_confirmed = false AND supplier IS NOT NULL AND order_reference IS NOT NULL;

-- ── Images: the preserved private screenshots of a batch ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS part_import_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES part_import_batches(id) ON DELETE CASCADE,
  ordinal       integer NOT NULL DEFAULT 0,
  image_hash    varchar(64) NOT NULL,
  storage_ref   text NOT NULL,
  content_type  varchar(60),
  byte_size     integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT part_import_images_bytes_chk CHECK (byte_size IS NULL OR (byte_size > 0 AND byte_size <= 8388608))
);

CREATE INDEX IF NOT EXISTS part_import_images_batch_idx ON part_import_images (batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS part_import_images_batch_hash_uniq ON part_import_images (batch_id, image_hash);

-- ── Rows: the extracted line-item PROPOSAL (unverified) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS part_import_rows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid NOT NULL REFERENCES part_import_batches(id) ON DELETE CASCADE,
  source_image_id  uuid REFERENCES part_import_images(id) ON DELETE SET NULL,
  ordinal          integer NOT NULL DEFAULT 0,

  description      text,
  part_number      varchar(80),
  brand            varchar(80),
  supplier         varchar(120),
  quantity         numeric(10,2),                             -- NULL when unreadable; reviewer confirms before apply
  unit_cost_cents  integer,                                   -- visible PURCHASE/unit cost (the only cost carried onto a part)
  list_price_cents integer,                                   -- MSRP/list, metadata only
  line_total_cents integer,                                   -- line total, metadata only

  link_decision    varchar(8) NOT NULL DEFAULT 'new',         -- new|link|skip
  matched_part_id  uuid REFERENCES job_parts(id) ON DELETE SET NULL,
  applied_part_id  uuid,
  notes            text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT part_import_rows_decision_chk CHECK (link_decision IN ('new','link','skip')),
  CONSTRAINT part_import_rows_qty_chk      CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT part_import_rows_cents_chk     CHECK ((unit_cost_cents IS NULL OR unit_cost_cents >= 0) AND (list_price_cents IS NULL OR list_price_cents >= 0) AND (line_total_cents IS NULL OR line_total_cents >= 0))
);

CREATE INDEX IF NOT EXISTS part_import_rows_batch_idx   ON part_import_rows (batch_id);
CREATE INDEX IF NOT EXISTS part_import_rows_image_idx   ON part_import_rows (source_image_id);
CREATE INDEX IF NOT EXISTS part_import_rows_matched_idx ON part_import_rows (matched_part_id);

-- ── Provenance FK + guard on job_parts (added after part_import_rows exists) ────────────────────────────
DO $$ BEGIN
  ALTER TABLE job_parts ADD CONSTRAINT job_parts_import_row_fk
    FOREIGN KEY (import_row_id) REFERENCES part_import_rows(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS job_parts_import_row_idx ON job_parts (import_row_id);
-- At most one LIVE part per import proposal row — a retried/double-tapped/concurrent apply can't duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS job_parts_import_row_uniq ON job_parts (import_row_id) WHERE import_row_id IS NOT NULL AND status <> 'cancelled';
