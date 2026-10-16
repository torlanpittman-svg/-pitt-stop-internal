-- 0051_job_service_catalog_identity.sql
-- Additive, non-destructive, idempotent. Give each job_services row a STABLE catalog identity
-- (service_catalog.id) separate from its editable `title` label, so a retail/standalone-estimate
-- QuickBooks line keeps its correct Product/Service item + canonical qb_description even after a
-- manager edits the label (e.g. "Full Detail" -> "Full Detail - customer vehicle"). NULL = a
-- genuinely custom one-off service (generic Labor fallback), exactly as before.
--
-- The FK lives only in SQL (not in the Drizzle table definition) to avoid a circular import
-- between apps/workflow/schema.ts and apps/quick-entry/schema.ts -- same pattern as
-- service_orders.customer_id / billing_customer_id. It is ON DELETE RESTRICT: service_catalog is
-- soft-deleted (archived_at), never hard-deleted, so historical identity links are retained rather
-- than silently nulled (a null would re-enable label-based remapping). The index is modeled in the
-- Drizzle schema (no cross-module reference needed); it is (re)created here too for environments
-- applied straight from SQL.

ALTER TABLE job_services
  ADD COLUMN IF NOT EXISTS catalog_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'job_services_catalog_id_fk'
  ) THEN
    ALTER TABLE job_services
      ADD CONSTRAINT job_services_catalog_id_fk
      FOREIGN KEY (catalog_id) REFERENCES service_catalog(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS job_services_catalog_idx ON job_services (catalog_id);

-- ── Backfill (safe + idempotent: only fills rows that have no identity yet) ──────────────────────
-- For every row without an identity, choose the EARLIEST title (across its own rename history and
-- its current label) that maps UNAMBIGUOUSLY to a non-archived catalog item. Rename history is
-- preferred over the current label so a legacy row that was relabeled to ANOTHER catalog item's
-- name (e.g. "Full Detail" -> "Exterior Wash") recovers its ORIGINAL item instead of being pinned
-- to the new label; a typo that was later corrected still resolves from the corrected step.
--
-- A UNIQUE exact catalog NAME beats any alias (so a canonical "Complete Detail" never degrades to
-- Labor just because another catalog carries it as an alias); an alias fills only a key that is not
-- any catalog name AND maps to exactly one catalog. Duplicate exact names stay unfilled (we never
-- guess) -- the runtime mapper still resolves those at payload time.
--
-- Audit notes are parsed safely: pg_input_is_valid guards the jsonb cast, because some notes are
-- JSON objects that still fail a strict jsonb cast (so IS JSON OBJECT alone is not enough and a
-- direct cast could abort the release). ->> unescapes quotes and backslashes so names such as
-- `Interior "Premium"` recover. We require string 'serviceId' + 'from', compare serviceId as TEXT
-- to id::text (no untrusted UUID cast), bind recovery to the SAME order as the service, and order
-- deterministically by event time then id. Normalization matches the app: trim, collapse
-- whitespace, lowercase.
WITH name_keys AS (
  SELECT lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g')) AS key, c.id AS catalog_id
  FROM service_catalog c
  WHERE c.archived_at IS NULL
),
name_uniq AS (
  SELECT key, min(catalog_id::text)::uuid AS catalog_id
  FROM name_keys
  WHERE key <> ''
  GROUP BY key
  HAVING count(DISTINCT catalog_id) = 1
),
alias_uniq AS (
  SELECT key, min(catalog_id::text)::uuid AS catalog_id
  FROM (
    SELECT lower(regexp_replace(btrim(a.alias), '\s+', ' ', 'g')) AS key, a.catalog_id
    FROM service_aliases a
    JOIN service_catalog c ON c.id = a.catalog_id AND c.archived_at IS NULL
  ) ak
  WHERE key <> ''
    AND key NOT IN (SELECT key FROM name_keys WHERE key <> '')
  GROUP BY key
  HAVING count(DISTINCT catalog_id) = 1
),
uniq AS (
  SELECT key, catalog_id FROM name_uniq
  UNION ALL
  SELECT key, catalog_id FROM alias_uniq
),
targets AS (
  SELECT id, job_estimate_id FROM job_services WHERE catalog_id IS NULL AND source <> 'system'
),
parsed_events AS (
  -- Guarded parse: a note that fails a strict jsonb cast yields NULL instead of aborting.
  SELECT e.service_order_id, e.created_at, e.id AS event_id,
         CASE WHEN pg_input_is_valid(e.note, 'jsonb') THEN e.note::jsonb END AS data
  FROM service_order_events e
  WHERE e.event_type = 'service_renamed' AND e.note IS NOT NULL
),
rename_events AS (
  SELECT service_order_id, created_at, event_id,
         lower(data ->> 'serviceId') AS service_id_txt,
         lower(regexp_replace(btrim(data ->> 'from'), '\s+', ' ', 'g')) AS key
  FROM parsed_events
  WHERE data IS NOT NULL
    AND jsonb_typeof(data) = 'object'
    AND jsonb_typeof(data -> 'serviceId') = 'string'
    AND jsonb_typeof(data -> 'from') = 'string'
),
candidates AS (
  -- Historical titles from THIS service's own rename events (bound to the same order), earliest first.
  SELECT t.id AS service_id, re.created_at AS ord, re.event_id::text AS tie, re.key
  FROM targets t
  JOIN job_estimates je ON je.id = t.job_estimate_id
  JOIN rename_events re
    ON re.service_order_id = je.service_order_id
   AND re.service_id_txt = lower(t.id::text)
  UNION ALL
  -- Current label as the LAST-resort candidate (only used when no earlier title mapped).
  SELECT t.id, 'infinity'::timestamptz, '', lower(regexp_replace(btrim(js.title), '\s+', ' ', 'g'))
  FROM targets t
  JOIN job_services js ON js.id = t.id
),
resolved AS (
  SELECT DISTINCT ON (c.service_id) c.service_id, u.catalog_id
  FROM candidates c
  JOIN uniq u ON u.key = c.key
  ORDER BY c.service_id, c.ord ASC, c.tie ASC
)
UPDATE job_services js
SET catalog_id = r.catalog_id
FROM resolved r
WHERE js.id = r.service_id
  AND js.catalog_id IS NULL
  AND js.source <> 'system';
