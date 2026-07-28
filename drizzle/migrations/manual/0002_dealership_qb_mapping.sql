-- Phase 2 (partial) — QuickBooks customer mapping columns on dealerships.
-- Verified customer IDs are written from a live QB lookup, never hardcoded.
-- Applied via scripts/apply-qb-migration.mjs style idempotent runner.

ALTER TABLE "dealerships" ADD COLUMN IF NOT EXISTS "qb_customer_id"   varchar(200);
ALTER TABLE "dealerships" ADD COLUMN IF NOT EXISTS "qb_customer_name" varchar(200);
ALTER TABLE "dealerships" ADD COLUMN IF NOT EXISTS "billing_email"    varchar(200);
ALTER TABLE "dealerships" ADD COLUMN IF NOT EXISTS "tax_exempt"       boolean DEFAULT true NOT NULL;
ALTER TABLE "dealerships" ADD COLUMN IF NOT EXISTS "rate_default"     integer DEFAULT 200 NOT NULL;
