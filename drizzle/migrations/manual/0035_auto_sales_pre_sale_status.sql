-- Auto-Sales B7.1 — preserve the true pre-sale status for a faithful reversal.
-- ADDITIVE ONLY (one new nullable column). Idempotent. Safe to re-run.
-- recordSale captures the vehicle's status at finalize time here (atomically); reverseSale restores it
-- (fallback 'listed') so reversing a sale does not assume every vehicle was previously 'listed'.
ALTER TABLE inventory_vehicles ADD COLUMN IF NOT EXISTS pre_sale_status varchar(20); -- status the vehicle held immediately before the sale
