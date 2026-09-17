-- Business Receipts — stable capture id for retry-safe uploads (additive, idempotent). Apply AFTER
-- 0038/0039/0040/0042/0044.
--
-- image_hash (0039) dedupes IDENTICAL files only; retaking a photo changes the bytes, so a "the upload
-- timed out — try again" retry created a SECOND receipt (a duplicate purchase — the observed Costco case).
-- capture_id is a stable per-capture identifier the client keeps across retries: a partial UNIQUE index
-- (one active, non-rejected row per capture_id) makes a retry return the already-saved receipt instead of a
-- second one. Re-uploads after a rejection stay allowed (rejected rows are excluded from the index).
--
-- Single-statement + IF NOT EXISTS so a re-apply is a no-op and existing data is preserved.

ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS capture_id varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS business_receipts_capture_active_uniq
  ON business_receipts (capture_id)
  WHERE capture_id IS NOT NULL AND status <> 'rejected';
