-- 0081 — appointment outcome "Attended — estimate declined" (2026-11-17).
-- New terminal appointments.status 'declined': the customer ATTENDED the drop-off, received an estimate,
-- and declined it. Distinct from cancelled (never came by choice), no_show (never came), and arrived
-- (checked in — a Job exists). Recorded retrospectively by a manager; the appointment_events row's
-- created_at is the recorded-at time — arrived_at is NEVER set for a declined appointment.
-- Declining also marks the linked marketing lead Lost (apps/appointments/db.ts declineEstimate).
-- Extends appointments_status_chk ONLY: no new columns, no data rewrite, no GRANT/privilege change.
-- Idempotent: drop-if-exists + re-add converges on the same constraint on every run.
-- TRANSACTIONAL: drop + re-add commit together, so a failed ADD (lock timeout, unexpected data) rolls
-- the DROP back too and the table is never left without its status constraint.
BEGIN;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_chk;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_chk
  CHECK (status IN ('confirmed', 'arrived', 'cancelled', 'no_show', 'declined'));
COMMIT;
