-- 0065_estimate_saved_recipients.sql
-- Persist the per-estimate SEND recipient list so a manager who adds an extra address, backs out, and
-- returns finds it still there. These recipients are a per-estimate SEND choice, never the customer's
-- identity or saved contact (that stays in quick_entry_jobs.customer_email).
--
-- Tri-state column (see apps/estimates/schema.ts):
--   NULL  -> legacy row, no explicit list saved; the send default falls back to the saved contact email.
--   '{}'  -> explicitly cleared; a send stays blocked until a recipient is added.
--   {a,…} -> the saved, normalized recipient set.
--
-- Additive and idempotent: every existing row keeps NULL (legacy fallback preserved), so this is safe to
-- apply BEFORE the code deploy and safe to re-run. The new code selects this column.

ALTER TABLE estimate_intakes ADD COLUMN IF NOT EXISTS saved_recipients text[];
