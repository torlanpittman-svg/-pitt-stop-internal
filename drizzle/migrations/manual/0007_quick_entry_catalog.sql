-- Quick Entry service catalog (V1). Additive; safe to re-run (IF NOT EXISTS).
-- No manager-approval gates in V1; every price editable + audited. Dealer prices
-- come from the Dealer Check-In rules engine. AutoLeap mapping pending an API.

CREATE TABLE IF NOT EXISTS service_catalog (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                varchar(80)  NOT NULL UNIQUE,
  name                varchar(120) NOT NULL,
  kind                varchar(20)  NOT NULL,                 -- package | addon | placeholder
  quick_entry         boolean      NOT NULL DEFAULT false,
  has_size            boolean      NOT NULL DEFAULT false,
  has_condition       boolean      NOT NULL DEFAULT false,
  default_price_cents integer,                                -- null for tiered / price-TBD
  price_editable      boolean      NOT NULL DEFAULT true,
  active              boolean      NOT NULL DEFAULT true,
  sort_order          integer      NOT NULL DEFAULT 0,
  source              varchar(40),
  requires_notes      boolean      NOT NULL DEFAULT false,
  requires_photo      boolean      NOT NULL DEFAULT false,
  qb_item_ref         varchar(40),
  qb_item_status      varchar(30)  NOT NULL DEFAULT 'existing', -- existing | new_create_at_golive | mapping_review
  qb_sync_enabled     boolean      NOT NULL DEFAULT true,
  autoleap_map_status varchar(40)  NOT NULL DEFAULT 'unmapped_pending_api',
  review_flag         boolean      NOT NULL DEFAULT false,
  notes               text,
  archived_at         timestamptz,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_catalog_kind_idx   ON service_catalog (kind);
CREATE INDEX IF NOT EXISTS service_catalog_quick_idx  ON service_catalog (quick_entry);
CREATE INDEX IF NOT EXISTS service_catalog_active_idx ON service_catalog (active);

CREATE TABLE IF NOT EXISTS service_price_tiers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id        uuid NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
  size              varchar(40) NOT NULL DEFAULT '',   -- '' = none
  condition         varchar(20) NOT NULL DEFAULT '',   -- '' = none
  start_price_cents integer NOT NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  CONSTRAINT service_price_tiers_uniq UNIQUE (catalog_id, size, condition)
);
CREATE INDEX IF NOT EXISTS service_price_tiers_catalog_idx ON service_price_tiers (catalog_id);

CREATE TABLE IF NOT EXISTS service_aliases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id      uuid NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
  alias           text NOT NULL,
  source          varchar(40) NOT NULL DEFAULT 'quickbooks',
  approved_for_ai boolean NOT NULL DEFAULT false,
  approved_by     varchar(120),
  approved_at     timestamptz,
  CONSTRAINT service_aliases_uniq UNIQUE (catalog_id, alias)
);
CREATE INDEX IF NOT EXISTS service_aliases_catalog_idx ON service_aliases (catalog_id);
CREATE INDEX IF NOT EXISTS service_aliases_ai_idx      ON service_aliases (approved_for_ai);

CREATE TABLE IF NOT EXISTS technician_instructions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        varchar(80)  NOT NULL UNIQUE,
  label       varchar(160) NOT NULL,
  group_name  varchar(40)  NOT NULL,
  billable    boolean      NOT NULL DEFAULT false,
  sort_order  integer      NOT NULL DEFAULT 0,
  active      boolean      NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS technician_instructions_group_idx ON technician_instructions (group_name);
