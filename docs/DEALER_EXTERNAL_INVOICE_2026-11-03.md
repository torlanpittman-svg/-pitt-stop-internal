# Externally managed dealer invoices — Sterling Kia #100937 (2026-11-03)

## What happened
The owner created QuickBooks invoice **#100937** (QB Id 24596, customer Sterling Kia / QB 67) by hand for
three vehicles that were never checked in through Dealer Check-In:

| Stock (VIN suffix) | Vehicle | QB line | Amount |
|---|---|---|---|
| TG481851 | 2026 Kia Sorento Panthera | 1 | $200 |
| VG040718 | 2027 Kia Telluride Terrain | 2 | $200 |
| T5472699 | 2026 Kia K5 White | 3 | $200 |

The regular open Sterling Kia invoice is **#100931** (QB Id 24579). The three vehicles needed Work Board
jobs linked to #100937 without ever being billed again and without #100937 becoming the invoice that
future Kia check-ins append to (it is newer than #100931, open and unsent, so the normal
"most recent open, unsent" rule would have picked it).

## The protection (code)
`dealer_scans.qb_invoice_external` (migration `0069_dealer_scan_external_invoice.sql`, boolean,
default false) marks a scan whose invoice was created by hand in QuickBooks. Nothing in the normal
check-in flow sets it; it is only set by a deliberate, owner-approved data operation. When true:

- **Never an append target** — `findAppendableInvoice` (`apps/quickbooks/invoices.ts`) drops every
  invoice number that appears on an external scan (`listExternalInvoiceNumbers` +
  `excludeExternalInvoices`) before the unchanged `selectAppendableInvoice` rule runs. This covers
  check-in preview, check-in, the queued-scan retry cron and attach. The regular invoice stays
  eligible exactly as before; once it is sent or paid the next check-in creates a fresh invoice as
  usual (nothing is pinned).
- **Remove = soft cancel only** — `decideQbRemovalPlan` returns `external_invoice` before any
  QuickBooks read; `order-removal.ts` skips the snapshot, logs `qb_external_invoice_untouched` on the
  Job, and soft-cancels. The Work Board preview says the invoice will not be changed.
- **Vehicle correction never rewrites the line** — `qbSyncDecision` returns `not_linked`.
- **Attach / retry write nothing** — attach returns `already_linked`; the retry cron only drains
  `qb_sync_status = 'queued'` scans and these are `synced`.
- Duplicate protection is unchanged: a re-scan of the same stock number within 7 days is rejected,
  and attach recovery finds the `#STOCK` line on #100937 and links instead of charging.

## The data operation
Scratchpad script (run from the deployed-commit worktree, `ALLOW_PROD_DB_WRITES=1`, `--apply`):
one `vehicles` row (no VIN), one `service_orders` row (source dealer, type dealer_detail, status
arrived, title "Sterling Kia", notes `Stock: X | Invoice: 100937 | Sterling Kia`), one `dealer_scans`
row (approved, synced, invoice 100937, rate 200, stock_source manual_attach, qb_line_id null,
**qb_invoice_external true**) and append-only events (`checked_in`, `work_board_created`,
`invoice_attached`) per vehicle. No QuickBooks call is made. Neither invoice is modified or sent.

Note: QB line 3 on #100937 reads "Kiaa K5" (typo in QuickBooks). Left as-is; the app records "Kia".
