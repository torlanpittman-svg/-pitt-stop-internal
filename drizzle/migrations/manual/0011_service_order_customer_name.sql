-- Work Board card title: retail customer name (Quick Entry) or dealer name
-- (Dealer Check-In). Display-only; nullable → card falls back to "Unknown Customer".
-- Additive; safe to re-run.
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS customer_name varchar(200);
