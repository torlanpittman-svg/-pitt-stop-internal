-- 0075_quote_requests.sql
-- Durable record of each public /quote submission (2026-11-05). Additive, non-destructive, idempotent.
-- Independent of 0074 (gift cards) -- 0074 is HELD out of this release and nothing here references it.
--
-- Why: POST /api/quote previously had no retry protection. A network retry or double-tap created a
-- second marketing_leads row and a second email to the shop inbox, and the customer's photos existed
-- only as email attachments -- a failed send destroyed them.
--
-- Model: one row per request key, created in the SAME single statement (data-modifying CTE) as its
-- marketing_leads row and lead_created audit event -- all-or-nothing on the transactionless neon-http
-- driver, which is why lead_id is NOT NULL: a claim without a lead cannot exist, so no recovery path
-- ever needs to guess whether a lead was already created. The UNIQUE request_key is the claim itself --
-- exactly one invocation wins the INSERT even across concurrent Postgres connections.
-- payload_hash detects a reused key with different content, so a replay can never return another
-- payload's result.
--
-- email_attempts is a FENCE, not a counter-of-record: every provider send is authorized by winning a
-- conditional UPDATE that increments it (0 to 1 for the first send, or from a recorded definite
-- non-delivery for a retry). A delayed or crashed sender can therefore never produce a second send:
-- while a send is unresolved the status is 'processing'/'uncertain', and neither state can be fenced.
-- Statuses follow the appointment-outbox delivery-certainty rule: 'sent' and 'uncertain' are terminal
-- (an accepted email must never go out twice), 'failed' / 'not_configured' / 'blocked' may be retried.
-- photos holds the customer's uploaded photos so an email failure never loses them.
-- This is an operational outbox like appointment_notifications: status fields ARE updated.
-- Note: this file is applied by a script that splits on semicolons, so no semicolons appear in comments.

CREATE TABLE IF NOT EXISTS quote_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key     varchar(64) NOT NULL,
  payload_hash    varchar(64) NOT NULL,
  lead_id         uuid NOT NULL REFERENCES marketing_leads(id),
  email_status    varchar(16) NOT NULL DEFAULT 'processing',
  email_error     text,
  email_attempts  integer     NOT NULL DEFAULT 0,
  photos          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_requests_key_uniq UNIQUE (request_key),
  CONSTRAINT quote_requests_email_status_chk
    CHECK (email_status IN ('processing', 'sent', 'failed', 'not_configured', 'uncertain', 'blocked'))
);

CREATE INDEX IF NOT EXISTS quote_requests_lead_idx ON quote_requests (lead_id);
CREATE INDEX IF NOT EXISTS quote_requests_created_idx ON quote_requests (created_at);
