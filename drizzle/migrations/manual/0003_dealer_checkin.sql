-- Phase 2 — Dealer Check-In data model.
-- Idempotent; applied via scripts/apply-qb-migration.mjs.

CREATE TABLE IF NOT EXISTS "dealer_scans" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at"            timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"            timestamp with time zone DEFAULT now() NOT NULL,
  "dealership_id"         uuid,
  "raw_barcode"           varchar(100),
  "vin"                   varchar(17),
  "vin_source"            varchar(20),
  "vin_confidence"        integer,
  "stock_number"          varchar(100),
  "stock_source"          varchar(20),
  "stock_confidence"      integer,
  "year"                  varchar(4),
  "make"                  varchar(100),
  "model"                 varchar(100),
  "color"                 varchar(100),
  "tag_color"             varchar(20),
  "pricing_prompt_shown"  boolean DEFAULT false NOT NULL,
  "rate"                  integer,
  "nhtsa_year"            varchar(4),
  "nhtsa_make"            varchar(100),
  "nhtsa_model"           varchar(100),
  "photo_url"             text,
  "crop_url"              text,
  "status"                varchar(30) DEFAULT 'pending' NOT NULL,
  "approved_at"           timestamp with time zone,
  "approved_by"           varchar(200),
  "invoice_batch_id"      uuid,
  "qb_line_id"            varchar(100),
  "qb_invoice_number"     varchar(100),
  "qb_sync_status"        varchar(30),
  "qb_sync_error"         text,
  "qb_synced_at"          timestamp with time zone,
  "service_order_id"      uuid,
  "data_type"             varchar(20) DEFAULT 'production' NOT NULL
);

CREATE INDEX IF NOT EXISTS "dealer_scans_status_idx"     ON "dealer_scans" ("status");
CREATE INDEX IF NOT EXISTS "dealer_scans_dealership_idx" ON "dealer_scans" ("dealership_id");
CREATE INDEX IF NOT EXISTS "dealer_scans_stock_idx"      ON "dealer_scans" ("stock_number");
CREATE INDEX IF NOT EXISTS "dealer_scans_vin_idx"        ON "dealer_scans" ("vin");
CREATE INDEX IF NOT EXISTS "dealer_scans_created_idx"    ON "dealer_scans" ("created_at");

CREATE TABLE IF NOT EXISTS "dealer_scan_events" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scan_id"    uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "event_type" varchar(50) NOT NULL,
  "actor"      varchar(200),
  "old_value"  jsonb,
  "new_value"  jsonb,
  "note"       text
);

CREATE INDEX IF NOT EXISTS "dealer_scan_events_scan_idx" ON "dealer_scan_events" ("scan_id");
CREATE INDEX IF NOT EXISTS "dealer_scan_events_type_idx" ON "dealer_scan_events" ("event_type");
