# Pitt Stop OS — Data Flows

> How the core records connect, plus the safeguards that keep money/identity correct. Pairs with
> `ARCHITECTURE_MAP.md` (where code lives). No source code here — read the cited files for detail.
>
> **Scope:** the production branch (`origin/main`) as of `c66a9dc`, 2026-11-13. Each flow is marked with what
> has been verified and what has not. "Verified in code" means the cited files exist and do this on that
> commit; it does not mean the flow was exercised against live QuickBooks or a live bank feed.

## Core flow: intake → customer → vehicle → work order → completion → invoice
1. **Intake (Quick Entry / Work Board "+ Check In").** `createQuickEntryJob` (`apps/quick-entry/jobs-db.ts`):
   - find-or-create the canonical **vehicle** (`findOrCreateVehicle`, de-dupe by VIN),
   - find-or-create the canonical **customer** (`findOrCreateIntakeCustomer`, `apps/directory/intake-customer.ts`) and link `customer_vehicles`,
   - create the **work order** (`createServiceOrder`) with `customer_id` set + `customer_name` for the card,
   - write a `quick_entry_jobs` row (contact text) + a draft `job_estimate`.
2. **Canonical customer.** Lives in `customers` (directory). Matching uses UNIQUE, non-placeholder
   normalized email → phone; never name alone. This is what the Customers page searches.
3. **Vehicle.** One canonical `vehicles` row; ownership via `customer_vehicles` (owner may differ
   from who authorized a given repair).
4. **Work order.** `service_orders` row; moves through statuses via `transitionOrder`; every change
   appends to `service_order_events` (append-only audit).
5. **Job completion.** Finish Job sets `completed_at`/status. Completion NEVER depends on QB/email/text
   succeeding; a later correction never changes the original `completed_at`/production date.
6. **Invoice (retail QB).** From the authoritative Invoice Draft → `createRetailQBInvoice`. Resolves
   the QB customer, enforces `TotalAmt == draft total`, idempotent (no duplicate invoices on retries).

## Customer reconciliation (historical)
- `apps/directory/reconcile.ts`: `planReconciliation` (READ-ONLY) sorts unlinked quick-entry orders →
  **linked** (unique contact match), **created** (new canonical customer), **ambiguous** / **unresolved**
  (left for manual review), plus owner-approved **exceptions**. `applyReconciliation` writes only the
  link/create/approved buckets. Idempotent: linked orders drop out; re-runs create nothing.
- **Approved exceptions** (`APPROVED_EXCEPTIONS`, by exact order #) override the general rules for ONLY
  those orders — general identity rules are never weakened. The three resolved cases: Bryan Brown
  (link to existing record by approved phone), Martha Cepeda (owner-approved name-only record), Caliber
  Collision (business account; advisor kept on the order only).
- The one-off runner script used for the 2026-10-08 reconciliation is not on the production branch; the
  logic and its tests (`apps/directory/reconcile.ts`, `reconcile.test.ts`) are.

## Third-party billing (occasional) — logic verified in code; live QuickBooks run UNVERIFIED
- Fields on `service_orders` (migration 0049, all NULL = ordinary job): `billing_customer_id`,
  `invoice_recipient_email`, `job_contact_name`. Set via `setOrderBilling` (`apps/workflow/order-billing.ts`)
  / route `app/api/workflow/orders/[id]/invoice/billing`, or the "Billing" modal on order detail.
- At invoice time, `chooseInvoiceParty` (`apps/quickbooks/invoice-party.ts`) + `invoiceParty`
  (retail-invoice-service.ts) bill the **payer by its own identity** and route `BillEmail` to the
  **recipient only** — never writing the recipient onto the payer's customer record.
- **Ownership/history never change**: `customer_id` / `customer_vehicles` stay with the vehicle owner.
- **UNVERIFIED end-to-end against live QuickBooks** — logic + schema are unit-verified; a real
  third-party job must be invoiced in the deployed app to confirm.

## Business customer contacts (e.g. Caliber Collision)
- Business = one `customers` row (`customer_type='business'`). Different employees/advisors bring
  vehicles; the advisor's name/email are stored **per work order** (`job_contact_name` /
  `invoice_recipient_email`), not on the company. The company's own email is never overwritten.
- Advisors are NOT created as customers; a shared business phone is NOT treated as unique identity
  (it stays ambiguous → never auto-links an unrelated person).

## QuickBooks invoice creation (retail) — live in production (`retail_qb_enabled` = true on 2026-11-13)
- `createRetailQBInvoice` resolves the customer (directory-cache → QB email → QB name → create),
  reconciles email (fills only a blank QB email; conflict → flagged, never overwrites), sets `BillEmail`
  (recipient override wins), writes one line per service (canonical `qb_description`, never AI-invented).
- Idempotency: local `qb_invoice_id` guard + compare-and-set `qb_status='creating'` + PSID adoption.
- **Never send real invoices/emails in testing without explicit approval.** Retail & dealer QB isolated.

## Customer service history
- `getCustomerHistory` (own) + `getVehicleServiceHistory` (vehicle) in `apps/directory/customer-profile.ts`.
- An order is attributed to a customer ONLY by: explicit `service_orders.customer_id`, a UNIQUE
  normalized phone/email match in `quick_entry_jobs`, or a vehicle they currently own — **never by
  name alone**. Placeholder contacts (e.g. `no@no.com`) and values shared by >1 customer are ignored,
  so one person's work never surfaces under another.

## Purchase → receipt → job cost → bank (2026-11-13)
One purchase is one `business_receipts` row; everything else points at it. Full rules: `docs/JOB_EXPENSES_2026-11-13.md`.

| Step | How it connects | State |
|---|---|---|
| Purchase → receipt | Captured once (photo / PDF / pasted text) as a `business_receipts` row. That row is the expense. | **Verified** in production for photos. PDF and pasted-text upload, storage and viewing are covered by tests and a local walkthrough; reading them with the model is **not verified**. |
| Receipt → customer job | Job screen → Expenses → "Add expense / receipt" files the receipt and adds an `expense_allocations` row for the whole purchase. Managers can link an already-filed receipt, split across jobs/overhead (never above the receipt total), move or remove (soft; audited on the receipt's `audit_log`). | **Verified** — tests, plus one production link (Tesla receipt → SO-20261113-0001, exactly $80.21, business totals unchanged). The signed-in production screens were not walked. |
| Receipt → sales-inventory vehicle | `business_receipts.inventory_vehicle_id` (unchanged). | Verified in code. Does **not** create an entry in the vehicle's own ledger (`vehicle_financial_events`); the two lists are separate. |
| Receipt → bank / card transaction | `fin_receipt_matches`: one receipt ↔ one transaction, confirmed by a person on the CFO page. Card payments, transfers, payroll, loan payments, owner draws and pending transactions cannot be matched. | Verified in code and tests. **No match has been confirmed in production yet** (0 rows on 2026-11-13). |
| Receipt → QuickBooks | None. `qb_sync_status` stays `export_ready`. | **Not connected.** Nothing is posted; QuickBooks purchases and bills are not read. |
| Expected bill → actual payment | `fin_obligations` are forecasts. The reconcile view pairs a bill with a bank payment by vendor name + amount each time it loads. | **Best-effort, not stored.** Safe-to-Spend does not use it. |

- Job total = allocations of filed/approved receipts. Part-line costs with no receipt tied to them are shown
  separately and never added (same purchase). No customer price, part line or invoice line is created.
- Business totals (receipt coverage, CFO) sum receipts only — allocations never change them.
- **Reading the bank feed:** the feed only shows transactions up to its last synced date. A purchase dated after
  that date is **not yet observable** — the feed cannot say whether it has posted. Treat it as unknown, not as
  "unposted", until the feed covers the date.

## Standing safeguards (see CLAUDE.md invariants)
- QuickBooks owns the money; `service_order_events` + ledgers are append-only (add correcting entries).
- "Remove" = soft cancel (`status='cancelled'`), never hard delete; linked QB invoice never voided.
- Reuse authoritative engines (one pricing engine, one Invoice Draft, one VIN decoder) — no parallels.
- Two Neon branches exist — verify target (`scripts/db-target.ts`) before any write; prod writes are
  fail-closed unless `DATABASE_ENV=development` or `ALLOW_PROD_DB_WRITES=1`.

## Service entry → catalog identity → invoice line (2026-10-16)
Raw entry (kept in `job_services.entry_text`) → interpretation (exact/alias/odor rule → one-tap; else AI/keyword candidates, user confirms) → `catalog_id` + `catalog_description` snapshot + `detail` → QB line = existing item (or Labor until mapped) + `canonical — detail`. Parts: `job_services.kind='part'` + `job_parts` (supply, fitment, labor review) → existing NonInventory "Part" item. Invoice create / estimate send wait for parts labor review, odor package overlap, and odor choice; drafts save; completion never gated.
