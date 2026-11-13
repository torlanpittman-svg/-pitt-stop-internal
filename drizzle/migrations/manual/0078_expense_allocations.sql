-- 0078 — Job expenses: link a purchase (business_receipts row) to customer jobs / overhead (2026-11-13).
--
-- ONE PURCHASE = ONE business_receipts ROW. That row is already the purchase identity (hash + capture_id
-- dedup, append-only audit_log, inventory_vehicle_id for sales-inventory cars, fin_receipt_matches for the
-- bank/card transaction, qb_* reserved for the QuickBooks record). This migration adds the missing piece:
-- an ALLOCATION of that same purchase to a customer job (service_orders) or to overhead.
--
-- An allocation is a POINTER, never a second expense: business totals keep summing business_receipts and
-- never read this table, so attaching a job cannot raise total business expenses.
--
--   amount_cents NULL  = the WHOLE purchase belongs to this target (follows the receipt total, so a later
--                        correction of the total flows through; shipping + tax are inside the total, once).
--   amount_cents > 0   = an explicit SPLIT amount (several jobs and/or overhead; must reconcile to the total,
--                        any remainder stays visible as unallocated).
--   status 'removed'   = soft removal (reassignment / correction). Rows are never deleted; replaced_by points
--                        at the allocation that superseded it, and the receipt's audit_log records the change.
--   job_part_id        = optional: the job part line that represents this same purchase (so a part's internal
--                        cost and the receipt are reconciled instead of being added together).
--
-- Also adds four nullable receipt facts the reader can now extract. Additive + idempotent. No backfill.
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS shipping_cents integer;
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS invoice_number varchar(80);
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS order_number varchar(80);
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS description text;

CREATE TABLE IF NOT EXISTS expense_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id       uuid NOT NULL REFERENCES business_receipts(id),
  target           varchar(16) NOT NULL,
  service_order_id uuid REFERENCES service_orders(id),
  job_part_id      uuid REFERENCES job_parts(id) ON DELETE SET NULL,
  amount_cents     integer,
  note             text,
  status           varchar(12) NOT NULL DEFAULT 'active',
  created_by       varchar(200),
  created_by_key   varchar(60),
  created_at       timestamptz NOT NULL DEFAULT now(),
  removed_by       varchar(200),
  removed_at       timestamptz,
  removed_reason   text,
  replaced_by      uuid,
  CONSTRAINT expense_allocations_target_chk CHECK (target IN ('job', 'overhead')),
  CONSTRAINT expense_allocations_job_chk CHECK ((target = 'job') = (service_order_id IS NOT NULL)),
  CONSTRAINT expense_allocations_amount_chk CHECK (amount_cents IS NULL OR amount_cents > 0),
  CONSTRAINT expense_allocations_status_chk CHECK (status IN ('active', 'removed'))
);

CREATE INDEX IF NOT EXISTS expense_allocations_receipt_idx ON expense_allocations (receipt_id);
CREATE INDEX IF NOT EXISTS expense_allocations_order_idx ON expense_allocations (service_order_id) WHERE service_order_id IS NOT NULL;
-- One ACTIVE allocation per (purchase, job): a double-tap / retry cannot attach the same receipt to the
-- same job twice.
CREATE UNIQUE INDEX IF NOT EXISTS expense_allocations_job_active_uniq ON expense_allocations (receipt_id, service_order_id) WHERE status = 'active' AND target = 'job';
-- One ACTIVE overhead allocation per purchase.
CREATE UNIQUE INDEX IF NOT EXISTS expense_allocations_overhead_active_uniq ON expense_allocations (receipt_id) WHERE status = 'active' AND target = 'overhead';
-- At most one ACTIVE whole-purchase allocation per purchase (a purchase cannot be wholly owned twice).
CREATE UNIQUE INDEX IF NOT EXISTS expense_allocations_whole_active_uniq ON expense_allocations (receipt_id) WHERE status = 'active' AND amount_cents IS NULL;
CREATE INDEX IF NOT EXISTS business_receipts_invoice_number_idx ON business_receipts (invoice_number) WHERE invoice_number IS NOT NULL;
