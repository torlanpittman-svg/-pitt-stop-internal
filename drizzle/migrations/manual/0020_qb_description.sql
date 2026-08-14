-- Phase 1b: managed canonical retail service description that flows Estimate → Invoice
-- Draft → retail QuickBooks line Description. Additive, nullable; null → fall back to the
-- service name. Does NOT repurpose any existing field. No dealer/pricing impact.
-- Convention: idempotent, additive only, no semicolons in comments.

ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS qb_description text;
