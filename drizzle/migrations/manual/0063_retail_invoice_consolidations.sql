-- 0063_retail_invoice_consolidations.sql
-- Combine unpaid invoices: a manager combines two EXISTING unpaid, app-created retail invoices of the same
-- confirmed QuickBooks customer into one. The REPLACED invoice is voided in QuickBooks (operation=void keeps the
-- transaction and its number, zeroes its amounts - nothing is deleted) and its Job joins the RETAINED invoice as a
-- shared-invoice member (0062 retail_invoice_members). Each row is the durable record of one consolidation and
-- keeps the replaced invoice's identity (id, number, SyncToken, lines fingerprint, total) permanently.
--
--   status  prepared   claimed - replaced Job locked (qb_status consolidating) + pending member row, no QB write yet
--           voided     replaced invoice voided in QuickBooks
--           relinked   replaced Job no longer points at its voided invoice (pending member of the retained one)
--           completed  retained invoice carries both Jobs' charges (member applied)
--           cancelled  stopped before any QuickBooks write - both invoices unchanged
--           separated  stopped after the void - replaced Job back on separate billing
--
-- ric_replaced_active_uniq / ric_retained_active_uniq: one unfinished consolidation per Job on either side.
-- ric_customer_active_uniq: one unfinished consolidation per QuickBooks customer within one QuickBooks company
-- (qb_realm_id, qb_customer_id) - customer ids are only unique per company. It covers every unfinished state
-- (prepared, voided, relinked), recovery included. Both invoices of a combine belong to that customer, so this also stops a Job being RETAINED in one combine and REPLACED in another when
-- two starts race (the claim's NOT EXISTS checks alone can't see a concurrent claim under READ COMMITTED).
-- ric_request_uniq: a double tap or retried request reuses the same row.
--
-- Additive and idempotent: one new table, no change to existing rows. Plain statements only (no DO blocks, no
-- semicolons in comments) so scripts/apply-qb-migration.mjs, which splits on semicolons, applies it as-is.
-- Ships dark: the feature is gated by app_settings retail_qb_combine_invoices_enabled (defaults OFF in code).

CREATE TABLE IF NOT EXISTS retail_invoice_consolidations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                  varchar(80) NOT NULL,
  status                      varchar(20) NOT NULL DEFAULT 'prepared',
  retained_estimate_id        uuid NOT NULL REFERENCES job_estimates(id),
  retained_service_order_id   uuid NOT NULL REFERENCES service_orders(id),
  replaced_estimate_id        uuid NOT NULL REFERENCES job_estimates(id),
  replaced_service_order_id   uuid NOT NULL REFERENCES service_orders(id),
  member_id                   uuid,
  qb_customer_id              varchar(100) NOT NULL,
  qb_realm_id                 varchar(100) NOT NULL,
  retained_invoice_id         varchar(100) NOT NULL,
  retained_invoice_number     varchar(100),
  retained_sync_token         varchar(40) NOT NULL,
  retained_lines_fingerprint  varchar(64) NOT NULL,
  retained_total_cents        integer NOT NULL,
  retained_emailed            boolean NOT NULL DEFAULT false,
  replaced_invoice_id         varchar(100) NOT NULL,
  replaced_invoice_number     varchar(100),
  replaced_sync_token         varchar(40) NOT NULL,
  replaced_lines_fingerprint  varchar(64) NOT NULL,
  replaced_total_cents        integer NOT NULL,
  replaced_emailed            boolean NOT NULL DEFAULT false,
  replaced_prior_qb_status    varchar(20) NOT NULL,
  combined_total_cents        integer NOT NULL,
  emailed_acknowledged        boolean NOT NULL DEFAULT false,
  attention                   text,
  lease_owner                 varchar(80),
  lease_expires_at            timestamptz,
  started_by                  varchar(200),
  finished_by                 varchar(200),
  void_attempted_at           timestamptz,
  voided_at                   timestamptz,
  relinked_at                 timestamptz,
  completed_at                timestamptz,
  cancelled_at                timestamptz,
  separated_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ric_not_self CHECK (retained_estimate_id <> replaced_estimate_id),
  CONSTRAINT ric_status_valid CHECK (status IN ('prepared', 'voided', 'relinked', 'completed', 'cancelled', 'separated'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ric_request_uniq ON retail_invoice_consolidations (request_id);
CREATE UNIQUE INDEX IF NOT EXISTS ric_replaced_active_uniq ON retail_invoice_consolidations (replaced_estimate_id) WHERE status IN ('prepared', 'voided', 'relinked');
CREATE UNIQUE INDEX IF NOT EXISTS ric_retained_active_uniq ON retail_invoice_consolidations (retained_estimate_id) WHERE status IN ('prepared', 'voided', 'relinked');
CREATE UNIQUE INDEX IF NOT EXISTS ric_customer_active_uniq ON retail_invoice_consolidations (qb_realm_id, qb_customer_id) WHERE status IN ('prepared', 'voided', 'relinked');
CREATE INDEX IF NOT EXISTS ric_retained_order_idx ON retail_invoice_consolidations (retained_service_order_id);
CREATE INDEX IF NOT EXISTS ric_replaced_order_idx ON retail_invoice_consolidations (replaced_service_order_id);
