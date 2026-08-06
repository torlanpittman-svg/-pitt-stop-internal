-- Phase 1: lightweight per-person identity + roles on the existing employees list.
-- Additive / nullable; safe to re-run. No changes to service_orders (attribution
-- reuses existing checked_in_by / event.employee_name / assignment.employee_name).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role     varchar(20) NOT NULL DEFAULT 'employee'; -- employee | manager | admin
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_hash varchar(120);  -- scrypt hash, managers/admins only
