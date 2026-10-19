-- 0058_appointments.sql
-- Drop-off appointments: the replacement for the AutoLeap booking link (website + Google "Book online").
-- An appointment is a RESERVED DROP-OFF TIME, not a Job. The vehicle enters the existing Work Board only
-- when staff check it in (apps/appointments/checkin.ts → the existing Quick Entry job creator), so a
-- future booking never appears as an arrived vehicle.
--
--   appointments              one row per booking (public, phone, walk-in, marketing, AutoLeap import)
--   appointment_events        APPEND-ONLY history (booked / rescheduled / cancelled / checked in / ...)
--   appointment_blocks        manager closures (whole day or one time) and deliberate holiday re-opens
--   appointment_notifications transactional message outbox (confirmation / reminder / change notices)
--
-- Additive and idempotent: safe to re-run. No existing table is altered. Plain statements only (no DO
-- blocks) so scripts/apply-qb-migration.mjs, which splits on ';', applies it as-is.

CREATE TABLE IF NOT EXISTS appointments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference            varchar(16)  NOT NULL,
  token_hash           varchar(64)  NOT NULL,
  idempotency_key      varchar(80)  NOT NULL,
  status               varchar(16)  NOT NULL DEFAULT 'confirmed',
  local_date           date         NOT NULL,
  local_time           varchar(5)   NOT NULL,
  starts_at            timestamptz  NOT NULL,
  service_keys         jsonb        NOT NULL DEFAULT '[]',
  service_labels       text         NOT NULL DEFAULT '',
  units_detail         integer      NOT NULL DEFAULT 0,
  units_mechanic       integer      NOT NULL DEFAULT 0,
  first_name           varchar(120) NOT NULL,
  last_name            varchar(120) NOT NULL DEFAULT '',
  phone                varchar(40)  NOT NULL DEFAULT '',
  normalized_phone     varchar(20),
  email                varchar(240),
  vehicle_year         varchar(4),
  vehicle_make         varchar(100),
  vehicle_model        varchar(100),
  vehicle_color        varchar(60),
  vehicle_plate        varchar(20),
  vehicle_vin          varchar(17),
  customer_notes       text,
  internal_notes       text,
  source               varchar(24)  NOT NULL DEFAULT 'website_booking',
  attribution          jsonb        NOT NULL DEFAULT '{}',
  external_ref         varchar(120),
  customer_id          uuid,
  vehicle_id           uuid,
  service_order_id     uuid,
  marketing_lead_id    uuid,
  sms_marketing_opt_in boolean      NOT NULL DEFAULT false,
  capacity_override    boolean      NOT NULL DEFAULT false,
  ip_hash              varchar(64),
  created_by           varchar(200),
  acknowledged_at      timestamptz,
  acknowledged_by      varchar(200),
  checkin_started_at   timestamptz,
  arrived_at           timestamptz,
  cancelled_at         timestamptz,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT appointments_status_chk CHECK (status IN ('confirmed', 'arrived', 'cancelled', 'no_show')),
  CONSTRAINT appointments_time_chk CHECK (local_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  CONSTRAINT appointments_units_chk CHECK (units_detail >= 0 AND units_mechanic >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS appointments_reference_uniq ON appointments (reference);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_token_uniq ON appointments (token_hash);
-- A retried / double-tapped submission carries the same key → the same appointment, never a second one.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_idempotency_uniq ON appointments (idempotency_key);
-- Re-running an AutoLeap import never duplicates an appointment.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_external_ref_uniq ON appointments (external_ref) WHERE external_ref IS NOT NULL;
-- One appointment ↔ at most one Job (double check-in can never link two Jobs).
CREATE UNIQUE INDEX IF NOT EXISTS appointments_service_order_uniq ON appointments (service_order_id) WHERE service_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointments_day_idx ON appointments (local_date, local_time);
CREATE INDEX IF NOT EXISTS appointments_status_idx ON appointments (status, starts_at);
CREATE INDEX IF NOT EXISTS appointments_customer_idx ON appointments (customer_id);
CREATE INDEX IF NOT EXISTS appointments_phone_idx ON appointments (normalized_phone);
CREATE INDEX IF NOT EXISTS appointments_ip_idx ON appointments (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS appointment_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid         NOT NULL REFERENCES appointments(id),
  event_type     varchar(32)  NOT NULL,
  actor          varchar(200),
  meta           jsonb        NOT NULL DEFAULT '{}',
  created_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointment_events_appt_idx ON appointment_events (appointment_id, created_at);

CREATE TABLE IF NOT EXISTS appointment_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        varchar(8)   NOT NULL DEFAULT 'close',
  local_date  date         NOT NULL,
  local_time  varchar(5),
  reason      varchar(200),
  created_by  varchar(200),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  varchar(200),
  CONSTRAINT appointment_blocks_kind_chk CHECK (kind IN ('close', 'open'))
);
CREATE INDEX IF NOT EXISTS appointment_blocks_day_idx ON appointment_blocks (local_date) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS appointment_notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id      uuid         NOT NULL REFERENCES appointments(id),
  kind                varchar(16)  NOT NULL,
  channel             varchar(8)   NOT NULL DEFAULT 'email',
  to_address          varchar(240),
  dedupe_key          varchar(160) NOT NULL,
  status              varchar(16)  NOT NULL DEFAULT 'pending',
  send_after          timestamptz  NOT NULL DEFAULT now(),
  attempts            integer      NOT NULL DEFAULT 0,
  provider            varchar(40),
  provider_message_id varchar(200),
  error               text,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  CONSTRAINT appointment_notifications_status_chk CHECK (status IN ('pending', 'sending', 'sent', 'not_configured', 'failed', 'skipped'))
);
-- Retries never send the same notice twice.
CREATE UNIQUE INDEX IF NOT EXISTS appointment_notifications_dedupe_uniq ON appointment_notifications (dedupe_key);
CREATE INDEX IF NOT EXISTS appointment_notifications_due_idx ON appointment_notifications (status, send_after);
