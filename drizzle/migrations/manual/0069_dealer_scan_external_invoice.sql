-- 0069 — Externally managed dealer invoices (one-time Sterling Kia exception, 2026-11-03).
--
-- Additive only: one boolean column on dealer_scans, default false, no change to any existing row.
--
-- dealer_scans.qb_invoice_external = true marks a scan whose QuickBooks invoice was created BY HAND
-- in QuickBooks (not by the app). The app treats such an invoice as read-only:
--   * it is never selected as the "open invoice" that new dealer check-ins append to,
--   * the Work Board Remove flow soft-cancels the Job WITHOUT removing a line or voiding it,
--   * vehicle corrections never rewrite its line,
--   * attach/retry treat the Job as already invoiced and write nothing.
-- Normal check-ins never set it; it is only set by a deliberate, owner-approved data operation.
ALTER TABLE dealer_scans
  ADD COLUMN IF NOT EXISTS qb_invoice_external boolean NOT NULL DEFAULT false;
