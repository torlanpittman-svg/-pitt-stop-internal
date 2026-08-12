-- P-D1: seed the configurable payment charge (card) so it is visible/editable in Admin.
-- Default ON for retail (most customers pay by card). The fee engine forces it OFF for
-- dealer Jobs and honors per-Job waivers. The final customer-facing label + surcharge/
-- "cash discount" compliance treatment need CPA/processor sign-off before automated QB
-- invoicing. Additive and re-runnable — never overwrites an admin edit.
-- NOTE: no semicolons inside comments (the manual-migration splitter breaks on them).

INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('payment_charge_enabled', 'true'::jsonb, 'bool', 'fees', 'Payment charge enabled', 'Card-payment charge on retail invoices, ON by default, forced OFF for dealer Jobs')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('payment_charge_bps', '300'::jsonb, 'int', 'fees', 'Payment charge rate (bps)', '300 = 3.00 percent')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('payment_charge_label', '"Card Payment"'::jsonb, 'string', 'fees', 'Payment charge label (customer-facing)', 'Working label pending CPA/processor sign-off, do not hard-code')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value, type, category, label, description) VALUES
  ('payment_charge_basis', '"work_plus_supplies"'::jsonb, 'string', 'fees', 'Payment charge basis', 'work_only | work_plus_supplies | grand_pretax, default matches 3 percent of work + shop supplies')
  ON CONFLICT (key) DO NOTHING;
