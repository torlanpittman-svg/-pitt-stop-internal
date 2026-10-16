-- 0057_odor_ozone_descriptions.sql
-- Catalog DATA only (no schema change). Owner-approved canonical invoice descriptions (2026-10-16):
--   Odor Treatment  → "Comprehensive steam cleaning of the vehicle’s interior, combined with professional
--                      odor-neutralizing products to address unwanted odors throughout the cabin."
--                      (odor generally — not specifically smoke)
--   Ozone Treatment → "Professional ozone treatment of the vehicle’s interior to help neutralize persistent
--                      odors and refresh the cabin."
-- Air Duct Cleaning keeps its approved description. Same audit shape as an edit in Manage services
-- ('catalog_updated' with before/after). Precondition-guarded: each row changes only while it still has
-- exactly the previous approved text, so a manager's own later edit is never overwritten; re-running
-- changes nothing. Future lines snapshot the new text; existing lines and QuickBooks documents are untouched.
-- No QuickBooks write here (the Odor Treatment item's income account is set separately, from the app).

WITH plan(slug, before_text, after_text) AS (VALUES
  ('odor_treatment',
   'Steam cleaning the entire interior and using smoke odor removal products to get rid of the smells.',
   'Comprehensive steam cleaning of the vehicle’s interior, combined with professional odor-neutralizing products to address unwanted odors throughout the cabin.'),
  ('ozone_treatment',
   'Ozone treatment.',
   'Professional ozone treatment of the vehicle’s interior to help neutralize persistent odors and refresh the cabin.')
), changed AS (
  UPDATE service_catalog c
     SET qb_description = p.after_text, updated_at = now(),
         notes = CASE WHEN c.slug = 'odor_treatment'
                      THEN 'Standalone odor treatment (owner definition): interior steam cleaning + odor-neutralizing products, for unwanted odors generally. Does NOT include Ozone Treatment or Air Duct Cleaning. Price entered per job.'
                      ELSE c.notes END
    FROM plan p
   WHERE c.slug = p.slug AND c.archived_at IS NULL AND c.qb_description = p.before_text
  RETURNING c.id, c.name, p.before_text, p.after_text
)
INSERT INTO service_catalog_events (catalog_id, event_type, actor, note)
SELECT id, 'catalog_updated', 'migration 0057',
       json_build_object('name', name, 'before', json_build_object('qbDescription', before_text),
         'after', json_build_object('qbDescription', after_text), 'basis', 'owner-approved canonical invoice description (2026-10-16)')::text
  FROM changed;
