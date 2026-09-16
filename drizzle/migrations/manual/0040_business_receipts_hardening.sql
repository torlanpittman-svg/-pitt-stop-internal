-- Business Receipts — hardening (additive, idempotent). Apply AFTER 0038/0039.
-- 1) processing_token: extraction-attempt ownership. A late/expired retry attempt can only complete or
--    release while its token still matches the row's current token → no stale overwrite.
-- 2) expense_rate_counters: durable, server-enforced ATOMIC rate limiting (cross-instance), distinct from
--    the per-receipt extraction lock. One row per (bucket, window_start); a single INSERT … ON CONFLICT
--    DO UPDATE … WHERE count < limit increments AND enforces the cap in ONE statement (the ON CONFLICT row
--    lock serializes concurrent connections — no count/insert race).
-- Single-statement, idempotent (IF NOT EXISTS); safe with the generic manual runner (splits on ';').

ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS processing_token varchar(40);

CREATE TABLE IF NOT EXISTS expense_rate_counters (
  bucket        varchar(120) NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
