-- Business Receipts — hardening (additive, idempotent). Apply AFTER 0038/0039.
-- 1) processing_token: extraction-attempt ownership. A late/expired retry attempt can only complete or
--    release while its token still matches the row's current token → no stale overwrite.
-- 2) expense_rate_events: durable, server-enforced rate-limit events (cross-instance), distinct from the
--    per-receipt extraction lock. A windowed COUNT per bucket bounds uploads + AI extraction attempts.
-- Single-statement, idempotent (IF NOT EXISTS); safe with the generic manual runner (splits on ';').

ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS processing_token varchar(40);

CREATE TABLE IF NOT EXISTS expense_rate_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket      varchar(120) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expense_rate_events_bucket_idx ON expense_rate_events (bucket, created_at);
