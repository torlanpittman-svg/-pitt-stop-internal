-- 0044_job_parts.sql
-- Additive, non-destructive. Parts purchasing & tracking against a repair order.
-- Separate from job_line_items (billing) so a tracked part is only "ordered" once a real
-- order is recorded, and so procurement costs are never double-counted against the invoice.
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS job_parts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id       uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  job_line_item_id       uuid REFERENCES job_line_items(id) ON DELETE SET NULL,

  description            text NOT NULL,
  part_number            varchar(80),
  brand                  varchar(80),
  supplier               varchar(120),
  provider               varchar(40),
  provider_ref           varchar(120),

  quantity               numeric(10,2) NOT NULL DEFAULT 1,
  unit_cost_cents        integer,
  sell_price_cents       integer,

  status                 varchar(24) NOT NULL DEFAULT 'needed',
  supplier_order_number  varchar(120),
  ordered_at             timestamptz,
  expected_arrival       date,

  received_quantity      numeric(10,2) NOT NULL DEFAULT 0,

  is_core                boolean NOT NULL DEFAULT false,
  core_credit_cents      integer,
  returned_quantity      numeric(10,2) NOT NULL DEFAULT 0,
  return_credit_cents    integer,

  notes                  text,
  created_by             varchar(200),
  updated_by             varchar(200),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_parts_order_idx  ON job_parts (service_order_id);
CREATE INDEX IF NOT EXISTS job_parts_status_idx ON job_parts (status);
