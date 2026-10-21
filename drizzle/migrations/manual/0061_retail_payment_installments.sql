-- 0061_retail_payment_installments.sql
-- Retail Record Payment: partial payments / later installments against the SAME linked invoice.
--
-- qb_payment_status (0059) stays the state of the LATEST payment attempt and gains one value, 'recorded'
-- (that installment is confirmed in QuickBooks and a balance remains). The columns below cache the
-- invoice's QuickBooks-confirmed AGGREGATE from the last read, kept separate from the attempt state:
--   qb_payment_balance_state  unpaid | partial | paid   (NULL = not read since this migration)
--   qb_payment_received_cents money received by Payments; qb_payment_credit_cents = credits/adjustments.
-- They drive the summary card and the invoice lock (no Sync / fee change once money is applied). They are
-- NOT a ledger: QuickBooks remains the money authority, per-payment history is read from it, and the
-- append-only audit stays in service_order_events.
--
-- Additive, nullable, no defaults, no backfill, idempotent: existing paid rows (qb_payment_status='paid')
-- and any unresolved attempt keep working unchanged. Plain statements only (no DO blocks) so
-- scripts/apply-qb-migration.mjs, which splits on ';', applies it as-is.

ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_balance_state varchar(20);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_total_cents integer;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_balance_cents integer;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_received_cents integer;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_credit_cents integer;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_checked_at timestamptz;
