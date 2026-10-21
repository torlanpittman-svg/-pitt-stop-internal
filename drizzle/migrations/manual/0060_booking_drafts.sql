-- 0060_booking_drafts.sql
-- Unfinished online bookings ("booking leads") + the vehicle type on appointments.
--
--   booking_drafts        one row per unfinished public booking. Created ONLY when the customer submits the
--                         completed contact step ("Continue to review") next to a disclosure that the details
--                         are saved even if they don't finish. A draft NEVER reserves appointment capacity:
--                         capacity is computed from `appointments` only.
--   booking_draft_events  APPEND-ONLY history (saved / updated / resumed / booked / follow-up / staff status).
--   appointments.vehicle_type  car | motorcycle | trailer (public dropdown flow); null for older/staff rows.
--   appointment_notifications.status  + 'uncertain' (may have been delivered; never resent).
--
-- The follow-up email permission is stored with its exact wording, wording version and timestamp. At most one
-- follow-up per draft and per email address. A worker claims a row (pending → sending, follow_up_claimed_at),
-- re-checks eligibility under a per-email advisory lock and stamps follow_up_cleared_at only then, and calls the
-- provider only after that. A claim left 'sending' by an interrupted worker is recovered later: never cleared →
-- provably not sent → back to pending; cleared → 'uncertain' (may have been sent) and NEVER retried automatically.
-- Additive and idempotent: safe to re-run. Plain statements only (no DO blocks).

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS vehicle_type varchar(16);

-- Transactional notices gain 'uncertain': the provider may have accepted the email (lost response, unreadable
-- 2xx, server error), so it is never resent automatically or re-queued. Drop + re-add keeps this re-runnable.
ALTER TABLE appointment_notifications DROP CONSTRAINT IF EXISTS appointment_notifications_status_chk;
ALTER TABLE appointment_notifications ADD CONSTRAINT appointment_notifications_status_chk
  CHECK (status IN ('pending', 'sending', 'sent', 'not_configured', 'failed', 'skipped', 'uncertain'));

CREATE TABLE IF NOT EXISTS booking_drafts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key                 varchar(80)  NOT NULL,
  token_hash                 varchar(64)  NOT NULL,
  status                     varchar(16)  NOT NULL DEFAULT 'open',
  first_name                 varchar(120),
  last_name                  varchar(120),
  phone                      varchar(40),
  normalized_phone           varchar(20),
  email                      varchar(240),
  service_keys               jsonb        NOT NULL DEFAULT '[]',
  service_labels             text         NOT NULL DEFAULT '',
  vehicle_type               varchar(16),
  vehicle_year               varchar(4),
  vehicle_make               varchar(100),
  vehicle_model              varchar(100),
  preferred_date             date,
  preferred_time             varchar(5),
  notes                      text,
  attribution                jsonb        NOT NULL DEFAULT '{}',
  save_notice_version        varchar(40)  NOT NULL,
  follow_up_consent          boolean      NOT NULL DEFAULT false,
  follow_up_consent_at       timestamptz,
  follow_up_consent_text     text,
  follow_up_consent_version  varchar(40),
  follow_up_status           varchar(16)  NOT NULL DEFAULT 'not_permitted',
  follow_up_attempts         integer      NOT NULL DEFAULT 0,
  follow_up_provider         varchar(40),
  follow_up_message_id       varchar(200),
  follow_up_error            text,
  follow_up_sent_at          timestamptz,
  follow_up_claimed_at       timestamptz,
  follow_up_cleared_at       timestamptz,
  staff_status               varchar(16)  NOT NULL DEFAULT 'new',
  staff_status_by            varchar(200),
  staff_status_at            timestamptz,
  appointment_id             uuid REFERENCES appointments(id),
  ip_hash                    varchar(64),
  created_at                 timestamptz  NOT NULL DEFAULT now(),
  last_activity_at           timestamptz  NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  purged_at                  timestamptz,
  CONSTRAINT booking_drafts_status_chk CHECK (status IN ('open', 'booked', 'purged')),
  CONSTRAINT booking_drafts_follow_up_chk CHECK (follow_up_status IN ('not_permitted', 'pending', 'sending', 'sent', 'not_configured', 'failed', 'suppressed', 'uncertain')),
  CONSTRAINT booking_drafts_staff_chk CHECK (staff_status IN ('new', 'contacted', 'closed'))
);
-- The browser session's key: re-submitting the contact step updates the same draft, never a second one.
CREATE UNIQUE INDEX IF NOT EXISTS booking_drafts_client_key_uniq ON booking_drafts (client_key);
CREATE UNIQUE INDEX IF NOT EXISTS booking_drafts_token_uniq ON booking_drafts (token_hash);
CREATE INDEX IF NOT EXISTS booking_drafts_open_idx ON booking_drafts (status, last_activity_at);
CREATE INDEX IF NOT EXISTS booking_drafts_follow_up_idx ON booking_drafts (follow_up_status, last_activity_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS booking_drafts_email_idx ON booking_drafts (email);
CREATE INDEX IF NOT EXISTS booking_drafts_phone_idx ON booking_drafts (normalized_phone);
CREATE INDEX IF NOT EXISTS booking_drafts_ip_idx ON booking_drafts (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS appointments_email_idx ON appointments (email);

CREATE TABLE IF NOT EXISTS booking_draft_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id    uuid         NOT NULL REFERENCES booking_drafts(id),
  event_type  varchar(32)  NOT NULL,
  actor       varchar(200),
  meta        jsonb        NOT NULL DEFAULT '{}',
  created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_draft_events_draft_idx ON booking_draft_events (draft_id, created_at);
