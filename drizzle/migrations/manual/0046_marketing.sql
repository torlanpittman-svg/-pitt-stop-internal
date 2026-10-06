-- 0046_marketing.sql
-- Marketing Agent V1. Additive, non-destructive, idempotent (safe to re-run — IF NOT EXISTS).
-- Builds the marketing department ON TOP OF the canonical customer/vehicle/order/photo model:
--   • customers        (apps/directory)  — the ONE customer source of truth
--   • service_orders   (apps/workflow)   — jobs / completed revenue
--   • order_photos     (apps/order-photos) — before/after proof assets
-- No marketing table owns customer identity; every link is an FK into the existing tables.
-- Nothing here mutates, sends, or touches QuickBooks. All external sends are dry-run until a
-- provider is configured (see apps/marketing/providers/*). FKs are declared in SQL only (not in
-- the Drizzle table definitions) to avoid circular schema imports, mirroring 0043_customer_links.

-- ── Per-customer consent / eligibility (mutable state; changes are audited in marketing_events) ──
CREATE TABLE IF NOT EXISTS marketing_preferences (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL,
  sms_eligible       boolean NOT NULL DEFAULT true,
  email_eligible     boolean NOT NULL DEFAULT true,
  unsubscribed_at    timestamptz,
  unsubscribe_reason text,
  unsubscribe_scope  varchar(10) NOT NULL DEFAULT 'all',   -- all | sms | email
  unsubscribe_token  uuid NOT NULL DEFAULT gen_random_uuid(),
  marketing_source   varchar(40),                          -- acquisition source
  last_contacted_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_preferences_customer_fk') THEN
    ALTER TABLE marketing_preferences ADD CONSTRAINT marketing_preferences_customer_fk
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS marketing_preferences_customer_uniq ON marketing_preferences(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_preferences_token_uniq ON marketing_preferences(unsubscribe_token);

-- ── Campaigns (SMS / email revenue campaigns, ~biweekly) ──
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             varchar(160) NOT NULL,
  campaign_type    varchar(40)  NOT NULL DEFAULT 'reactivation',
  target_service   varchar(40),                              -- ceramic | paint_correction | interior | general | null
  segment_key      varchar(60),                              -- named segment id
  segment_criteria jsonb,                                    -- custom criteria snapshot
  channel          varchar(10)  NOT NULL DEFAULT 'both',     -- sms | email | both
  status           varchar(16)  NOT NULL DEFAULT 'draft',    -- draft|ready|scheduled|sending|sent|paused|completed|cancelled
  scheduled_at     timestamptz,
  offer            text,
  sms_copy         text,
  email_subject    text,
  email_body       text,
  created_by       varchar(200),
  approved_by      varchar(200),
  approved_at      timestamptz,
  sent_at          timestamptz,
  recipient_count  integer NOT NULL DEFAULT 0,
  sent_count       integer NOT NULL DEFAULT 0,
  excluded_count   integer NOT NULL DEFAULT 0,
  response_count   integer NOT NULL DEFAULT 0,
  dry_run          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_campaigns_status_idx    ON marketing_campaigns(status);
CREATE INDEX IF NOT EXISTS marketing_campaigns_scheduled_idx ON marketing_campaigns(scheduled_at);

-- ── Campaign recipients (one row per customer per channel; dedup = idempotent build/send) ──
CREATE TABLE IF NOT EXISTS marketing_campaign_recipients (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id             uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  customer_id             uuid,
  channel                 varchar(10) NOT NULL,              -- sms | email
  address_snapshot        varchar(240),                      -- phone/email captured at build time
  vehicle_label           varchar(160),
  status                  varchar(16) NOT NULL DEFAULT 'pending', -- pending|excluded|sent|failed|suppressed
  exclusion_reason        varchar(60),
  rendered_body           text,
  sent_at                 timestamptz,
  responded_at            timestamptz,
  booked_order_id         uuid,
  completed_revenue_cents integer,
  created_at              timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_recipients_customer_fk') THEN
    ALTER TABLE marketing_campaign_recipients ADD CONSTRAINT marketing_recipients_customer_fk
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_recipients_order_fk') THEN
    ALTER TABLE marketing_campaign_recipients ADD CONSTRAINT marketing_recipients_order_fk
      FOREIGN KEY (booked_order_id) REFERENCES service_orders(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS marketing_recipients_dedup_uniq ON marketing_campaign_recipients(campaign_id, customer_id, channel);
CREATE INDEX IF NOT EXISTS marketing_recipients_campaign_idx ON marketing_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS marketing_recipients_status_idx   ON marketing_campaign_recipients(status);

-- ── Social content queue (3 Facebook posts/week: educate / proof / sell) ──
CREATE TABLE IF NOT EXISTS marketing_social_posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         varchar(20) NOT NULL DEFAULT 'facebook',
  pillar           varchar(12) NOT NULL,                     -- educate | proof | sell
  target_service   varchar(40),
  copy             text NOT NULL DEFAULT '',
  service_order_id uuid,
  before_photo_id  uuid,
  after_photo_id   uuid,
  scheduled_at     timestamptz,
  status           varchar(12) NOT NULL DEFAULT 'idea',      -- idea|draft|approved|scheduled|posted|failed|archived
  ai_generated     boolean NOT NULL DEFAULT false,
  approved_by      varchar(200),
  external_post_ref varchar(120),
  created_by       varchar(200),
  created_source   varchar(24) NOT NULL DEFAULT 'manual',    -- manual | job_candidate | ai
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_posts_order_fk') THEN
    ALTER TABLE marketing_social_posts ADD CONSTRAINT marketing_posts_order_fk
      FOREIGN KEY (service_order_id) REFERENCES service_orders(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_posts_before_fk') THEN
    ALTER TABLE marketing_social_posts ADD CONSTRAINT marketing_posts_before_fk
      FOREIGN KEY (before_photo_id) REFERENCES order_photos(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_posts_after_fk') THEN
    ALTER TABLE marketing_social_posts ADD CONSTRAINT marketing_posts_after_fk
      FOREIGN KEY (after_photo_id) REFERENCES order_photos(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS marketing_posts_status_idx    ON marketing_social_posts(status);
CREATE INDEX IF NOT EXISTS marketing_posts_scheduled_idx ON marketing_social_posts(scheduled_at);

-- ── Leads (marketing-sourced; links through to customer → order → completed revenue) ──
CREATE TABLE IF NOT EXISTS marketing_leads (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    varchar(200),
  phone                   varchar(40),
  email                   varchar(240),
  vehicle                 varchar(160),
  requested_service       varchar(40),
  source                  varchar(24) NOT NULL DEFAULT 'unknown',
  campaign_id             uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  status                  varchar(16) NOT NULL DEFAULT 'new', -- new|contacted|estimate_needed|estimate_sent|booked|won|lost|no_response
  estimated_value_cents   integer,
  customer_id             uuid,
  service_order_id        uuid,
  attributed_revenue_cents integer,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_leads_customer_fk') THEN
    ALTER TABLE marketing_leads ADD CONSTRAINT marketing_leads_customer_fk
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_leads_order_fk') THEN
    ALTER TABLE marketing_leads ADD CONSTRAINT marketing_leads_order_fk
      FOREIGN KEY (service_order_id) REFERENCES service_orders(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS marketing_leads_status_idx  ON marketing_leads(status);
CREATE INDEX IF NOT EXISTS marketing_leads_source_idx  ON marketing_leads(source);
CREATE INDEX IF NOT EXISTS marketing_leads_created_idx ON marketing_leads(created_at);

-- ── Attribution (append-only; marketing touch → customer/order → revenue) ──
CREATE TABLE IF NOT EXISTS marketing_attribution (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           varchar(24) NOT NULL,                     -- channel bucket
  medium           varchar(40),
  campaign         varchar(120),
  utm_source       varchar(120),
  utm_medium       varchar(120),
  utm_campaign     varchar(120),
  click_id         varchar(120),
  touch_type       varchar(8)  NOT NULL DEFAULT 'last',      -- first | last
  confidence       varchar(10) NOT NULL DEFAULT 'unknown',   -- direct | assisted | unknown
  customer_id      uuid,
  service_order_id uuid,
  lead_id          uuid REFERENCES marketing_leads(id) ON DELETE SET NULL,
  campaign_id      uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  revenue_cents    integer,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_attr_customer_fk') THEN
    ALTER TABLE marketing_attribution ADD CONSTRAINT marketing_attr_customer_fk
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'marketing_attr_order_fk') THEN
    ALTER TABLE marketing_attribution ADD CONSTRAINT marketing_attr_order_fk
      FOREIGN KEY (service_order_id) REFERENCES service_orders(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS marketing_attr_source_idx   ON marketing_attribution(source);
CREATE INDEX IF NOT EXISTS marketing_attr_order_idx    ON marketing_attribution(service_order_id);
CREATE INDEX IF NOT EXISTS marketing_attr_occurred_idx ON marketing_attribution(occurred_at);

-- ── Audit log (append-only; every externally visible or AI action) ──
CREATE TABLE IF NOT EXISTS marketing_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  varchar(40) NOT NULL,
  entity_type varchar(24),
  entity_id   uuid,
  actor       varchar(200),
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_events_type_idx    ON marketing_events(event_type);
CREATE INDEX IF NOT EXISTS marketing_events_entity_idx  ON marketing_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS marketing_events_created_idx ON marketing_events(created_at);

-- ── Google Ads metrics (daily, per service category; manual import or future API) ──
CREATE TABLE IF NOT EXISTS marketing_ad_metrics (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         varchar(16) NOT NULL DEFAULT 'manual',    -- manual | google_ads
  service_category varchar(40) NOT NULL,                     -- ceramic|paint_correction|interior|general|brand
  stat_date        date NOT NULL,
  spend_cents      integer NOT NULL DEFAULT 0,
  impressions      integer NOT NULL DEFAULT 0,
  clicks           integer NOT NULL DEFAULT 0,
  conversions      integer NOT NULL DEFAULT 0,
  revenue_cents    integer NOT NULL DEFAULT 0,               -- attributed completed revenue (known)
  created_by       varchar(200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_ad_metrics_uniq ON marketing_ad_metrics(provider, service_category, stat_date);
CREATE INDEX IF NOT EXISTS marketing_ad_metrics_date_idx ON marketing_ad_metrics(stat_date);

-- ── Search terms (negative-keyword analysis for Google Ads) ──
CREATE TABLE IF NOT EXISTS marketing_search_terms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term             varchar(200) NOT NULL,
  service_category varchar(40),
  spend_cents      integer NOT NULL DEFAULT 0,
  clicks           integer NOT NULL DEFAULT 0,
  conversions      integer NOT NULL DEFAULT 0,
  revenue_cents    integer NOT NULL DEFAULT 0,
  stat_period      varchar(20),                              -- e.g. 2026-W40
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_search_terms_period_idx ON marketing_search_terms(stat_period);

-- ── Facebook comment / message assistant queue ──
CREATE TABLE IF NOT EXISTS marketing_conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform          varchar(20) NOT NULL DEFAULT 'facebook',
  external_ref      varchar(160),
  author_name       varchar(200),
  message           text NOT NULL,
  topic             varchar(40),
  suggested_reply   text,
  state             varchar(16) NOT NULL DEFAULT 'new',      -- new|suggested|needs_review|escalated|answered|archived
  escalation_reason varchar(60),
  handled_by        varchar(200),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_conversations_state_idx ON marketing_conversations(state);
