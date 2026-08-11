-- P-A: fee & settings foundation. Additive and re-runnable. Touches only the
-- manager-facing estimate layer (job_estimates / job_services / job_line_items) +
-- a new shop-wide settings table. No changes to Dealer Check-In, dealer QB, the
-- employee Work Board, Completion, Daily Production, or the customer directory.
-- NOTE: no semicolons inside comments (the manual-migration splitter breaks on them).

-- Shop-wide business settings. Key/value so new rules never need a new table.
CREATE TABLE IF NOT EXISTS app_settings (
  key         varchar(80) PRIMARY KEY,
  value       jsonb NOT NULL,                 -- typed value, e.g. 300 / true
  type        varchar(12) NOT NULL,           -- int | bool | string | json
  category    varchar(40),                    -- grouping for the admin UI
  label       varchar(160),
  description text,
  updated_by  varchar(200),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed defaults. ON CONFLICT DO NOTHING so re-runs never overwrite admin edits.
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('shop_supplies_enabled', 'true'::jsonb, 'bool', 'fees', 'Shop supplies fee enabled', 'Adds an explicit shop-supplies fee line to estimates')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('shop_supplies_bps', '300'::jsonb, 'int', 'fees', 'Shop supplies rate (bps)', '300 = 3.00 percent of the eligible pre-tax work subtotal')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('shop_supplies_cap_cents', '2000'::jsonb, 'int', 'fees', 'Shop supplies cap (cents)', 'Maximum shop-supplies fee, 2000 = 20.00 dollars')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('card_fee_enabled', 'false'::jsonb, 'bool', 'fees', 'Card processing fee enabled', 'DISABLED until legal/processor treatment is confirmed')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('card_fee_bps', '300'::jsonb, 'int', 'fees', 'Card processing rate (bps)', '300 = 3.00 percent, inert while disabled')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('default_tax_bps', '825'::jsonb, 'int', 'tax', 'Default tax rate (bps)', 'Seeds a new estimate tax rate, 825 = 8.25 percent')
  ON CONFLICT (key) DO NOTHING;

-- Generated-fee identity on line items (so fees recalculate in place, never duplicate).
ALTER TABLE job_line_items ADD COLUMN IF NOT EXISTS generated boolean NOT NULL DEFAULT false;
ALTER TABLE job_line_items ADD COLUMN IF NOT EXISTS fee_code varchar(40);

-- Duplicate protection at the DB level:
--   one generated line per fee_code per service, and one system fee service per estimate.
CREATE UNIQUE INDEX IF NOT EXISTS job_line_items_fee_uniq ON job_line_items (job_service_id, fee_code) WHERE fee_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS job_services_system_uniq ON job_services (job_estimate_id) WHERE source = 'system';
