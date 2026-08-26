-- CFO Phase 2 — account lifecycle status. Additive, idempotent.
-- Lets an account remain connected at the Plaid connector layer while being excluded from every
-- CFO calculation/view (ignored), or marked as no-longer-existing (closed), without deleting any
-- historical financial data. No writes to QuickBooks anywhere.

ALTER TABLE fin_accounts        ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active';
ALTER TABLE fin_plaid_accounts  ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active';
ALTER TABLE fin_plaid_accounts  ADD COLUMN IF NOT EXISTS entity_note varchar(120);

CREATE INDEX IF NOT EXISTS fin_accounts_status_idx       ON fin_accounts(status);
CREATE INDEX IF NOT EXISTS fin_plaid_accounts_status_idx ON fin_plaid_accounts(status);
