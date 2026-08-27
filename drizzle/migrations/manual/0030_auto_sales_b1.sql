-- Auto-Sales B1 — Returns/Refunds/Credits + Sale/Closeout.
-- ADDITIVE ONLY (new nullable columns on existing B0 tables). Idempotent.

-- Refund lifecycle on the ledger (return/refund/credit events). Economic reduction is recognized via
-- the event itself; these track how/whether cash actually comes back — separate from economic effect.
ALTER TABLE vehicle_financial_events ADD COLUMN IF NOT EXISTS refund_status              varchar(16);  -- expected|pending|settled
ALTER TABLE vehicle_financial_events ADD COLUMN IF NOT EXISTS refund_method              varchar(20);  -- cash|card|vendor_credit|store_credit|exchange|other
ALTER TABLE vehicle_financial_events ADD COLUMN IF NOT EXISTS refund_destination_account varchar(40);
ALTER TABLE vehicle_financial_events ADD COLUMN IF NOT EXISTS settled_at                 date;

-- Sale / closeout facts on the inventory vehicle (status/disposition/sold_at already exist in B0).
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_price_cents   integer;
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_type          varchar(20);  -- retail|wholesale
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS proceeds_account   varchar(40);
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS buyer_ref          varchar(200);
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS payoff_known_cents integer;
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS payoff_status      varchar(16);  -- open|paid|unknown|none
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS proceeds_received  varchar(16);  -- yes|no|unknown
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS title_outstanding  boolean;
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS closeout_notes     text;
