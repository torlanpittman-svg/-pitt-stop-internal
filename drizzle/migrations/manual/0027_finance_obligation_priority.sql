-- CFO Phase 2 — obligation priority tiers + payroll semantics. Additive, idempotent.
-- Priority drives Safe-to-Spend decision support ("payroll clears if the $1,000 draw is deferred").
-- committed_on_issue: obligation reduces economically-available cash on its due/issue date even if
-- the bank hasn't cleared it yet (e.g. paper payroll checks issued Friday). No money movement.

ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS priority varchar(16) NOT NULL DEFAULT 'contractual'; -- critical|contractual|planned
ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS committed_on_issue boolean NOT NULL DEFAULT false;
ALTER TABLE fin_obligations ADD COLUMN IF NOT EXISTS day_of_month integer; -- for monthly obligations (rent 15th, fed tax 15th)
CREATE INDEX IF NOT EXISTS fin_obl_priority_idx ON fin_obligations(priority);
