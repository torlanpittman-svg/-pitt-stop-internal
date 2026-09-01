-- 0032 — Employee-set EXPECTED/operational Job value at intake.
-- Additive + nullable; no backfill. SEPARATE from explicit_total_cents (manager invoice authority):
-- agreed_price_cents is the pre-fee/pre-tax expected work value used for Production when no manager
-- price exists; agreed_meta is the per-service audit (employee text, matched family, suggested price
-- + sample size, confirmed price). Neither touches the customer invoice / fees / tax / QuickBooks.
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS agreed_price_cents integer;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS agreed_meta jsonb;
