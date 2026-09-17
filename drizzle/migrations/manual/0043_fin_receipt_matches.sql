-- CFO ↔ Receipts reconciliation link (additive, idempotent). Apply AFTER the finance schema (00xx) and
-- the business_receipts schema (0038+/0042).
--
-- The ONLY connection between employee-filed expense receipts and the finance/CFO layer: one row per
-- receipt a manager has reconciled — a CONFIRMED link to a specific bank transaction, or a DISMISSED
-- "no bank match" decision. Match SUGGESTIONS are computed on the fly and never persisted or auto-applied
-- (two equal amounts never silently link). Receipts remain a purely informational coverage layer — nothing
-- here feeds Safe-to-Spend, balances, or obligations, and no obligation is ever auto-created from a receipt.
--
-- receipt_id is the PK → idempotent (re-deciding updates in place). No cross-schema FK on purpose (loose
-- coupling; business_receipts lives in the expenses domain). Single-statement + IF NOT EXISTS so re-apply
-- is a no-op and existing data is preserved.

CREATE TABLE IF NOT EXISTS fin_receipt_matches (
  receipt_id   uuid PRIMARY KEY,
  txn_id       uuid,
  status       varchar(12) NOT NULL,
  amount_cents integer,
  matched_by   varchar(200),
  matched_at   timestamptz NOT NULL DEFAULT now(),
  evidence     jsonb
);

CREATE INDEX IF NOT EXISTS fin_receipt_matches_txn_idx ON fin_receipt_matches (txn_id);
CREATE INDEX IF NOT EXISTS fin_receipt_matches_status_idx ON fin_receipt_matches (status);
