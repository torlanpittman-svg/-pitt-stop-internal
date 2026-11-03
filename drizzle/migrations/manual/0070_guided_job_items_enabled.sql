-- 0070 — Guided Services + Parts on the Job screen: rollout switch row (2026-11-03).
-- Interface-only switch (see apps/settings/db.ts SETTINGS.guided_job_items_enabled). The code defaults OFF;
-- this row turns the guided Job screen ON for every shop role. Server-side money/permission rules
-- (required customer price on the guided add, employee part removal only until a QuickBooks invoice
-- exists, manager-only service removal) apply whichever interface is shown. Turning it off never undoes
-- saved parts, prices or removals.
--
--   Enable  : apply this file (node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0070_guided_job_items_enabled.sql).
--   Disable : UPDATE app_settings SET value = 'false'::jsonb, updated_at = now() WHERE key = 'guided_job_items_enabled';
--             Takes effect on the next page load (no redeploy). The row wins over env GUIDED_JOB_ITEMS_ENABLED.
--   Avoid /admin/settings for this: its Save re-submits EVERY setting (string/json ones through number inputs).
-- Idempotent.
INSERT INTO app_settings (key, value, type, category, label, description)
VALUES ('guided_job_items_enabled', 'true'::jsonb, 'bool', 'rollout', 'Guided Services + Parts (Job screen)',
        'ON = services with their attached parts, in-place add with a required customer price, name · amount · Remove rows. OFF = the previous Job screen. Interface only; server rules apply either way.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, type = EXCLUDED.type, updated_at = now();
