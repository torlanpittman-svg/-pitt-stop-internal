-- 0079 — Persisted cross-source matches + a read-only mirror of QuickBooks expense entries (2026-11-13).
--
-- ONE PURCHASE COUNTS ONCE. The same purchase can show up as a receipt, a bank/card transaction, a written
-- check, a QuickBooks entry and a sales-inventory ledger line. purchase_links records a PERSON'S decision
-- that two such records are the same purchase (or are not), so it is decided once instead of being
-- re-guessed every time a page loads. Receipt ↔ bank keeps living in fin_receipt_matches (0043).
--
--   kind                   a_type / a_id            b_type / b_id                      cardinality
--   receipt_qb             receipt (uuid)           qb_purchase (fin_qb_purchases key) 1 : 1
--   receipt_vehicle_event  receipt (uuid)           vehicle_event (uuid)               1 : 1
--   check_txn              check (uuid)             bank_txn (uuid)                    1 : 1
--   check_receipt          check (uuid)             receipt (uuid)                     1 : 1
--   txn_qb                 bank_txn (uuid)          qb_purchase                        1 : 1
--   bill_payment           obligation (uuid)        bank_txn (uuid)                    1 bill : many payments
--
--   status: confirmed | dismissed ("not the same") | cleared (a decision that was undone — kept for history).
-- Rows are never deleted or rewritten into a different decision: undoing sets status 'cleared', and a new
-- decision is a new row. Every decision is also appended to fin_events. Nothing here moves money, changes a
-- total by itself, or writes to QuickBooks.
CREATE TABLE IF NOT EXISTS purchase_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         varchar(24) NOT NULL,
  a_type       varchar(16) NOT NULL,
  a_id         varchar(80) NOT NULL,
  b_type       varchar(16) NOT NULL,
  b_id         varchar(80) NOT NULL,
  status       varchar(12) NOT NULL,
  amount_cents integer,
  evidence     jsonb,
  note         text,
  decided_by   varchar(200),
  decided_at   timestamptz NOT NULL DEFAULT now(),
  cleared_by   varchar(200),
  cleared_at   timestamptz,
  CONSTRAINT purchase_links_kind_chk CHECK (kind IN ('receipt_qb', 'receipt_vehicle_event', 'check_txn', 'check_receipt', 'txn_qb', 'bill_payment')),
  CONSTRAINT purchase_links_status_chk CHECK (status IN ('confirmed', 'dismissed', 'cleared'))
);
CREATE INDEX IF NOT EXISTS purchase_links_a_idx ON purchase_links (a_type, a_id);
CREATE INDEX IF NOT EXISTS purchase_links_b_idx ON purchase_links (b_type, b_id);
-- One confirmed partner on the "b" side for every kind (a bank payment pays one bill; a QuickBooks entry
-- backs one receipt) …
CREATE UNIQUE INDEX IF NOT EXISTS purchase_links_b_confirmed_uniq ON purchase_links (kind, b_id) WHERE status = 'confirmed';
-- … and one on the "a" side too, except a recurring bill, which is paid again every period.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_links_a_confirmed_uniq ON purchase_links (kind, a_id) WHERE status = 'confirmed' AND kind <> 'bill_payment';
-- One live decision (confirmed or dismissed) per exact pair.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_links_pair_live_uniq ON purchase_links (kind, a_id, b_id) WHERE status <> 'cleared';

-- READ-ONLY mirror of QuickBooks expense entries (Purchase = expense / check / card charge; Bill = vendor
-- bill). Filled by the existing daily QuickBooks sync from the production company only. This app never
-- writes these back: the mirror exists so receipts, checks and bank payments can be matched to what the
-- books already contain. qb_key = '<Purchase|Bill>:<QuickBooks Id>'.
CREATE TABLE IF NOT EXISTS fin_qb_purchases (
  qb_key        varchar(80) PRIMARY KEY,
  qb_type       varchar(16) NOT NULL,
  qb_id         varchar(40) NOT NULL,
  txn_date      date,
  total_cents   integer NOT NULL,
  payment_type  varchar(24),
  account_name  varchar(200),
  payee_name    varchar(200),
  doc_number    varchar(60),
  private_note  text,
  line_summary  text,
  expense_accounts text,
  qb_updated_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  missing_since timestamptz
);
CREATE INDEX IF NOT EXISTS fin_qb_purchases_date_idx ON fin_qb_purchases (txn_date);
CREATE INDEX IF NOT EXISTS fin_qb_purchases_total_idx ON fin_qb_purchases (total_cents);
