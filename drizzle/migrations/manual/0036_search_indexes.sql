-- Global operational search — additive, idempotent supporting indexes.
--
-- Search reuses the CANONICAL tables (no new/parallel tables). Most exact-match hot paths are ALREADY
-- indexed by prior migrations: service_orders.order_number (unique), inventory_vehicles.stock_number
-- (unique), vehicles.vin, customers.normalized_phone / normalized_email, dealer_scans.vin/stock. This
-- migration only adds the two identifier lookups search introduces that were not yet covered:
--   * checks.check_number        — "search a check number" (manager-only) exact/prefix lookup
--   * job_estimates.qb_invoice_number — job/invoice-number search → the linked Job
--
-- Substring/service text search (ILIKE '%…%') is served by sequential scans, which are fast at the
-- current operational scale (hundreds–low-thousands of rows). No database EXTENSION is enabled here
-- (pg_trgm is NOT installed); introducing one would be a separate, verified change. ADDITIVE ONLY —
-- safe to re-run; touches no data and no existing table structure.

CREATE INDEX IF NOT EXISTS checks_number_idx              ON checks (check_number);
CREATE INDEX IF NOT EXISTS job_estimates_qb_invoice_idx   ON job_estimates (qb_invoice_number);
