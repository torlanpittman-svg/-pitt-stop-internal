-- 0082 — Cancelled-appointment recovery ("Lead Recovery").
-- ADDITIVE ONLY: two new tables. No existing table, column, constraint or row is changed, and nothing is
-- backfilled — historical cancellations are enrolled only by an explicit manager action in the app.
-- Idempotent (IF NOT EXISTS throughout): safe to re-run.
--
-- The recovery EMAILS reuse the existing outbox (appointment_notifications, kinds recovery_1 / recovery_2 /
-- recovery_3 — `kind` has no CHECK constraint and its varchar(16) fits them), so there is no second queue.
--
-- appointment_recoveries: ONE row per cancelled appointment (UNIQUE appointment_id) — this is what makes a
-- second recovery sequence for the same cancellation impossible.
-- appointment_recovery_events: append-only history (never updated or deleted).

BEGIN;

CREATE TABLE IF NOT EXISTS appointment_recoveries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id          uuid NOT NULL REFERENCES appointments(id),
  token_hash              varchar(64) NOT NULL,
  origin                  varchar(12) NOT NULL,                    -- who cancelled: customer | shop | unknown
  status                  varchar(12) NOT NULL DEFAULT 'review',   -- review | active | paused | stopped | rebooked | finished
  reason                  text,                                    -- why it needs review / why it stopped
  cancelled_at            timestamptz NOT NULL,
  sequence_started_at     timestamptz,
  started_by              varchar(200),
  last_contact_at         timestamptz,
  staff_outcome           varchar(16),                             -- contacted | not_interested | recovered
  staff_outcome_by        varchar(200),
  staff_outcome_at        timestamptz,
  rebooked_appointment_id uuid REFERENCES appointments(id),
  rebook_match            varchar(12),                             -- link | staff | contact
  rebook_review           varchar(12),                             -- contact matches only: pending | confirmed | rejected
  rebook_same_vehicle     boolean,
  rebooked_at             timestamptz,
  enrolled_by             varchar(200) NOT NULL DEFAULT 'system',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_recoveries_origin_chk CHECK (origin IN ('customer', 'shop', 'unknown')),
  CONSTRAINT appointment_recoveries_status_chk CHECK (status IN ('review', 'active', 'paused', 'stopped', 'rebooked', 'finished')),
  CONSTRAINT appointment_recoveries_outcome_chk CHECK (staff_outcome IS NULL OR staff_outcome IN ('contacted', 'not_interested', 'recovered')),
  CONSTRAINT appointment_recoveries_match_chk CHECK (rebook_match IS NULL OR rebook_match IN ('link', 'staff', 'contact')),
  CONSTRAINT appointment_recoveries_review_chk CHECK (rebook_review IS NULL OR rebook_review IN ('pending', 'confirmed', 'rejected'))
);

-- One recovery per cancellation — the duplicate-sequence guard.
CREATE UNIQUE INDEX IF NOT EXISTS appointment_recoveries_appointment_uniq ON appointment_recoveries (appointment_id);
CREATE UNIQUE INDEX IF NOT EXISTS appointment_recoveries_token_uniq ON appointment_recoveries (token_hash);
-- A new booking can be credited to at most one cancellation — recovered revenue is never counted twice.
CREATE UNIQUE INDEX IF NOT EXISTS appointment_recoveries_rebooked_uniq ON appointment_recoveries (rebooked_appointment_id) WHERE rebooked_appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointment_recoveries_status_idx ON appointment_recoveries (status, cancelled_at);

CREATE TABLE IF NOT EXISTS appointment_recovery_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_id uuid NOT NULL REFERENCES appointment_recoveries(id),
  event_type  varchar(32) NOT NULL,
  actor       varchar(200),
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointment_recovery_events_recovery_idx ON appointment_recovery_events (recovery_id, created_at);

-- Finding a customer's later booking by email (appointments_email_idx is on the raw column; matching is case-insensitive).
CREATE INDEX IF NOT EXISTS appointments_email_lower_idx ON appointments (lower(email));

COMMIT;

-- Grants: none needed. The app role (pitt_stop_app) receives DML on new tables through the owner's
-- ALTER DEFAULT PRIVILEGES (docs/DB_CREDENTIAL_ROTATION_COMPLETED_2026-11-03.md). Verify after applying:
--   SELECT has_table_privilege('pitt_stop_app', 'appointment_recoveries', 'INSERT');
