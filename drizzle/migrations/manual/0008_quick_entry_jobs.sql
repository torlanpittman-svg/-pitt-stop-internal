-- Quick Entry captured jobs → Work Board. Additive; safe to re-run.
CREATE TABLE IF NOT EXISTS quick_entry_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id  uuid,
  vehicle_id        uuid,
  customer_name     varchar(200) NOT NULL,
  customer_phone    varchar(40),
  customer_email    varchar(200),
  vin               varchar(17),
  year              varchar(4),
  make              varchar(100),
  model             varchar(100),
  color             varchar(100),
  total_cents       integer NOT NULL DEFAULT 0,
  tech_instructions jsonb,
  created_by        varchar(200),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quick_entry_jobs_order_idx   ON quick_entry_jobs (service_order_id);
CREATE INDEX IF NOT EXISTS quick_entry_jobs_created_idx ON quick_entry_jobs (created_at);

CREATE TABLE IF NOT EXISTS quick_entry_job_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES quick_entry_jobs(id) ON DELETE CASCADE,
  catalog_id  uuid,
  kind        varchar(20) NOT NULL,
  name        varchar(160) NOT NULL,
  size        varchar(40),
  condition   varchar(20),
  price_cents integer NOT NULL DEFAULT 0,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS quick_entry_job_lines_job_idx ON quick_entry_job_lines (job_id);
