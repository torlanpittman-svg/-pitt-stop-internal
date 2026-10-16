-- 0054_clarify_part_idempotency.sql
-- "Clarify a service line as (also) a part" must be atomic and idempotent. The whole operation now
-- runs as a single SQL statement (apps/parts/estimate-parts.ts#clarifyServiceWithPart); this adds the
-- CLAIM that makes a retry, a double-tap, or two simultaneous requests collapse to ONE part instead of
-- creating duplicate charged parts.
--
-- clarifies_service_id records the service line a clarification attached the part to. It is set ONLY by
-- that operation (null for every other part), so the partial unique index below can enforce "at most one
-- live clarification part per (clarified line, description, source)" WITHOUT constraining ordinary parts
-- or intentional same-named parts from different sources. Additive and idempotent: safe to re-run, no
-- data is changed, no QuickBooks item is touched.

ALTER TABLE job_parts
  ADD COLUMN IF NOT EXISTS clarifies_service_id uuid REFERENCES job_services(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS job_parts_clarify_uniq
  ON job_parts (clarifies_service_id, description, supply)
  WHERE clarifies_service_id IS NOT NULL AND status <> 'cancelled';
