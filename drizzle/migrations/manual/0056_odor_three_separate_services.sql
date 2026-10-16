-- 0056_odor_three_separate_services.sql
-- Catalog DATA only (no schema change). Owner's final definition (2026-10-16) — THREE separate services,
-- no combined package:
--   1. Ozone Treatment      — ozone treatment by itself                     (existing row, unchanged)
--   2. Air Duct Cleaning    — cleaning the vehicle's air ducts               (existing row, unchanged)
--   3. Odor Treatment       — steam cleaning the entire interior and using smoke odor removal products
--                             (NEW row; it does NOT include ozone or duct cleaning)
-- Several performed together are separate lines, each with its own price and approved description.
--
-- Idempotent and precondition-guarded; every change is recorded in service_catalog_events.
--   * The new Odor Treatment row uses the owner's wording as its canonical description and the EXISTING
--     active QuickBooks item "Odor Treatment" (#68; verified read-only: Service, "Apply odor treatment to
--     remove unwanted smells"). It is NOT mapped to the Ozone item. No QuickBooks item is created, renamed
--     or changed. No default price: a price is entered on each job.
--   * "Complete Odor Treatment" (package) is retired from new picks and matching (active = false). It is
--     not repurposed: its name, description, item and any existing lines keep their meaning for history.
--   * "Odor / Ozone Treatment" (legacy combined) stays retired (0053); its historical QuickBooks aliases
--     are kept as records but are ignored for new matching (inactive row).
--   * The "Complete Odor Treatment" shortcut is pointed at Odor Treatment (relabelled) — skipped if a
--     manager already made an Odor Treatment shortcut.
-- Existing estimate/invoice lines are not touched.

DO $$
DECLARE
  odor_id uuid;
  pkg service_catalog%ROWTYPE;
BEGIN
  -- ── 1. Odor Treatment (standalone) ─────────────────────────────────────────────────────────────
  INSERT INTO service_catalog (slug, name, kind, quick_entry, default_price_cents, price_editable, active, sort_order, source,
    qb_item_ref, qb_item_status, qb_sync_enabled, qb_description, review_flag, service_role, role_confirmed_by, role_confirmed_at, notes)
  VALUES ('odor_treatment', 'Odor Treatment', 'addon', true, NULL, true, true, 175, 'owner',
    '68', 'existing', true, 'Steam cleaning the entire interior and using smoke odor removal products to get rid of the smells.', false,
    'odor_treatment', 'owner definition (2026-10-16, final)', now(),
    'Standalone odor treatment (owner definition): interior steam cleaning + smoke odor removal products. Does NOT include Ozone Treatment or Air Duct Cleaning. Price entered per job.')
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO odor_id;

  IF odor_id IS NOT NULL THEN
    INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
    VALUES (odor_id, 'catalog_seeded', 'migration 0056',
      json_build_object('name', 'Odor Treatment', 'qbItemRef', '68', 'qbItemName', 'Odor Treatment',
        'description', 'Steam cleaning the entire interior and using smoke odor removal products to get rid of the smells.',
        'basis', 'owner final definition: three separate odor services, no package; existing active QuickBooks item, verified read-only')::text);
  ELSE
    SELECT id INTO odor_id FROM service_catalog WHERE slug = 'odor_treatment';
  END IF;

  -- ── 2. Retire the Complete Odor Treatment package (never repurposed) ──────────────────────────
  SELECT * INTO pkg FROM service_catalog WHERE slug = 'complete_odor_treatment';
  IF FOUND AND pkg.active THEN
    UPDATE service_catalog SET active = false, updated_at = now(),
      notes = btrim(COALESCE(notes, '') || ' [0056] Retired: there is no odor package. Ozone Treatment, Air Duct Cleaning and Odor Treatment are separate services, each its own line. Existing lines keep this record.')
     WHERE id = pkg.id AND active;
    INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
    VALUES (pkg.id, 'catalog_retired', 'migration 0056',
      json_build_object('name', pkg.name, 'reason', 'owner final definition: no combined odor package; the three services are separate lines', 'replacement', NULL)::text);
  END IF;

  -- ── 3. Shortcut: Complete Odor Treatment → Odor Treatment ─────────────────────────────────────
  IF pkg.id IS NOT NULL THEN
    WITH moved AS (
      UPDATE service_shortcuts s SET catalog_id = odor_id, label = 'Odor Treatment', updated_at = now(), updated_by = 'migration 0056'
       WHERE s.catalog_id = pkg.id AND s.hidden_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM service_shortcuts x WHERE x.catalog_id = odor_id AND x.hidden_at IS NULL)
      RETURNING s.id, s.label
    )
    INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
    SELECT odor_id, 'shortcut_repointed', 'migration 0056',
           json_build_object('shortcutId', id, 'label', 'Odor Treatment', 'previousLabel', 'Complete Odor Treatment', 'from', pkg.id, 'to', odor_id)::text
      FROM moved;
  END IF;
END $$;
