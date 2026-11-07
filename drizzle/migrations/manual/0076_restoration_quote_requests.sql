-- 0076_restoration_quote_requests.sql
-- Insurance-restoration estimate funnel (2026-11-07). Additive, non-destructive, idempotent (safe to re-run).
-- Depends on 0075 (quote_requests). Independent of 0074 (gift cards, still held).
--
-- Why: the public /quote form becomes the ONE estimate request path for vandalism / break-in, paint
-- overspray, water damage and broken-glass cleanup as well as the existing detailing services. The
-- acquisition project needs, per request: the damage type (so leads, estimates, jobs and revenue roll up
-- by service line), the customer's self-declared insurance claim status (informational only -- never a
-- promise of coverage), the optional incident date, the landing page the request came from, and the
-- click attribution captured at submit time (utm_*, gclid, fbclid, lp) so a lead that never books still
-- carries its channel. The marketing_attribution table is unchanged and still the reporting source for
-- channels. The claim row is append-mostly: these columns are written once in the same atomic CTE that
-- creates the row, never updated afterwards.
--
-- No PII beyond what quote_requests already carried via marketing_leads. `attribution` holds only the
-- allow-listed ATTRIBUTION_KEYS (apps/appointments/attribution.ts), never the customer's name/phone/email.

ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS damage_type   varchar(24);
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS claim_status  varchar(16);
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS incident_date date;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS landing_page  varchar(120);
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attribution   jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Reporting index: restoration requests by damage type over time (partial -- older detailing rows stay NULL).
CREATE INDEX IF NOT EXISTS quote_requests_damage_type_created_idx
  ON quote_requests (damage_type, created_at) WHERE damage_type IS NOT NULL;

-- Modeled labor cost for the restoration contribution report. 0 = not configured, and the report then
-- shows contribution as "labor cost not modeled" instead of pretending labor is free. Owner-set via
-- /marketing/restoration; stored as a whole percent of invoiced labor (e.g. 35 = 35%).
INSERT INTO app_settings (key, value, type, category, label, description)
VALUES ('restoration_labor_cost_pct', '0'::jsonb, 'int', 'marketing', 'Restoration labor cost %',
        'Modeled labor cost as a percent of invoiced labor on insurance-restoration jobs. 0 = not modeled.')
ON CONFLICT (key) DO NOTHING;
