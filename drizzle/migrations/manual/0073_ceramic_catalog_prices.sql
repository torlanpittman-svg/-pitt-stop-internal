-- 0073 — Ceramic coating catalog DEFAULT prices → the two confirmed public packages (2026-11-05).
--   1-Year protection  : starting at $1,000 (one-step paint correction included)
--   3-Year protection  : starting at $2,200 (multistep paint correction, trim and rims coated)
-- Changes ONLY service_catalog.default_price_cents (the price Quick Entry / estimates pre-fill for NEW lines).
-- Existing job_estimates, service_orders, QuickBooks invoices and customer estimates are untouched.
-- Idempotent and conservative: only rows still at the old seed defaults ($800 / $2,000) are moved.
UPDATE service_catalog SET default_price_cents = 100000, updated_at = now()
  WHERE slug = 'ceramic_coating_1yr' AND archived_at IS NULL AND default_price_cents = 80000;
UPDATE service_catalog SET default_price_cents = 220000, updated_at = now()
  WHERE slug = 'ceramic_coating_3yr' AND archived_at IS NULL AND default_price_cents = 200000;
