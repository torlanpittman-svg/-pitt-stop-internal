-- P-D3.0: retail QuickBooks linkage on job_estimates (additive, all nullable).
-- Prepares safe, idempotent linkage BEFORE any retail QB write exists. No writes happen
-- against QuickBooks in this phase — these columns stay null / qb_status='none' until a
-- manager creates an invoice from the Invoice Draft in a later phase (P-D3.3+).
-- Dealer QuickBooks state lives on dealer_scans.qb_* and is NOT touched — retail and dealer
-- invoicing remain fully isolated.
-- Convention: idempotent (IF NOT EXISTS), additive only, no semicolons inside comments.

ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_invoice_id      varchar(100);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_invoice_number  varchar(100);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_sync_token      varchar(50);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_status          varchar(20) NOT NULL DEFAULT 'none';
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_content_hash    varchar(64);
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_synced_at       timestamptz;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_sent_at         timestamptz;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_sync_error      text;
ALTER TABLE job_estimates ADD COLUMN IF NOT EXISTS qb_last_request_id varchar(80);

-- One QuickBooks invoice can be linked to at most one estimate. Partial unique index
-- (nulls allowed) so unlinked estimates are unaffected. This is a hard DB guarantee that
-- backstops the application-level compare-and-set duplicate protection.
CREATE UNIQUE INDEX IF NOT EXISTS job_estimates_qb_invoice_uniq
  ON job_estimates (qb_invoice_id) WHERE qb_invoice_id IS NOT NULL;
