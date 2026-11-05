-- 0072 — "How did you hear about us?" on public quote requests (2026-11-05). Companion to 0071 (service_orders).
-- The customer's SELF-REPORTED answer from the /quote form, stored on the lead. Kept SEPARATE from captured click
-- attribution (marketing_attribution: gclid / utm_* / fbclid). Optional: NULL = not asked / not answered.
--   referral_source : google | social | referral | returning | drive_by | business | other
--   referral_detail : optional free text, 120 chars
-- Idempotent.
ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS referral_source varchar(24);
ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS referral_detail varchar(120);
