-- Delivery ledger for recurring jobs. Existing campaign/post tables remain content sources.
CREATE TABLE IF NOT EXISTS marketing_automation_jobs (
  id uuid PRIMARY KEY,
  slot_key varchar(80) NOT NULL UNIQUE,
  channel varchar(16) NOT NULL CHECK (channel IN ('email','facebook')),
  scheduled_date date NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','preparing','ready','publishing','accepted','needs_review','skipped')),
  policy_version varchar(40) NOT NULL,
  external_ref varchar(160),
  error text,
  metrics jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_automation_due_idx ON marketing_automation_jobs (scheduled_date,status);
