-- CFO Phase 2 (first slice) — read-only Plaid Link connection. Additive-only; no existing table
-- altered. Access token stored ENCRYPTED. No money-movement capability. Rollback = DROP these two.

CREATE TABLE IF NOT EXISTS fin_plaid_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id varchar(100) NOT NULL UNIQUE,
  institution_id varchar(64),
  institution_name varchar(200),
  environment varchar(20) NOT NULL,
  access_token_enc text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  last_error text,
  connected_by varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_plaid_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES fin_plaid_items(id) ON DELETE CASCADE,
  plaid_account_id varchar(100) NOT NULL UNIQUE,
  name varchar(200),
  official_name varchar(200),
  mask varchar(20),
  type varchar(40),
  subtype varchar(40),
  current_balance_cents integer,
  available_balance_cents integer,
  currency varchar(8),
  balance_as_of timestamptz,
  mapped_account_id uuid REFERENCES fin_accounts(id),
  mapping_verified boolean NOT NULL DEFAULT false,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_plaid_accounts_item_idx ON fin_plaid_accounts (item_id);
