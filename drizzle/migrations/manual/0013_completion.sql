-- Phase 2: true completion. completed_at already exists (was set at qc_ready — now
-- moved to the Ready completion gate). Additive, nullable, re-runnable.
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS completed_by         varchar(200);
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS completion_checklist jsonb;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS qc_required          boolean NOT NULL DEFAULT false;
