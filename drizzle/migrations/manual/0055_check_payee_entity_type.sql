-- 0055_check_payee_entity_type.sql
-- A check's QuickBooks payee (Purchase EntityRef) can be a Vendor, an Employee, or a Customer. The check
-- row stored only the payee's id (payee_qbo_vendor_id), and QuickBooks ids are only unique WITHIN one
-- list — so a retry must also know which list the id belongs to. This records it.
--
-- Additive and idempotent: safe to re-run. Every existing check was written to a Vendor, so the default
-- 'Vendor' is exactly right for existing rows. No QuickBooks data is touched.

ALTER TABLE checks
  ADD COLUMN IF NOT EXISTS payee_qbo_entity_type varchar(16) NOT NULL DEFAULT 'Vendor';

-- Plain statements (no DO block) so scripts/apply-qb-migration.mjs, which splits on ';', applies it as-is.
-- Drop-then-add keeps it re-runnable; validating the constraint is instant on this small table.
ALTER TABLE checks DROP CONSTRAINT IF EXISTS checks_payee_qbo_entity_type_chk;

ALTER TABLE checks
  ADD CONSTRAINT checks_payee_qbo_entity_type_chk
  CHECK (payee_qbo_entity_type IN ('Vendor', 'Employee', 'Customer'));
