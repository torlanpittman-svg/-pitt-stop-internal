-- P-B1: additive commercial-layer fields on job_estimates. Enables a manager pricing
-- layer for retail Jobs LATER without changing the Quick Entry front-end today. Every
-- default preserves current behavior: price_mode='itemized' and unpriced, so existing
-- and new Jobs stay itemized / $0 until a manager explicitly prices them in P-B2.
-- No existing field is deleted or repurposed. Additive and re-runnable.
-- NOTE: no semicolons inside comments (the manual-migration splitter breaks on them).

ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS price_mode varchar(20) NOT NULL DEFAULT 'itemized';
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS explicit_total_cents integer;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS explicit_tax_category varchar(30) NOT NULL DEFAULT 'review';
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS waive_shop_supplies boolean NOT NULL DEFAULT false;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS waive_card_fee boolean NOT NULL DEFAULT false;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS tax_exempt boolean NOT NULL DEFAULT false;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS pricing_set_by varchar(200);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS pricing_set_at timestamptz;
