-- Check print-path safety (duplicate prevention + bridge status).
--
-- ADDITIVE ONLY — safe to re-run; changes no existing row and no existing column.
--
-- 1) At most ONE active print job per check. "Active" = queued / claimed / submitted (handed to the
--    printer but not yet confirmed by a manager) / stuck (reported not printed, original not yet cleared). Postgres enforces it, so two simultaneous "send to
--    printer" requests can never both enqueue a copy of the same negotiable check. VOID test pages have
--    check_id NULL and are not constrained.
--    PREFLIGHT (must return 0 rows before applying):
--      SELECT check_id, count(*) FROM print_jobs
--       WHERE check_id IS NOT NULL AND status IN ('queued','claimed','submitted','stuck')
--       GROUP BY check_id HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_one_active_per_check
  ON print_jobs (check_id)
  WHERE check_id IS NOT NULL AND status IN ('queued', 'claimed', 'submitted', 'stuck');

-- 2) Print-bridge heartbeat: one row per bridge, updated when it polls the queue. Telemetry only.
CREATE TABLE IF NOT EXISTS print_bridges (
  bridge_id     varchar(100) PRIMARY KEY,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  version       varchar(32),
  platform      varchar(32),
  printer       varchar(120)
);
