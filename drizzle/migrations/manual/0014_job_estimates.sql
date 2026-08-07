-- Phase 3: optional Job Estimate layer (manager-only). Additive, re-runnable.
-- Estimate metadata lives here (NOT on service_orders); the employee-facing
-- service_orders.services text list is unchanged. No QuickBooks/AutoLeap.

CREATE TABLE IF NOT EXISTS job_estimates (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id          uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  status                    varchar(24) NOT NULL DEFAULT 'draft',   -- draft|waiting_parts|ready_to_send|sent|approved|partially_approved|declined|converted
  tax_rate_bps              integer NOT NULL DEFAULT 825,           -- configured shop rate for taxable lines (editable)
  taxable_subtotal_cents    integer NOT NULL DEFAULT 0,
  nontaxable_subtotal_cents integer NOT NULL DEFAULT 0,
  discount_cents            integer NOT NULL DEFAULT 0,             -- reserved (V1 = 0)
  tax_cents                 integer NOT NULL DEFAULT 0,
  total_cents               integer NOT NULL DEFAULT 0,
  needs_tax_review          boolean NOT NULL DEFAULT false,         -- any line flagged for manual tax review
  customer_notes            text,
  internal_notes            text,
  sent_at                   timestamptz,
  decided_at                timestamptz,
  converted_at              timestamptz,
  created_by                varchar(200),
  updated_by                varchar(200),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_estimates_order_uniq ON job_estimates (service_order_id);

CREATE TABLE IF NOT EXISTS job_services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_estimate_id uuid NOT NULL REFERENCES job_estimates(id) ON DELETE CASCADE,
  title           varchar(200) NOT NULL,
  approval_state  varchar(16) NOT NULL DEFAULT 'pending',          -- pending|approved|declined|deferred
  technician      varchar(200),
  notes           text,
  source          varchar(24) NOT NULL DEFAULT 'manual',           -- manual|promoted|labor_guide|catalog
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_services_estimate_idx ON job_services (job_estimate_id);

CREATE TABLE IF NOT EXISTS job_line_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_service_id uuid NOT NULL REFERENCES job_services(id) ON DELETE CASCADE,
  type           varchar(12) NOT NULL,                             -- labor|part|fee|sublet
  name           varchar(200) NOT NULL,
  description    text,
  qty            numeric(10,2) NOT NULL DEFAULT 1,
  unit           varchar(12) NOT NULL DEFAULT 'each',              -- hours|each
  cost_cents     integer NOT NULL DEFAULT 0,
  price_cents    integer NOT NULL DEFAULT 0,
  taxable        boolean NOT NULL DEFAULT false,
  tax_category   varchar(30) NOT NULL DEFAULT 'other',             -- repair_parts|mechanical_labor|taxable_consumable|remodeling|detailing|collision|exempt|fee|sublet|review|other
  sort_order     integer NOT NULL DEFAULT 0,
  part_number    varchar(80),
  brand          varchar(80),
  supplier       varchar(120),
  provider       varchar(40),                                      -- future labor-guide/parts provider
  provider_ref   varchar(120),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_line_items_service_idx ON job_line_items (job_service_id);
