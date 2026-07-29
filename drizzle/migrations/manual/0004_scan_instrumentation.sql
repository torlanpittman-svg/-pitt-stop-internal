-- Phase 3 — instrumentation columns on dealer_scans.
-- Idempotent; applied via scripts/apply-qb-migration.mjs.

ALTER TABLE "dealer_scans" ADD COLUMN IF NOT EXISTS "scan_duration_ms" integer;
ALTER TABLE "dealer_scans" ADD COLUMN IF NOT EXISTS "qb_latency_ms"    integer;
