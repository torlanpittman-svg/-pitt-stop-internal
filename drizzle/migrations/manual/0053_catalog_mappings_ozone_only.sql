-- 0053_catalog_mappings_ozone_only.sql
-- Catalog DATA follow-up to 0052 plus one safety index. Idempotent and precondition-guarded: every
-- step only touches a row that is still exactly as 0052 left it, so a manager's own correction made in
-- Manage services is never overwritten, and re-running changes nothing. No QuickBooks item is created,
-- merged, renamed or deactivated; existing estimate/invoice lines are not touched (they keep their
-- catalog identity and the description snapshot taken when they were added).
--
-- 1. Seven reviewed catalog rows are finished onto EXISTING, active QuickBooks items (owner-authorized
--    2026-10-16; each item verified active in QuickBooks, read-only). Only the item reference changes:
--    the invoice line text stays the catalog's approved description — or the service NAME while none is
--    written — never the item's historical QuickBooks text ("Clean rear seats", "Paint front bumper…").
--    Rows still without an approved description stay flagged for manager review.
-- 2. Ozone Treatment becomes its own ozone-only service (owner definition) on the existing QuickBooks
--    "Ozone" item (#24, the item ozone work has always billed under). The legacy combined
--    "Odor / Ozone Treatment" (ozone + fabric steam cleaning, $300) is preserved untouched for history,
--    its price, aliases and existing lines, but is no longer offered for NEW picks; the "Ozone
--    Treatment" shortcut now points at the ozone-only service (label/group/order unchanged).
--    Skipped entirely if a manager already confirmed the legacy row as the ozone option.
-- 3. A part's estimate row can back at most one live job_parts record (retry/double-tap safety).

-- ── 1. Seven QuickBooks mappings ──────────────────────────────────────────────────────────────
WITH plan(slug, ref) AS (VALUES
  ('air_duct_cleaning', '76'),             -- Air duct
  ('cabin_air_filter_replacement', '88'),  -- Cabin air filter
  ('complete_odor_treatment', '68'),       -- Odor Treatment
  ('installation_labor', '73'),            -- Install
  ('paint_refinish', '57'),                -- Paint
  ('paint_touch_up', '35'),                -- Paint touch up
  ('seat_shampoo', '23')                   -- Clean seats
), mapped AS (
  UPDATE service_catalog c
     SET qb_item_ref = p.ref, qb_item_status = 'existing', qb_sync_enabled = true,
         review_flag = (c.qb_description IS NULL OR btrim(c.qb_description) = ''), updated_at = now()
    FROM plan p
   WHERE c.slug = p.slug AND c.archived_at IS NULL
     AND c.qb_item_ref IS NULL AND c.qb_item_status = 'mapping_review' AND c.qb_sync_enabled = false
     AND c.qb_candidate_ref = p.ref
  RETURNING c.id, c.name, p.ref, c.qb_description
)
INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
SELECT id, 'qb_item_mapped', 'migration 0053',
       json_build_object('name', name, 'qbItemRef', ref, 'basis', 'owner-authorized mapping to an existing active QuickBooks item',
         'invoiceText', COALESCE(NULLIF(btrim(qb_description), ''), name || ' (service name — approved description still to be written)'))::text
  FROM mapped;

-- ── 2. Ozone-only service + legacy combined row retired from new picks ──────────────────────────
DO $$
DECLARE
  legacy  service_catalog%ROWTYPE;
  ozone_id uuid;
BEGIN
  SELECT * INTO legacy FROM service_catalog WHERE slug = 'odor_ozone';   -- production id b3d06a9b-8613-462a-baaf-d7e2e285e57a
  IF NOT FOUND OR legacy.role_confirmed_at IS NOT NULL THEN
    RETURN;   -- no legacy row here, or a manager already decided what it is: leave the catalog as is
  END IF;

  INSERT INTO service_catalog (slug, name, kind, quick_entry, default_price_cents, price_editable, active, sort_order, source,
    qb_item_ref, qb_item_status, qb_sync_enabled, qb_description, review_flag, service_role, role_confirmed_by, role_confirmed_at, notes)
  VALUES ('ozone_treatment', 'Ozone Treatment', legacy.kind, legacy.quick_entry, NULL, true, true, legacy.sort_order, 'owner',
    '24', 'existing', true, 'Ozone treatment.', false, 'odor_ozone', 'owner definition (2026-10-16)', now(),
    'Ozone treatment only (owner definition). Price entered per job. Separate from the legacy combined "Odor / Ozone Treatment" (ozone + fabric steam).')
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO ozone_id;

  IF ozone_id IS NOT NULL THEN
    INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
    VALUES (ozone_id, 'catalog_seeded', 'migration 0053',
      'Ozone-only service (owner definition) on existing QuickBooks item "Ozone" (#24). Legacy "Odor / Ozone Treatment" kept for history.');
  ELSE
    SELECT id INTO ozone_id FROM service_catalog WHERE slug = 'ozone_treatment';
  END IF;

  INSERT INTO service_aliases (catalog_id, alias, source, approved_for_ai, approved_by, approved_at)
  VALUES (ozone_id, 'Ozone', 'owner', true, 'owner definition (2026-10-16)', now())
  ON CONFLICT ON CONSTRAINT service_aliases_uniq DO NOTHING;

  IF legacy.active THEN
    UPDATE service_catalog SET active = false, updated_at = now(),
      notes = btrim(COALESCE(notes, '') || ' [0053] Not offered for new jobs: ozone + fabric steam is not the ozone-only service. Existing lines, price and QuickBooks item unchanged.')
     WHERE id = legacy.id AND active;
    INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
    VALUES (legacy.id, 'catalog_retired', 'migration 0053',
      json_build_object('name', legacy.name, 'reason', 'combined ozone + fabric steam; replaced for new picks by ozone-only "Ozone Treatment"', 'replacement', ozone_id)::text);
  END IF;

  WITH moved AS (
    UPDATE service_shortcuts s SET catalog_id = ozone_id, updated_at = now(), updated_by = 'migration 0053'
     WHERE s.catalog_id = legacy.id AND s.hidden_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM service_shortcuts x WHERE x.catalog_id = ozone_id AND x.hidden_at IS NULL)
    RETURNING s.id, s.label
  )
  INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
  SELECT ozone_id, 'shortcut_repointed', 'migration 0053',
         json_build_object('shortcutId', id, 'label', label, 'from', legacy.id, 'to', ozone_id)::text
    FROM moved;
END $$;

-- ── 3. One live part record per estimate part row ─────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS job_parts_active_service_uniq
  ON job_parts (job_service_id) WHERE job_service_id IS NOT NULL AND status <> 'cancelled';
