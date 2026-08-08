-- Customer directory: a real customers + customer_vehicles directory built by
-- importing AutoLeap (primary), QuickBooks (secondary), and Quick Entry history.
-- Additive and re-runnable. No production customer data is touched by this file
-- (it only CREATEs the new directory tables). Reuses the existing vehicles table.
--
-- NOTE: avoid semicolons inside comments (the manual-migration splitter breaks on them).

-- Canonical people. One row per real customer or prospect, merged across sources.
CREATE TABLE IF NOT EXISTS customers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name             varchar(120),
  last_name              varchar(120),
  display_name           varchar(240),
  company                varchar(240),
  phone                  varchar(40),                                  -- raw as provided
  normalized_phone       varchar(20),                                  -- digits only
  email                  varchar(240),                                 -- raw as provided
  normalized_email       varchar(240),                                 -- lowercased/trimmed
  customer_type          varchar(20) NOT NULL DEFAULT 'retail',        -- retail|dealer|business|prospect
  active                 boolean NOT NULL DEFAULT true,
  source                 varchar(20) NOT NULL DEFAULT 'autoleap',      -- autoleap|quickbooks|quick_entry|manual
  source_key             varchar(240),                                 -- natural key within source (idempotency)
  autoleap_customer_id   varchar(120),                                 -- if/when a real AutoLeap id is available
  quickbooks_customer_id varchar(120),
  autoleap_vehicle_count integer,                                      -- "# Vehicles" from the AutoLeap report (reference)
  source_values          jsonb NOT NULL DEFAULT '{}'::jsonb,           -- raw per-source rows, keyed by source
  created_by_import_batch_id uuid,                                     -- the batch that first created this row (rollback)
  first_seen_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_norm_phone_idx ON customers (normalized_phone);
CREATE INDEX IF NOT EXISTS customers_norm_email_idx ON customers (normalized_email);
CREATE INDEX IF NOT EXISTS customers_source_key_idx ON customers (source, source_key);
CREATE INDEX IF NOT EXISTS customers_batch_idx ON customers (created_by_import_batch_id);

-- Customer to vehicle links (many-to-many, reuses the canonical vehicles table).
CREATE TABLE IF NOT EXISTS customer_vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  relationship  varchar(20) NOT NULL DEFAULT 'owner',
  source        varchar(20) NOT NULL DEFAULT 'autoleap',
  created_by_import_batch_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_vehicles_uniq ON customer_vehicles (customer_id, vehicle_id);
CREATE INDEX IF NOT EXISTS customer_vehicles_vehicle_idx ON customer_vehicles (vehicle_id);

-- One row per import run (dry-run or committed). Enables idempotency + rollback.
CREATE TABLE IF NOT EXISTS customer_import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source            varchar(40) NOT NULL,                              -- autoleap_customer_csv|quickbooks|quick_entry
  file_name         text,
  file_hash         varchar(64),                                       -- sha256 of the input file
  status            varchar(16) NOT NULL DEFAULT 'dry_run',            -- dry_run|committed|rolled_back
  total_rows        integer NOT NULL DEFAULT 0,
  matched_existing  integer NOT NULL DEFAULT 0,
  new_customers     integer NOT NULL DEFAULT 0,
  review_queued     integer NOT NULL DEFAULT 0,
  skipped           integer NOT NULL DEFAULT 0,
  summary           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  committed_at      timestamptz,
  rolled_back_at    timestamptz
);

-- Owner review queue: incoming rows that matched something weakly (never merged
-- automatically, e.g. name-only). The owner resolves each into merge or new.
CREATE TABLE IF NOT EXISTS possible_matches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id      uuid REFERENCES customer_import_batches(id) ON DELETE CASCADE,
  source               varchar(20) NOT NULL DEFAULT 'autoleap',
  incoming             jsonb NOT NULL,                                 -- normalized + raw incoming row
  candidate_customer_ids jsonb NOT NULL DEFAULT '[]'::jsonb,           -- existing customer ids it might be
  match_reason         varchar(60) NOT NULL,                           -- name_only|email_conflict|phone_conflict|multi_candidate
  score                numeric(4,3) NOT NULL DEFAULT 0,
  status               varchar(20) NOT NULL DEFAULT 'pending',         -- pending|merged|rejected|imported_as_new
  resolved_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  resolved_by          varchar(200),
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS possible_matches_status_idx ON possible_matches (status);
CREATE INDEX IF NOT EXISTS possible_matches_batch_idx ON possible_matches (import_batch_id);
