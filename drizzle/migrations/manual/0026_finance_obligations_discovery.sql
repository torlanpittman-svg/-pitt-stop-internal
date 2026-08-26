-- CFO Phase 2 — recurring-obligation discovery. Additive, idempotent.
-- Lets the CFO PROPOSE recurring obligations from transaction history (evidence-backed, never
-- silently authoritative). Owner Confirms/Edits/Ignores. No QuickBooks writes; no money movement.

ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS discovery_key   varchar(140);
ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS evidence        jsonb;
ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS occurrences     integer;
ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS last_seen       date;
ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS avg_amount_cents integer;
ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS day_of_week     integer;   -- 0=Sun..6=Sat (modal)
ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS critical        boolean NOT NULL DEFAULT false; -- payroll/rent/debt

-- One proposal per discovered stream; re-running discovery updates in place instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS fin_obl_discovery_key_uniq ON fin_obligations(discovery_key) WHERE discovery_key IS NOT NULL;
