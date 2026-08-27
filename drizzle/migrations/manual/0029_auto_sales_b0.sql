-- Auto-Sales Vehicle Financial System — B0 (Canonical Inventory + Basic Ledger)
-- ADDITIVE ONLY. References the canonical `vehicles` table; modifies no existing table.
-- Idempotent (IF NOT EXISTS). Applied by scripts/apply-qb-migration.mjs.

CREATE TABLE IF NOT EXISTS inventory_vehicles (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id             uuid NOT NULL REFERENCES vehicles(id),
  stock_number           varchar(40),
  segment                varchar(20) NOT NULL DEFAULT 'auto_sales',
  status                 varchar(20) NOT NULL DEFAULT 'acquired',
  acquisition_source     varchar(40),
  seller                 varchar(200),
  title_status           varchar(40),
  acquired_at            date,
  listed_price_cents     integer,
  disposition            varchar(20),
  sold_at                date,
  delivered_at           date,
  origin                 varchar(24) NOT NULL DEFAULT 'quick_entry',
  pre_cutover            boolean NOT NULL DEFAULT false,
  tracking_start_date    date,
  financial_completeness varchar(30) NOT NULL DEFAULT 'needs_review',
  notes                  text,
  created_by             varchar(200),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_vehicles_vehicle_uniq ON inventory_vehicles (vehicle_id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_vehicles_stock_uniq  ON inventory_vehicles (stock_number);
CREATE INDEX        IF NOT EXISTS inventory_vehicles_status_idx  ON inventory_vehicles (status);
CREATE INDEX        IF NOT EXISTS inventory_vehicles_completeness_idx ON inventory_vehicles (financial_completeness);

CREATE TABLE IF NOT EXISTS vehicle_financial_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_vehicle_id uuid NOT NULL REFERENCES inventory_vehicles(id),
  economic_category    varchar(30) NOT NULL,
  cashflow_category    varchar(24) NOT NULL,
  accounting_treatment varchar(30) NOT NULL DEFAULT 'unknown_confirm',
  amount_cents         integer NOT NULL,
  event_date           date NOT NULL,
  vendor               varchar(200),
  memo                 text,
  payment_account_ref  varchar(40),
  fin_transaction_id   uuid,
  original_event_id    uuid,
  reverses_event_id    uuid,
  related_event_id     uuid,
  status               varchar(16) NOT NULL DEFAULT 'verified',
  confidence           varchar(16) NOT NULL DEFAULT 'manual',
  source               varchar(20) NOT NULL DEFAULT 'manual',
  document_id          uuid,
  evidence             jsonb,
  created_by           varchar(200),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vfe_vehicle_idx  ON vehicle_financial_events (inventory_vehicle_id);
CREATE INDEX IF NOT EXISTS vfe_date_idx     ON vehicle_financial_events (event_date);
CREATE INDEX IF NOT EXISTS vfe_econ_idx     ON vehicle_financial_events (economic_category);
CREATE INDEX IF NOT EXISTS vfe_original_idx ON vehicle_financial_events (original_event_id);
