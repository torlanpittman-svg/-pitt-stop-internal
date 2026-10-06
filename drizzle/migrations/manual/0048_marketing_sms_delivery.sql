-- 0048_marketing_sms_delivery.sql
-- Additive, idempotent. Records the Twilio provider message id + delivery status on each recipient so
-- status callbacks can update the right row and failures are visible. No behavior change for email.

ALTER TABLE marketing_campaign_recipients
  ADD COLUMN IF NOT EXISTS provider_message_id varchar(64),
  ADD COLUMN IF NOT EXISTS delivery_status     varchar(20),   -- queued|sent|delivered|undelivered|failed
  ADD COLUMN IF NOT EXISTS error_code          varchar(20);

-- Status callbacks look the recipient up by the provider's message id.
CREATE INDEX IF NOT EXISTS marketing_recipients_provider_msg_idx
  ON marketing_campaign_recipients(provider_message_id);
