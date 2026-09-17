-- Business Receipts — employee self-filing (additive, idempotent). Apply AFTER 0038/0039/0040.
--
-- Adds the columns needed for the tap-first employee filing flow WITHOUT touching any existing row:
--   * a new 'filed' status is used going forward (no data change — existing needs_review/approved/rejected
--     rows keep their status; historical pending receipts are NOT auto-converted to filed).
--   * funding: WHO paid / WHETHER paid (business|personal|unpaid|unknown), SEPARATE from payment_method so
--     reporting can split real business cash outflow from a personal reimbursement owed and an unpaid buy.
--   * filing_note: the employee's optional short explanation at filing time.
--   * attention_reasons: why a receipt sits in the "Needs attention" queue ([] for a clean filing).
--   * filed_by / filed_by_key / filed_at: the ACTUAL person who completed the operational filing (distinct
--     from approved_by so an employee filing is never misattributed as a manager approval).
--   * uploaded_by_key: the uploader's server-verified identity key (null for a shared-PIN device) — powers
--     "an employee may finalize only a receipt they uploaded".
--
-- Every statement is single-statement + IF NOT EXISTS (safe with the generic manual runner that splits on
-- ';'), so a re-apply is a no-op and existing data is preserved.

ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS funding varchar(16) NOT NULL DEFAULT 'unknown';
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS filing_note text;
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS attention_reasons jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS filed_by varchar(200);
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS filed_by_key varchar(60);
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS filed_at timestamptz;
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS uploaded_by_key varchar(60);

CREATE INDEX IF NOT EXISTS business_receipts_funding_idx ON business_receipts (funding);
CREATE INDEX IF NOT EXISTS business_receipts_uploader_key_idx ON business_receipts (uploaded_by_key);
