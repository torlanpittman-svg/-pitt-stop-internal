-- 0080 — QuickBooks mirror: who the entry was paid to (2026-11-13).
-- A QuickBooks Purchase paid to an EMPLOYEE is payroll, an owner draw or a reimbursement — not a vendor
-- purchase. The counted-once view keeps those out of the purchase total and lists them separately.
-- payee_type = QuickBooks EntityRef.type (Vendor | Employee | Customer | …); 'Vendor' for a Bill. Additive.
ALTER TABLE fin_qb_purchases ADD COLUMN IF NOT EXISTS payee_type varchar(16);
