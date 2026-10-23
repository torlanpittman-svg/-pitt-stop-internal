-- 0064_dealership_optional_prefix.sql
-- Some dealers (BMW of College Station) have NO dealer-specific stock prefix: their stock/tag number is
-- simply the last 8 characters of the VIN. Staff pick these dealers manually from the dealer dropdown, and
-- they must never auto-match a stock number. A NULL stock_prefix means exactly that.
--
-- Empty string is forbidden on purpose: legacy code compares with startsWith(prefix), and startsWith('')
-- is true for every stock number - an empty prefix would silently claim every vehicle. NULL is the only
-- "no prefix" value.
--
-- Additive and relaxing only: every existing row (Sterling S/T/K/U, Purdy AP) keeps its prefix unchanged;
-- the CHECK holds for all of them. Safe to apply before or after the code deploy.

ALTER TABLE dealerships ALTER COLUMN stock_prefix DROP NOT NULL;

ALTER TABLE dealerships
  ADD CONSTRAINT dealerships_stock_prefix_not_blank
  CHECK (stock_prefix IS NULL OR btrim(stock_prefix) <> '');
