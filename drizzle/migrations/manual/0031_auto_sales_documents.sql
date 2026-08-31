-- Auto-Sales B2 — Receipt Capture + AI: vehicle_documents.
-- ADDITIVE ONLY (new table; references inventory_vehicles). Idempotent.
-- The B0/B1 design had only a nullable vehicle_financial_events.document_id placeholder; this creates
-- the table it points at. event<->document are plain nullable uuids both ways (no DB FK cycle); many
-- events may reference ONE document, enabling future split allocation without a rewrite.
-- NOTE: no inline column comments — the manual applier strips only full-line comments.

CREATE TABLE IF NOT EXISTS vehicle_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_vehicle_id  uuid NOT NULL REFERENCES inventory_vehicles(id),
  doc_type              varchar(24) NOT NULL DEFAULT 'receipt',
  sensitivity           varchar(12) NOT NULL DEFAULT 'ordinary',
  storage               varchar(16) NOT NULL DEFAULT 'blob_public',
  storage_ref           text,
  filename              varchar(300),
  content_type          varchar(60),
  image_hash            varchar(64),
  byte_size             integer,
  receipt_total_cents   integer,
  ai_status             varchar(16) NOT NULL DEFAULT 'pending',
  ai_model              varchar(60),
  ai_raw                jsonb,
  ai_extracted          jsonb,
  confirmed             jsonb,
  linked_event_id       uuid,
  is_return             boolean NOT NULL DEFAULT false,
  original_event_id     uuid,
  uploaded_by           varchar(200),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_documents_vehicle_idx ON vehicle_documents (inventory_vehicle_id);
CREATE INDEX IF NOT EXISTS vehicle_documents_hash_idx    ON vehicle_documents (image_hash);
CREATE INDEX IF NOT EXISTS vehicle_documents_event_idx   ON vehicle_documents (linked_event_id);
