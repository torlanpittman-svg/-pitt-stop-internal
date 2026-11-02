-- 0068 — Staff booking alerts + Web Push device subscriptions.
--
-- Additive only: three new tables, no change to any existing table, column, index or row.
-- NOTHING here is on the critical path of saving an appointment. The booking statement
-- (apps/appointments/db.ts) does not reference these tables at all: the alert is recorded AFTER the
-- booking response has been sent, from the route's post-response `after()` callback, so a slow or
-- broken alert write cannot delay, fail or undo a customer's booking.
--
-- Tables
--   staff_push_subscriptions  one row per DEVICE that enrolled for push, tied to the staff identity
--                             that enrolled it. Disabled (never deleted) on sign-out, revoked access
--                             or when the push service reports the subscription is gone.
--   staff_alerts              the durable alert itself ("a new online booking arrived"). Recorded
--                             post-response and deduped per appointment; if that write is lost
--                             entirely, the next dispatch recreates it from the appointment row.
--   staff_alert_deliveries    one row per (alert, device) attempt — the retry outbox. The unique
--                             pair is what stops a retry, a double-tap or two concurrent workers
--                             from creating a second delivery for the same phone.

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
  -- Audit: when the row first appeared. Never rewritten, including by a re-enrolment.
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- When this device's CURRENT enrolment began, and therefore the cut-off for which bookings it may
  -- be told about: fan-out only creates a delivery where enrolled_at <= the APPOINTMENT's created_at.
  -- A routine refresh by the same person preserves it; re-enrolling a disabled device, or a
  -- different person enrolling the same shared phone, moves it forward so the new enrolment is not
  -- alerted about bookings that arrived before it.
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  -- Soft disable only (append-only spirit: we keep the audit trail of which device was enrolled).
  disabled_at     timestamptz,
  disabled_reason varchar(40)   -- signed_out | expired | revoked | replaced | disabled_by_staff
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_push_subscriptions_endpoint_uniq ON staff_push_subscriptions (endpoint_hash);
-- "every device we may still notify, and from when" — the only read on the send path.
CREATE INDEX IF NOT EXISTS staff_push_subscriptions_active_idx ON staff_push_subscriptions (enrolled_at) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS staff_push_subscriptions_employee_idx ON staff_push_subscriptions (employee_key);

CREATE TABLE IF NOT EXISTS staff_alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           varchar(32) NOT NULL,           -- new_booking (today: the only kind)
  appointment_id uuid REFERENCES appointments(id),
  -- One alert per real-world event. A replayed booking submission reuses the same key and is ignored.
  dedupe_key     varchar(160) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Set once, when the alert is expanded into per-device deliveries. Claiming it is what prevents a
  -- second worker fanning the same alert out again. (What keeps an alert off a phone that enrolled
  -- later is a separate rule: staff_push_subscriptions.enrolled_at vs the appointment's created_at.)
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
  -- When a worker took this row (pending → sending). A claim still 'sending' long after it was
  -- taken belongs to a worker that died; it is queued AGAIN (within the attempts limit) rather than
  -- being abandoned, because losing the alert is worse than a possible second arrival — and both
  -- carry the alert id as their notification tag, which replaces an undelivered earlier copy.
  claimed_at      timestamptz,
  http_status     integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

-- THE duplicate-delivery guard: one delivery row per alert per device, whatever happens upstream.
-- It bounds what WE send; it cannot dictate what a phone's OS chooses to display.
CREATE UNIQUE INDEX IF NOT EXISTS staff_alert_deliveries_pair_uniq ON staff_alert_deliveries (alert_id, subscription_id);
CREATE INDEX IF NOT EXISTS staff_alert_deliveries_due_idx ON staff_alert_deliveries (send_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS staff_alert_deliveries_subscription_idx ON staff_alert_deliveries (subscription_id);
