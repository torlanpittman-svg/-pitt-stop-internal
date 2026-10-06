-- 0047_marketing_sms_consent.sql
-- Additive, non-destructive, idempotent. Establishes AUDITABLE SMS marketing consent.
--
-- INVARIANT: possessing a phone number is NOT promotional-SMS consent. A contact is eligible for
-- marketing SMS ONLY when sms_consent_status = 'granted' (proven opt-in). The default is 'unknown',
-- which is treated as NOT eligible — historical/imported numbers never silently qualify.
--
-- Operational phone numbers remain usable for operational workflows ELSEWHERE in Pitt Stop; this
-- only governs Marketing Agent promotional SMS.

-- Per-customer SMS consent STATE (the latest resolved status). The append-only event log below is
-- the audit trail of how it got here.
ALTER TABLE marketing_preferences
  ADD COLUMN IF NOT EXISTS sms_consent_status  varchar(10) NOT NULL DEFAULT 'unknown', -- unknown | granted | revoked
  ADD COLUMN IF NOT EXISTS sms_consent_source  varchar(40),
  ADD COLUMN IF NOT EXISTS sms_consent_at      timestamptz,
  ADD COLUMN IF NOT EXISTS sms_consent_version varchar(40);

-- Append-only consent audit trail: every grant/revoke/import/help, with source + wording version.
CREATE TABLE IF NOT EXISTS marketing_consent_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid,
  channel         varchar(10) NOT NULL,              -- sms | email
  event           varchar(16) NOT NULL,              -- opt_in | opt_out | import_verified | help
  source          varchar(40) NOT NULL,              -- website_form | in_store | customer_portal | imported | sms_keyword | manager | lead_form
  wording_version varchar(40),                        -- version of the disclosure the customer agreed to
  consent_text    text,                               -- exact disclosure text shown, when captured
  phone           varchar(40),                        -- the number that consented (audit snapshot)
  actor           varchar(200),                       -- who recorded it (customer self-serve = null/'self')
  ip              varchar(64),
  user_agent      text,
  meta            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_consent_customer_fk') THEN
    ALTER TABLE marketing_consent_events ADD CONSTRAINT marketing_consent_customer_fk
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS marketing_consent_customer_idx ON marketing_consent_events(customer_id);
CREATE INDEX IF NOT EXISTS marketing_consent_channel_idx  ON marketing_consent_events(channel, event);
CREATE INDEX IF NOT EXISTS marketing_consent_created_idx  ON marketing_consent_events(created_at);
