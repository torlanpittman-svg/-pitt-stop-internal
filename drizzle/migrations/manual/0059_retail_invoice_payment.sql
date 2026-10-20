-- 0059_retail_invoice_payment.sql
-- Retail Record Payment: a counter payment (cash / card terminal / check) recorded as a QuickBooks
-- Payment applied to the job's EXISTING linked retail invoice, plus the explicit "Email Paid Invoice".
-- Payment state and paid-invoice email state are separate columns, both separate from qb_status
-- (invoice create/send). History stays append-only in service_order_events.
--
-- Additive and idempotent: safe to re-run. Defaults keep every existing row at 'none'. Dealer
-- QuickBooks state (dealer_scans) is untouched. Plain statements only (no DO blocks) so
-- scripts/apply-qb-migration.mjs, which splits on ';', applies it as-is.

ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_status varchar(20) NOT NULL DEFAULT 'none';
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_id varchar(100);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_method varchar(20);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_amount_cents integer;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_request_id varchar(80);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_error text;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_started_at timestamptz;
-- Cash / Check: this attempt removed the card-payment charge (waive_card_fee) before syncing the same invoice
-- to the cash total. Lets an interrupted attempt be resumed (re-sync, then pay) or a failed one undone.
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_payment_card_fee_removed boolean NOT NULL DEFAULT false;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_paid_at timestamptz;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_paid_by varchar(200);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_paid_email_status varchar(20) NOT NULL DEFAULT 'none';
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_paid_email_to varchar(320);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_paid_email_started_at timestamptz;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_paid_email_sent_at timestamptz;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_paid_email_error text;
-- QuickBooks Invoice.DeliveryInfo.DeliveryTime seen when the paid-invoice send was locked: confirmation of
-- THIS send requires a strictly later delivery (an earlier unpaid-invoice email is never mistaken for it).
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_paid_email_prior_delivery_at timestamptz;

-- No unique index on qb_payment_id: one customer payment received online can legitimately pay several
-- invoices (one QuickBooks Payment linked to two jobs). Duplicate protection is the per-job lock + the
-- PSPAY attempt tag + QuickBooks' requestid de-duplication (apps/quickbooks/retail-payment-service.ts).
