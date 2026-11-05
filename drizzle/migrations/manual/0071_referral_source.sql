-- 0071 — "How did you hear about us?" on retail intake (2026-11-05).
-- Self-reported customer answer captured at Quick Entry. Kept SEPARATE from captured click attribution
-- (appointments.attribution / marketing_attribution carry gclid, utm_* and fbclid); this column is what the
-- customer SAID, never what a tracking parameter proved. Optional: NULL = not asked / not answered.
--   referral_source : google | social | referral | returning | drive_by | business | other
--   referral_detail : optional free text (who referred them, which post, etc.), 120 chars
-- Idempotent.
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS referral_source varchar(24);
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS referral_detail varchar(120);
CREATE INDEX IF NOT EXISTS service_orders_referral_source_idx ON service_orders (referral_source) WHERE referral_source IS NOT NULL;
