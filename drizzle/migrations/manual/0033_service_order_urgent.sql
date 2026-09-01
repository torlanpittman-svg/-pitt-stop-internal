-- 0033 — Operational URGENCY on a Job (independent of source/status).
-- Additive, NOT NULL DEFAULT false → every existing Job behaves as Normal; no backfill.
-- Visual + sort priority only: no effect on status, pricing, agreed_price, production math,
-- invoice/dealer pricing, or Auto Sales/CFO.
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS is_urgent boolean NOT NULL DEFAULT false;
