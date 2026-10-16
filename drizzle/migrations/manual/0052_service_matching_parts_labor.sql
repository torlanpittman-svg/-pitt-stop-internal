-- 0052_service_matching_parts_labor.sql
-- Additive, non-destructive, idempotent. Supports:
--   1. Service recognition: each estimate service keeps its catalog identity (job_services.catalog_id,
--      0051) SEPARATE from its editable title AND from a job-specific detail ("passenger seat").
--      match_method records how the identity was chosen (exact / alias / suggestion / custom ...).
--   2. Odor-treatment definitions: service_catalog.service_role marks the three odor options and the
--      installation-labor service; role_confirmed_* records whether a manager/owner confirmed it.
--   3. Special-order parts on the estimate + a persisted installation-labor review per part.
--   4. An append-only audit of catalog review decisions and manager-approved alternate names.
--
-- Catalog rows added below start in QuickBooks 'mapping_review' with sync DISABLED: invoices use the
-- generic Labor item with the canonical description until a manager confirms the QuickBooks item in
-- the catalog review screen. NO QuickBooks item is created, merged, or deactivated by this migration.

-- ── job_services ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS kind          varchar(12) NOT NULL DEFAULT 'service';  -- service | part
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS detail        varchar(160);                            -- job-specific detail, e.g. "passenger seat"
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS match_method  varchar(16);                             -- exact | alias | suggestion | shortcut | custom | legacy
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS matched_by    varchar(200);
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS matched_at    timestamptz;
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS overlap_ack_by varchar(200);                           -- kept alongside a package on purpose
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS overlap_ack_at timestamptz;
-- The employee's ORIGINAL wording, kept for traceability (never sent to QuickBooks).
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS entry_text varchar(300);
-- Canonical customer-facing description captured when the catalog identity was chosen, so a later
-- catalog description edit applies to FUTURE additions only and never rewrites this line.
-- NULL (legacy rows) = resolve the catalog's current description, exactly as before.
ALTER TABLE job_services ADD COLUMN IF NOT EXISTS catalog_description text;

-- ── service_catalog ───────────────────────────────────────────────────────────────────────────
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS service_role      varchar(24);   -- odor_duct | odor_ozone | odor_complete | installation
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS role_confirmed_by varchar(200);
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS role_confirmed_at timestamptz;
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS qb_candidate_ref  varchar(40);   -- suggested EXISTING QB item for manager review

-- ── job_parts: estimate link, supply, fitment, labor review ────────────────────────────────────
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS job_service_id   uuid;
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS supply           varchar(12) NOT NULL DEFAULT 'shop';         -- shop | customer
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS fitment          text;
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS labor_status     varchar(16) NOT NULL DEFAULT 'needs_review'; -- needs_review | labor_added | included | part_only | waived
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS labor_service_id uuid;
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS labor_note       text;
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS labor_decided_by varchar(200);
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS labor_decided_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'job_parts_job_service_id_job_services_id_fk') THEN
    ALTER TABLE job_parts ADD CONSTRAINT job_parts_job_service_id_job_services_id_fk
      FOREIGN KEY (job_service_id) REFERENCES job_services(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'job_parts_labor_service_id_job_services_id_fk') THEN
    ALTER TABLE job_parts ADD CONSTRAINT job_parts_labor_service_id_job_services_id_fk
      FOREIGN KEY (labor_service_id) REFERENCES job_services(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS job_parts_service_idx ON job_parts (job_service_id);
CREATE INDEX IF NOT EXISTS job_parts_labor_service_idx ON job_parts (labor_service_id);

-- ── Append-only catalog audit (review decisions, approved alternate names) ────────────────────
CREATE TABLE IF NOT EXISTS service_catalog_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id  uuid REFERENCES service_catalog(id) ON DELETE RESTRICT,
  event_type  varchar(40) NOT NULL,
  actor       varchar(200),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_catalog_events_catalog_idx ON service_catalog_events (catalog_id);

-- ── Catalog rows (Pitt Stop only; reuse EXISTING QuickBooks items after manager review) ────────
INSERT INTO service_catalog (slug, name, kind, quick_entry, default_price_cents, price_editable, active, sort_order, source,
  qb_item_ref, qb_item_status, qb_sync_enabled, qb_description, qb_candidate_ref, review_flag, service_role, role_confirmed_by, role_confirmed_at, notes)
VALUES
  ('complete_odor_treatment', 'Complete Odor Treatment', 'addon', false, NULL, true, true, 175, 'owner',
   NULL, 'mapping_review', false, 'Complete odor treatment, including air duct cleaning and ozone treatment.', '68', true,
   'odor_complete', 'owner definition (2026-10-16)', now(),
   'Package = Air Duct Cleaning + Ozone Treatment. Price must be confirmed by a manager. Candidate existing QB item: "Odor Treatment" (#68).'),
  ('installation_labor', 'Installation Labor', 'addon', false, NULL, true, true, 185, 'owner',
   NULL, 'mapping_review', false, NULL, '73', true,
   'installation', 'owner definition (2026-10-16)', now(),
   'Labor to install a part (special-order or customer-supplied). Candidate existing QB item: "Install" (#73).'),
  ('seat_shampoo', 'Seat Shampoo', 'addon', false, NULL, true, true, 195, 'owner',
   NULL, 'mapping_review', false, NULL, '23', true,
   NULL, NULL, NULL,
   'Seat cleaning/shampoo; the seat location is a job detail, not a separate service. Candidate existing QB item: "Clean seats" (#23).'),
  ('paint_refinish', 'Painting / Refinishing', 'addon', false, NULL, true, true, 197, 'owner',
   NULL, 'mapping_review', false, NULL, '57', true,
   NULL, NULL, NULL,
   'Painting/refinishing a panel or component (the component is a job detail). Candidate existing QB item: "Paint" (#57).')
ON CONFLICT (slug) DO NOTHING;

-- Odor roles for existing rows. Air Duct Cleaning matches the owner definition by name (confirmed).
-- "Odor / Ozone Treatment" is described as ozone + fabric steam cleaning (no duct cleaning), so it is
-- the Ozone option — but its name is ambiguous, so the role stays UNCONFIRMED for manager review.
UPDATE service_catalog SET service_role = 'odor_duct', role_confirmed_by = 'owner definition (2026-10-16)', role_confirmed_at = now()
  WHERE slug = 'air_duct_cleaning' AND service_role IS NULL;
UPDATE service_catalog SET qb_candidate_ref = '76'
  WHERE slug = 'air_duct_cleaning' AND qb_item_ref IS NULL AND qb_candidate_ref IS NULL;
UPDATE service_catalog SET service_role = 'odor_ozone'
  WHERE slug = 'odor_ozone' AND service_role IS NULL;
UPDATE service_catalog SET qb_candidate_ref = '88'
  WHERE slug = 'cabin_air_filter_replacement' AND qb_item_ref IS NULL AND qb_candidate_ref IS NULL;
UPDATE service_catalog SET qb_candidate_ref = '35'
  WHERE slug = 'paint_touch_up' AND qb_item_ref IS NULL AND qb_candidate_ref IS NULL;

INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
SELECT c.id, 'catalog_seeded', 'migration 0052', 'Added for service matching / odor definitions; awaiting manager QuickBooks review.'
FROM service_catalog c
WHERE c.slug IN ('complete_odor_treatment', 'installation_labor', 'seat_shampoo', 'paint_refinish')
  AND NOT EXISTS (SELECT 1 FROM service_catalog_events e WHERE e.catalog_id = c.id AND e.event_type = 'catalog_seeded');

-- ── Service shortcuts (manager-managed quick-select list) ─────────────────────────────────────
-- A shortcut REFERENCES a catalog item (stable identity); its label is display-only. Hiding sets
-- hidden_at (never deletes the catalog row or any QuickBooks item). Changes are audited in
-- service_catalog_events.
CREATE TABLE IF NOT EXISTS service_shortcuts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id  uuid NOT NULL REFERENCES service_catalog(id) ON DELETE RESTRICT,
  label       varchar(80) NOT NULL,
  group_name  varchar(40) NOT NULL DEFAULT 'Services',
  sort_order  integer NOT NULL DEFAULT 0,
  hidden_at   timestamptz,
  hidden_by   varchar(200),
  created_by  varchar(200),
  updated_by  varchar(200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_shortcuts_active_catalog_uniq ON service_shortcuts (catalog_id) WHERE hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS service_shortcuts_order_idx ON service_shortcuts (group_name, sort_order);

-- Initial list = the 5 existing Quick Entry shortcuts (same labels) + usage-based additions
-- (Pitt Stop retail jobs 2026-07-25..2026-10-16 + non-dealer QuickBooks invoices 180 days).
-- Seeded ONLY when the table is empty so a manager's later choices are never overwritten.
INSERT INTO service_shortcuts (catalog_id, label, group_name, sort_order, created_by)
SELECT c.id, v.label, v.grp, v.ord, 'migration 0052 (usage review)'
FROM (VALUES
  ('interior_detail',              'Interior Detail',          'Details & washes',  10),
  ('exterior_wash',                'Exterior Wash',            'Details & washes',  20),
  ('mini_detail',                  'Mini Detail',              'Details & washes',  30),
  ('paint_correction_1step',       'Polish',                   'Paint & exterior',  10),
  ('exterior_wax',                 'Wax',                      'Paint & exterior',  20),
  ('clay_bar',                     'Clay Bar',                 'Paint & exterior',  30),
  ('headlight_restoration',        'Headlight Restoration',    'Paint & exterior',  40),
  ('paint_touch_up',               'Paint Touch-Up',           'Paint & exterior',  50),
  ('leather_conditioner',          'Leather Conditioner',      'Interior & engine', 10),
  ('cabin_air_filter_replacement', 'Cabin Air Filter',         'Interior & engine', 20),
  ('engine_bay_clean',             'Engine Bay',               'Interior & engine', 30),
  ('air_duct_cleaning',            'Air Duct Cleaning',        'Odor',              10),
  ('odor_ozone',                   'Ozone Treatment',          'Odor',              20),
  ('complete_odor_treatment',      'Complete Odor Treatment',  'Odor',              30)
) AS v(slug, label, grp, ord)
JOIN service_catalog c ON c.slug = v.slug AND c.archived_at IS NULL
WHERE NOT EXISTS (SELECT 1 FROM service_shortcuts);
