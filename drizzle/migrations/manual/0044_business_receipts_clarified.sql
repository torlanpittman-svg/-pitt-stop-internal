-- Business Receipts — exception "clarified/reviewed" acknowledgement (additive, idempotent). Apply AFTER
-- 0038/0039/0040/0042.
--
-- Lets a manager mark an exception's INFORMATION as reviewed and correct while a real-world item is still
-- genuinely OUTSTANDING (a personal-money reimbursement, an unpaid purchase awaiting payment, or a mixed
-- receipt still needing allocation). Such a receipt keeps status 'needs_review' (it is NOT a clean filing —
-- funding stays personal/unpaid and a mixed total stays 'uncategorized', never falsified), but leaves the
-- primary "Needs attention" backlog and moves to an "Outstanding" list. clarified_at IS NULL ⇒ still in the
-- backlog; NOT NULL ⇒ reviewed, outstanding. A manager should never have to claim "business paid" just to
-- clear a clarified receipt from the backlog.
--
-- Single-statement + IF NOT EXISTS so a re-apply is a no-op and existing data is preserved.

ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS clarified_at timestamptz;
ALTER TABLE business_receipts ADD COLUMN IF NOT EXISTS clarified_by varchar(200);
