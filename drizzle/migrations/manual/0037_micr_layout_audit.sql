-- MICR-only calibration audit — append-only history of changes to the isolated `micr_layout` setting.
--
-- Isolation guarantees (enforced in apps/checks/micr-config.ts, recorded here):
--   * only MICR coordinate fields (baselineFromBottomIn / rightMarginIn / amountFieldIn / pitchIn / sizePt)
--     may change; any non-MICR check geometry key is rejected before a write occurs;
--   * every change requires an explicit reason and records who + when + old + new MICR coordinates;
--   * writing here NEVER enables MICR, creates a check, creates a QuickBooks transaction, or consumes /
--     advances the check-number sequence. Negotiable printing stays fail-closed.
--
-- ADDITIVE ONLY — safe to re-run; touches no data and no existing table.

CREATE TABLE IF NOT EXISTS micr_layout_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       varchar(120),
  reason      text NOT NULL,
  old_value   jsonb,
  new_value   jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS micr_layout_audit_created_idx ON micr_layout_audit (created_at);
