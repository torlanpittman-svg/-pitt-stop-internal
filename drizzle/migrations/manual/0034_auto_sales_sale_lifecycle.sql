-- Auto-Sales B7 — Complete Sale Lifecycle + Monthly Report Snapshots.
-- ADDITIVE ONLY (new nullable columns + one new table). Idempotent. Touches no existing data;
-- alters no existing column. Safe to re-run.

-- Sale-detail: separately-stated customer-transaction components (never folded into revenue/profit)
-- + sale idempotency. Each component stays separate so the accountant determines its treatment.
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_tax_cents           integer;      -- sales tax collected (pass-through)
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_doc_fees_cents      integer;      -- title/registration/document fees collected
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_other_charges_cents integer;      -- other separately-stated customer charges
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_discount_cents      integer;      -- discounts/allowances
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS amount_received_cents    integer;      -- cash actually received to date
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_payment_method      varchar(20);  -- cash|check|financing|mixed|other
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_payment_ref         varchar(200); -- payment/reference note
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS buyer_contact            varchar(200); -- buyer contact (operational)
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS trade_in                 boolean;
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS trade_in_notes           text;
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS salesperson              varchar(200); -- manager/salesperson completing the sale
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_finalized_at        timestamptz;  -- set once on confirm (idempotency marker)
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS sale_version             integer NOT NULL DEFAULT 0; -- 0 = never sold, bumped by edits/reversals

-- Monthly report snapshots (accountant package). Live report is always recomputed from source; a
-- finalized snapshot preserves the values as generated. Prior finalizations are marked superseded,
-- never deleted. content_hash lets us detect post-finalization data drift.
CREATE TABLE IF NOT EXISTS auto_sales_report_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_month  varchar(7)  NOT NULL,          -- 'YYYY-MM' (business timezone)
  tz            varchar(50) NOT NULL,
  status        varchar(16) NOT NULL DEFAULT 'final',  -- final | superseded
  content_hash  varchar(64) NOT NULL,
  totals        jsonb NOT NULL,
  payload       jsonb NOT NULL,
  note          text,
  generated_by  varchar(200),
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asr_month_idx        ON auto_sales_report_snapshots (report_month);
CREATE INDEX IF NOT EXISTS asr_month_status_idx ON auto_sales_report_snapshots (report_month, status);
