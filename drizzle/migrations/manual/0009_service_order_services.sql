-- Denormalized list of selected service labels shown on the Work Board card.
-- Populated by Quick Entry (standard package names + custom "Other" text).
-- Nullable: legacy orders and non-Quick-Entry sources stay null → card shows a
-- "No services listed." fallback. Display-only; no pricing / ids / catalog metadata.
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS services jsonb;
