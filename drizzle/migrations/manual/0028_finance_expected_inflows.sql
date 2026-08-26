-- CFO Phase 2 — expected-inflow pipeline. Additive, idempotent.
-- Money EXPECTED to arrive before it appears in Plaid, with an explicit confidence level so it is
-- NEVER added to strict Safe-to-Spend. Derived from real evidence or manually entered. References
-- existing records rather than duplicating them. No QuickBooks writes; no money movement.
-- Columns: source dealer_weekly|card_baseline|retail_job|manual; confidence high|probable|pipeline;
-- ref_type service_order|qb_invoice|dealer|pattern; status projected|confirmed|received|dismissed.

CREATE TABLE IF NOT EXISTS fin_expected_inflows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source            varchar(24) NOT NULL,
  label             varchar(200) NOT NULL,
  amount_cents      integer NOT NULL,
  expected_date     date NOT NULL,
  confidence        varchar(16) NOT NULL,
  reliability_bps   integer,
  ref_type          varchar(24),
  ref_id            varchar(100),
  evidence          jsonb,
  status            varchar(16) NOT NULL DEFAULT 'projected',
  derived           boolean NOT NULL DEFAULT true,
  dedupe_key        varchar(160),
  entered_by        varchar(200),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fin_expected_inflows_dedupe_uniq ON fin_expected_inflows(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_expected_inflows_date_idx ON fin_expected_inflows(expected_date);
CREATE INDEX IF NOT EXISTS fin_expected_inflows_conf_idx ON fin_expected_inflows(confidence);
