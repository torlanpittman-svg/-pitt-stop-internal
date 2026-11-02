-- 0068 — Staff booking alerts + Web Push device subscriptions.
--
-- Additive only: three new tables, no change to any existing table, column, index or row.
-- Nothing here is on the critical path of saving an appointment except ONE insert into
-- staff_alerts, which is deduped and can never block or undo the booking.
--
-- Tables
--   staff_push_subscriptions  one row per DEVICE that enrolled for push, tied to the staff identity
--                             that enrolled it. Disabled (never deleted) on sign-out, revoked access
--                             or when the push service reports the subscription is gone.
--   staff_alerts              the durable alert itself ("a new online booking arrived"). Written in
--                             the same statement as the booking, so an alert can never be lost.
--   staff_alert_deliveries    one row per (alert, device) attempt — the retry outbox. The unique
--                             pair is what stops a retry, a double-tap or two concurrent workers
--                             from notifying the same phone twice.

CREATE TABLE IF NOT EXISTS staff_push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The push service URL the DEVICE gave us (Apple/Google/Mozilla). Hashed copy is the unique key so
  -- the index stays small and the raw endpoint never has to appear in a log line.
  endpoint        text NOT NULL,
  endpoint_hash   varchar(64) NOT NULL,
  p256dh          varchar(120) NOT NULL,
  auth            varchar(60) NOT NULL,
  -- WHO enrolled this device (apps/auth/employee-session identity key + role at enrolment). Role is
  -- re-checked against the live identity registry at send time; this copy is for display/audit only.
  employee_key    varchar(40) NOT NULL,
  employee_name   varchar(120) NOT NULL,
  employee_role   varchar(16) NOT NULL,
  device_label    varchar(120),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  -- Soft disable only (append-only spirit: we keep the audit trail of which device was enrolled).
  disabled_at     timestamptz,
  disabled_reason varchar(40)   -- signed_out | expired | revoked | replaced | disabled_by_staff
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_push_subscriptions_endpoint_uniq ON staff_push_subscriptions (endpoint_hash);
-- "every device we may still notify" — the only read on the send path.
CREATE INDEX IF NOT EXISTS staff_push_subscriptions_active_idx ON staff_push_subscriptions (created_at) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS staff_push_subscriptions_employee_idx ON staff_push_subscriptions (employee_key);

CREATE TABLE IF NOT EXISTS staff_alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           varchar(32) NOT NULL,           -- new_booking (today: the only kind)
  appointment_id uuid REFERENCES appointments(id),
  -- One alert per real-world event. A replayed booking submission reuses the same key and is ignored.
  dedupe_key     varchar(160) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Set once, when the alert is expanded into per-device deliveries. Claiming it prevents a second
  -- worker fanning out again, and stops a device enrolled later from receiving an old alert.
  fanned_out_at  timestamptz,
  resolved_at    timestamptz,
  resolution     varchar(40)                     -- delivered | no_devices | not_configured | expired_unsent | all_failed
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_alerts_dedupe_uniq ON staff_alerts (dedupe_key);
CREATE INDEX IF NOT EXISTS staff_alerts_pending_fanout_idx ON staff_alerts (created_at) WHERE fanned_out_at IS NULL;
CREATE INDEX IF NOT EXISTS staff_alerts_appointment_idx ON staff_alerts (appointment_id);
-- The "are all this alert's deliveries finished?" sweep runs on every booking; keep it off a full scan.
CREATE INDEX IF NOT EXISTS staff_alerts_unresolved_idx ON staff_alerts (created_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS staff_alert_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id        uuid NOT NULL REFERENCES staff_alerts(id),
  subscription_id uuid NOT NULL REFERENCES staff_push_subscriptions(id),
  -- pending | sending | sent | failed | expired | skipped
  status          varchar(16) NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  send_after      timestamptz NOT NULL DEFAULT now(),
  -- When a worker took this row (pending → sending). A claim left behind by a worker that died is
  -- closed as "interrupted, outcome unknown" rather than retried, so no phone is alerted twice.
  claimed_at      timestamptz,
  http_status     integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

-- THE duplicate-alert guard: one delivery per alert per device, whatever happens upstream.
CREATE UNIQUE INDEX IF NOT EXISTS staff_alert_deliveries_pair_uniq ON staff_alert_deliveries (alert_id, subscription_id);
CREATE INDEX IF NOT EXISTS staff_alert_deliveries_due_idx ON staff_alert_deliveries (send_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS staff_alert_deliveries_subscription_idx ON staff_alert_deliveries (subscription_id);
