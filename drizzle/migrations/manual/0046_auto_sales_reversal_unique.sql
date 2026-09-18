-- Auto Sales — atomic reversal/removal guard (additive, idempotent). Apply AFTER 0029–0034.
--
-- Every correction in the vehicle ledger (a mistaken-attachment expense removal, the History "undo",
-- an acquisition-price edit) is an append-only event whose `reverses_event_id` points at the event it
-- nets to zero. Correcting the SAME event twice is meaningless and, under simultaneous requests, a
-- sequential "already reversed?" check in app code can race and append two adjustments. This partial
-- UNIQUE index makes the invariant atomic at the database: at most ONE active (non-void) reversal per
-- reversed event. A concurrent second insert loses here and the app treats it as already-removed.
--
-- Void reversals are excluded from the predicate so a superseded/undone correction never blocks a new one.
-- Single statement + IF NOT EXISTS so a re-apply is a no-op; existing data is preserved. Each existing
-- reversal already targets a distinct event (edits reverse the CURRENT acquisition, not a prior one), so
-- no duplicate rows should exist to block creation.

CREATE UNIQUE INDEX IF NOT EXISTS vfe_reverses_active_uniq
  ON vehicle_financial_events (reverses_event_id)
  WHERE reverses_event_id IS NOT NULL AND status <> 'void';
