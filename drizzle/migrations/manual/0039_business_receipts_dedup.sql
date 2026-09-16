-- Business Receipts — DB-ENFORCED upload idempotency (additive, idempotent).
-- A PARTIAL UNIQUE index on image_hash over NON-rejected rows: two concurrent identical uploads cannot
-- both insert (the loser hits a unique violation → the app returns the existing receipt, so no duplicate
-- expense). Rejected rows are excluded, so re-uploading a previously-rejected receipt is still allowed.
-- Single-statement, idempotent (IF NOT EXISTS); safe with the generic manual runner (splits on ';').
-- Apply AFTER 0038 (requires the business_receipts table to exist).

CREATE UNIQUE INDEX IF NOT EXISTS business_receipts_hash_active_uniq
  ON business_receipts (image_hash)
  WHERE status <> 'rejected';
