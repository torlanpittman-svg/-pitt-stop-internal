-- 0066: Oil-change reminder stickers (Brother QL-800 label printing through the existing
-- cloud print queue). Additive only — nothing existing is altered or dropped.

-- Durable record of every sticker issued (also the per-vehicle mileage history for prefill).
CREATE TABLE IF NOT EXISTS oil_change_stickers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL,
  vehicle_id      uuid,
  mileage         integer NOT NULL,
  interval_miles  integer,
  interval_months integer,
  next_mileage    integer NOT NULL,
  next_date       date NOT NULL,
  next_date_text  varchar(40) NOT NULL,
  created_by      varchar(120),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oil_stickers_order_idx   ON oil_change_stickers (order_id);
CREATE INDEX IF NOT EXISTS oil_stickers_vehicle_idx ON oil_change_stickers (vehicle_id, created_at);

-- Duplicate prevention: at most ONE waiting sticker job per order in the shared print queue
-- (double-tap / two phones can never cut two stickers). Mirrors print_jobs_one_active_per_check.
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_one_waiting_sticker_per_order
  ON print_jobs ((payload->>'orderId'))
  WHERE kind = 'sticker' AND status IN ('queued', 'claimed') AND (payload->>'orderId') IS NOT NULL;

-- Which label printer (if any) each bridge declares; NULL = bridge cannot print stickers.
ALTER TABLE print_bridges ADD COLUMN IF NOT EXISTS label_printer varchar(120);
