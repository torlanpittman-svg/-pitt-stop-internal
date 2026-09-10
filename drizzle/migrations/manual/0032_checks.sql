-- Check-writing feature — physical business checks recorded in QuickBooks (Purchase/Check) and
-- printed on the dedicated Brother HL-L2420DW. ADDITIVE ONLY. Idempotent (IF NOT EXISTS everywhere).
-- No existing table is touched. Money is cents (integer). See apps/checks/schema.ts.
-- NOTE: no inline column comments — the manual applier strips only full-line comments.

CREATE TABLE IF NOT EXISTS checks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_number           integer NOT NULL,
  bank_key               varchar(16) NOT NULL,
  bank_qbo_account_id    varchar(32) NOT NULL,
  payee_name             varchar(200) NOT NULL,
  payee_qbo_vendor_id    varchar(32),
  amount_cents           integer NOT NULL,
  memo                   text,
  category               varchar(24) NOT NULL,
  expense_qbo_account_id varchar(32) NOT NULL,
  entity                 varchar(16) NOT NULL DEFAULT 'operating',
  linked_job_id          uuid,
  linked_vehicle_id      uuid,
  check_date             date NOT NULL,
  qbo_txn_id             varchar(32),
  qbo_doc_number         varchar(32),
  qbo_sync_token         varchar(32),
  realm_id               varchar(32),
  qb_status              varchar(16) NOT NULL DEFAULT 'pending',
  qb_error               text,
  print_status           varchar(16) NOT NULL DEFAULT 'not_printed',
  printed_at             timestamptz,
  reprint_count          integer NOT NULL DEFAULT 0,
  idempotency_key        varchar(64) NOT NULL,
  actor_key              varchar(40),
  actor_name             varchar(120),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS checks_bank_number_uniq  ON checks (bank_key, check_number);
CREATE UNIQUE INDEX IF NOT EXISTS checks_idempotency_uniq  ON checks (idempotency_key);
CREATE INDEX        IF NOT EXISTS checks_qbo_txn_idx       ON checks (qbo_txn_id);
CREATE INDEX        IF NOT EXISTS checks_created_idx       ON checks (created_at);

CREATE TABLE IF NOT EXISTS check_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id   uuid NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  actor      varchar(120),
  action     varchar(40) NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS check_events_check_idx ON check_events (check_id);

CREATE TABLE IF NOT EXISTS print_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id       uuid REFERENCES checks(id) ON DELETE CASCADE,
  kind           varchar(16) NOT NULL DEFAULT 'check',
  status         varchar(16) NOT NULL DEFAULT 'queued',
  printer_target varchar(120),
  payload        jsonb NOT NULL,
  attempts       integer NOT NULL DEFAULT 0,
  claimed_by     varchar(120),
  claimed_at     timestamptz,
  printed_at     timestamptz,
  failed_at      timestamptz,
  error          text,
  created_by     varchar(120),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_jobs_status_idx ON print_jobs (status);
CREATE INDEX IF NOT EXISTS print_jobs_check_idx  ON print_jobs (check_id);

CREATE TABLE IF NOT EXISTS check_sequence (
  bank_key    varchar(16) PRIMARY KEY,
  next_number integer NOT NULL,
  updated_by  varchar(120),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
