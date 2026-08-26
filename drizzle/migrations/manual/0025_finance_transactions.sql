-- CFO Phase 2 — transaction ingestion. Additive, idempotent.
-- Normalized Plaid transactions for connected Pitt Stop accounts, with cash-integrity classification.
-- Read-only from the institution via Plaid; no QuickBooks writes; no money movement.

ALTER TABLE fin_plaid_items ADD COLUMN IF NOT EXISTS transactions_cursor text;
ALTER TABLE fin_plaid_items ADD COLUMN IF NOT EXISTS transactions_synced_at timestamptz;

CREATE TABLE IF NOT EXISTS fin_transactions (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plaid_item_id                uuid NOT NULL REFERENCES fin_plaid_items(id) ON DELETE CASCADE,
  plaid_account_ref            uuid REFERENCES fin_plaid_accounts(id) ON DELETE SET NULL,
  fin_account_id               uuid REFERENCES fin_accounts(id) ON DELETE SET NULL,
  plaid_transaction_id         varchar(100) NOT NULL UNIQUE,
  plaid_account_id             varchar(100) NOT NULL,
  pending_plaid_transaction_id varchar(100),
  amount_cents                 integer NOT NULL,          -- Plaid sign: + = money OUT of account, - = IN
  direction                    varchar(8) NOT NULL,       -- out | in
  iso_currency                 varchar(8),
  txn_date                     date NOT NULL,             -- posted (or authorized) date
  authorized_date              date,
  pending                      boolean NOT NULL DEFAULT false,
  name                         text,
  merchant_name                text,
  payment_channel              varchar(24),
  pfc_primary                  varchar(48),               -- Plaid personal_finance_category.primary
  pfc_detailed                 varchar(96),
  pfc_confidence               varchar(24),
  category_legacy              jsonb,
  txn_class                    varchar(24) NOT NULL DEFAULT 'unclassified',
  is_expense                   boolean NOT NULL DEFAULT false,  -- true = operating expense (spend analysis)
  is_cash_movement             boolean NOT NULL DEFAULT false,  -- transfer/card/debt/payroll: real cash, NOT opex
  class_confidence             varchar(12) NOT NULL DEFAULT 'rule',
  class_evidence               text,
  removed                      boolean NOT NULL DEFAULT false,  -- Plaid removed the transaction
  raw                          jsonb,
  as_of                        timestamptz NOT NULL DEFAULT now(),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_tx_finacct_idx ON fin_transactions(fin_account_id);
CREATE INDEX IF NOT EXISTS fin_tx_date_idx    ON fin_transactions(txn_date);
CREATE INDEX IF NOT EXISTS fin_tx_class_idx   ON fin_transactions(txn_class);
CREATE INDEX IF NOT EXISTS fin_tx_pending_idx ON fin_transactions(pending);
