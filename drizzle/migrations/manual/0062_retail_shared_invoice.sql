-- 0062_retail_shared_invoice.sql
-- Shared retail invoice: a later retail Job for the SAME confirmed QuickBooks customer joins an existing
-- unpaid, app-created retail invoice instead of getting its own.
--
-- The ANCHOR Job keeps owning the invoice exactly as before: job_estimates.qb_invoice_id, its PSID tag and the
-- one-invoice-per-estimate partial UNIQUE index (0019, job_estimates_qb_invoice_uniq) are unchanged. Each other
-- Job on the invoice is a MEMBER row below. A member's job_estimates.qb_invoice_id stays NULL and its qb_status
-- becomes 'linked' (set in the same statement that inserts the member row), which Create's compare-and-set
-- refuses - so a member can never also get its own invoice.
--
--   state  pending  linked, its charges are NOT on the QuickBooks invoice yet (Send / Record Payment wait)
--          applied  its charges were written onto the SAME invoice by a manager-reviewed update
--          removed  unlinked before its charges were applied (row kept for history)
--
-- rim_member_active_uniq: one active membership per Job (DB backstop for double taps and races).
-- job_estimates.qb_lines_fingerprint: hash of the QuickBooks line set Pitt Stop last wrote or verified, so an
-- update refuses when the invoice was edited in QuickBooks (never overwrites unrelated lines).
--
-- Additive and idempotent: new table + one nullable column, no backfill. Existing single-job invoicing is
-- unaffected. Plain statements only (no DO blocks, no semicolons in comments) so
-- scripts/apply-qb-migration.mjs, which splits on semicolons, applies it as-is.

ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_lines_fingerprint varchar(64);

CREATE TABLE IF NOT EXISTS retail_invoice_members (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_estimate_id       uuid NOT NULL REFERENCES job_estimates(id) ON DELETE CASCADE,
  anchor_service_order_id  uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  member_estimate_id       uuid NOT NULL REFERENCES job_estimates(id) ON DELETE CASCADE,
  member_service_order_id  uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  qb_invoice_id            varchar(100) NOT NULL,
  qb_invoice_number        varchar(100),
  state                    varchar(20) NOT NULL DEFAULT 'pending',
  link_request_id          varchar(80),
  linked_by                varchar(200),
  linked_at                timestamptz NOT NULL DEFAULT now(),
  applied_at               timestamptz,
  applied_by               varchar(200),
  applied_total_cents      integer,
  removed_at               timestamptz,
  removed_by               varchar(200),
  removed_reason           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rim_not_self CHECK (anchor_estimate_id <> member_estimate_id),
  CONSTRAINT rim_state_valid CHECK (state IN ('pending', 'applied', 'removed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS rim_member_active_uniq ON retail_invoice_members (member_estimate_id) WHERE state <> 'removed';
CREATE INDEX IF NOT EXISTS rim_anchor_active_idx ON retail_invoice_members (anchor_estimate_id) WHERE state <> 'removed';
CREATE INDEX IF NOT EXISTS rim_member_estimate_idx ON retail_invoice_members (member_estimate_id);
CREATE INDEX IF NOT EXISTS rim_anchor_estimate_idx ON retail_invoice_members (anchor_estimate_id);
CREATE INDEX IF NOT EXISTS rim_member_order_idx ON retail_invoice_members (member_service_order_id);
CREATE INDEX IF NOT EXISTS rim_anchor_order_idx ON retail_invoice_members (anchor_service_order_id);

-- Shared invoices ship dark: the feature flag defaults OFF in code (retail_qb_shared_invoice_enabled).
-- No app_settings row is written here - the owner enables it explicitly after deployed verification.
