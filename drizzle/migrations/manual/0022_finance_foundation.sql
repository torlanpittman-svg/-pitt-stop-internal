-- CFO Financial OS — Phase 1 foundation. Additive-only (all NEW tables); nothing existing is
-- touched. Read-only toward QuickBooks; no money movement. Rollback = DROP these tables.

CREATE TABLE IF NOT EXISTS fin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  kind varchar(24) NOT NULL,
  classification varchar(16) NOT NULL,
  is_cash boolean NOT NULL DEFAULT false,
  is_liability boolean NOT NULL DEFAULT false,
  clearing_suspect boolean NOT NULL DEFAULT false,
  external_source varchar(20) NOT NULL DEFAULT 'qbo',
  external_id varchar(64),
  account_type varchar(60),
  account_sub_type varchar(60),
  institution varchar(120),
  currency varchar(8) NOT NULL DEFAULT 'USD',
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_accounts_source_ext_uniq ON fin_accounts (external_source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_accounts_kind_idx ON fin_accounts (kind);

CREATE TABLE IF NOT EXISTS fin_balance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES fin_accounts(id) ON DELETE CASCADE,
  balance_cents integer NOT NULL,
  available_cents integer,
  as_of timestamptz NOT NULL,
  source varchar(20) NOT NULL,
  confidence varchar(20) NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb
);
CREATE INDEX IF NOT EXISTS fin_bal_account_idx ON fin_balance_snapshots (account_id);
CREATE INDEX IF NOT EXISTS fin_bal_asof_idx ON fin_balance_snapshots (as_of);

CREATE TABLE IF NOT EXISTS fin_debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  lender varchar(120),
  kind varchar(24) NOT NULL DEFAULT 'term_loan',
  external_source varchar(20) NOT NULL DEFAULT 'qbo',
  external_id varchar(64),
  principal_cents integer,
  original_principal_cents integer,
  apr_bps integer,
  payment_cents integer,
  payment_frequency varchar(16),
  next_due date,
  maturity date,
  available_credit_cents integer,
  collateral text,
  source varchar(20) NOT NULL DEFAULT 'qbo',
  as_of timestamptz NOT NULL DEFAULT now(),
  confidence varchar(20) NOT NULL DEFAULT 'book',
  verified boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_debts_source_ext_uniq ON fin_debts (external_source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fin_payroll (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  next_pay_date date NOT NULL,
  expected_cash_cents integer NOT NULL,
  frequency varchar(16) NOT NULL DEFAULT 'weekly',
  source varchar(20) NOT NULL DEFAULT 'manual',
  confidence varchar(20) NOT NULL DEFAULT 'manual',
  entered_by varchar(200),
  as_of timestamptz NOT NULL DEFAULT now(),
  notes text
);

CREATE TABLE IF NOT EXISTS fin_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor varchar(200) NOT NULL,
  category varchar(60),
  amount_cents integer,
  amount_min_cents integer,
  amount_max_cents integer,
  frequency varchar(16),
  next_due date,
  autopay boolean,
  payment_account_id uuid REFERENCES fin_accounts(id),
  essential boolean,
  source varchar(20) NOT NULL DEFAULT 'manual',
  confidence varchar(20) NOT NULL DEFAULT 'manual',
  status varchar(16) NOT NULL DEFAULT 'confirmed',
  entered_by varchar(200),
  as_of timestamptz NOT NULL DEFAULT now(),
  notes text
);

CREATE TABLE IF NOT EXISTS fin_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(40) NOT NULL,
  blob_url text NOT NULL,
  filename varchar(300),
  account_id uuid REFERENCES fin_accounts(id),
  debt_id uuid REFERENCES fin_debts(id),
  period_start date,
  period_end date,
  as_of date,
  source varchar(20) NOT NULL DEFAULT 'manual',
  uploaded_by varchar(200),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source varchar(20) NOT NULL DEFAULT 'qbo',
  status varchar(16) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary jsonb,
  error text,
  actor varchar(200)
);

CREATE TABLE IF NOT EXISTS fin_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor varchar(200),
  action varchar(60) NOT NULL,
  entity varchar(40),
  entity_id varchar(64),
  before jsonb,
  after jsonb,
  source varchar(20),
  created_at timestamptz NOT NULL DEFAULT now()
);
