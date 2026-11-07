-- 0077 — "How did you hear about us?" on online bookings (2026-11-07). Companion to 0071 (service_orders) and
-- 0072 (marketing_leads): the same two columns on appointments.
-- The customer's SELF-REPORTED answer, REQUIRED on the public booking form (optional for staff phone entries). Kept
-- SEPARATE from captured click attribution (appointments.attribution: utm_* / gclid / fbclid / ref) — neither
-- overwrites the other. Check-in copies it to the Job (service_orders.referral_source/_detail, migration 0071).
-- Nullable: NULL = booked before this question, or a staff entry without an answer. No backfill.
--   referral_source : google | facebook | instagram | referral | returning | drive_by | other
--                     (the shared retail keys social | business stay valid but are not offered online)
--   referral_detail : the "Other" explanation (or an optional note), 120 chars
-- Idempotent.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS referral_source varchar(24);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS referral_detail varchar(120);
CREATE INDEX IF NOT EXISTS appointments_referral_source_idx ON appointments (referral_source) WHERE referral_source IS NOT NULL;
