-- Dealer Check-In enhancement — original-image storage, raw-OCR audit, retention.
-- Idempotent; applied via scripts/apply-qb-migration.mjs. All additive/nullable.

ALTER TABLE "dealer_scans" ADD COLUMN IF NOT EXISTS "image_hash"        varchar(64);
ALTER TABLE "dealer_scans" ADD COLUMN IF NOT EXISTS "raw_ocr"           jsonb;
ALTER TABLE "dealer_scans" ADD COLUMN IF NOT EXISTS "image_reviewed_at" timestamptz;
ALTER TABLE "dealer_scans" ADD COLUMN IF NOT EXISTS "image_deleted_at"  timestamptz;

-- Cleanup query hits scans that still hold an image; index the survivors.
CREATE INDEX IF NOT EXISTS "dealer_scans_image_cleanup_idx"
  ON "dealer_scans" ("created_at")
  WHERE "photo_url" IS NOT NULL AND "image_deleted_at" IS NULL;
