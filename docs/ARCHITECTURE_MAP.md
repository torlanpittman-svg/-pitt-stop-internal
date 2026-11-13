# Pitt Stop OS — Architecture Map

> First stop for "where does X live?". Per-module: primary files, key functions, API routes, DB
> tables, tests, cross-module links. Read only the section you need.
>
> **Scope:** describes the production branch (`origin/main`) as of commit `271ca84`, 2026-11-13. Every file
> path and function name below was checked against that commit, and feature-flag states were read from the
> production `app_settings` table the same day. Flags drift — re-check them before relying on a "live" or
> "off" statement. Work that exists only on local or unreleased branches is deliberately not described here.
> Domain logic lives in `apps/<module>/`; UI pages + API routes live in `app/`. Tables are aggregated
> by `drizzle/schema.ts` (a re-export of each module's `schema.ts`). See `DATA_FLOWS.md` for how
> modules connect, and `PROJECT_HANDOFF.md` for the authoritative deep architecture.

## Customers (directory)
- **Files:** `apps/directory/{schema.ts, customer-profile.ts, intake-customer.ts, reconcile.ts, normalize.mjs}`
- **Key fns:** `searchCustomers`, `getCustomerProfile`, `getCustomerHistory`, `getVehicleServiceHistory` (customer-profile.ts); `findOrCreateIntakeCustomer` (intake-customer.ts); `planReconciliation`, `applyReconciliation`, `APPROVED_EXCEPTIONS` (reconcile.ts)
- **Routes:** `app/customers/` (UI), `app/api/customers/search`, `app/api/customers/[id]/start-order`
- **Tables:** `customers`, `customer_vehicles`, `customer_import_batches`, `possible_matches`
- **Tests:** `apps/directory/*.test.ts` (customer-profile, intake-customer, reconcile, normalize)
- **Links:** read only by the Customers page; populated by AutoLeap/QB import, QB invoicing cache, and Quick Entry intake. Search/profile read the canonical `customers` table only (active rows).

## Work Board / Work Orders / lifecycle (workflow — THE core)
- **Files:** `apps/workflow/{schema.ts, db.ts, work-board-order.ts, fees.ts, invoice-draft.ts, estimate-db.ts, estimate.ts, identity.ts, order-billing.ts}`
- **Key fns:** `createServiceOrder`, `findOrCreateVehicle`, `getVehicleById`, `getOrderWithContext`, `transitionOrder`, `logEvent`, `findActiveOrderByVehicleId` (db.ts); `buildInvoiceDraft` (invoice-draft.ts); fee engine (fees.ts, `isDealerOrder`); `getActor` (identity.ts); `getOrderBilling`/`setOrderBilling` (order-billing.ts — third-party billing)
- **Routes:** `app/work-board/`, `app/orders/[id]/` (biggest UI file `OrderDetail.tsx` ~2k lines — read only the needed section), `app/api/workflow/orders/*`
- **Tables:** `service_orders` (customer_id, billing_customer_id, invoice_recipient_email, job_contact_name, customer_name), `vehicles`, `locations`, `job_estimates`, `job_services`, `job_line_items`, `service_order_events` (append-only)
- **Tests:** `apps/workflow/*.test.ts` (~14 files: fees, invoice-draft, estimate-pricing, identity, etc.)
- **Links:** vehicles reused by directory/quick-entry; estimates feed QuickBooks; `service_orders.customer_id` → `customers`.

## Quick Entry (retail intake)
- **Files:** `apps/quick-entry/{schema.ts, jobs-db.ts, db.ts, interpret.ts, interpret-ai.ts, service-history.ts, job-lines.ts}`
- **Key fns:** `createQuickEntryJob` (jobs-db.ts — creates order + `quick_entry_jobs` + canonical customer via `findOrCreateIntakeCustomer`), `getQuickEntryCatalog`, `searchRetailServices`; `getFullCatalog` (db.ts); NL intake `interpret`
- **Routes:** `app/quick-entry/` (QuickEntryFlow), `app/api/quick-entry/{jobs, customers, interpret}` (natural-language and voice intake are off in production: `qe_nl_enabled`, `qe_voice_enabled` = false on 2026-11-13)
- **Tables:** `quick_entry_jobs` (customer_name/phone/email as text), catalog tables
- **Tests:** `apps/quick-entry/*.test.ts` (catalog, customers, interpret, job-lines, service-history); `app/api/quick-entry/customers/route.test.ts`; `app/lib/customer-lookup.test.ts`
- **Customer lookup (shared):** returning-customer autocomplete used by both Quick Entry and the detailed Estimator (`app/estimator/page.tsx`) goes through one debounced/abortable controller `app/lib/customer-lookup.ts` + React hook `app/components/useCustomerLookup.ts`, hitting read-only `GET /api/quick-entry/customers?q=…` (returns up to 25 people with a `capped` flag; bounded, not an exhaustive scan).
- **Links:** writes canonical `customers` (going forward) + `service_orders`; Work Board card shows `service_orders.services`/`customer_name`.

## Vehicles
- **Files:** defined in `apps/workflow/schema.ts` (`vehicles` table, canonical); intake via `apps/vehicle-entry/` (dealer VIN capture UI) and `apps/dealer-checkin/`
- **Key fns:** `findOrCreateVehicle`, `getVehicleById` (apps/workflow/db.ts — de-dupes by VIN)
- **Routes:** `app/vehicle-entry/`, `app/dealer-check-in/`
- **Links:** one canonical `vehicles` table reused everywhere; owner link via `customer_vehicles`.

## QuickBooks (retail invoicing — money system of record)
- **Files:** `apps/quickbooks/{retail-customer.ts, retail-invoice-service.ts, invoice-party.ts, retail-invoice.ts, retail-invoice-write.ts, customers.ts, client.ts, schema.ts}`
- **Key fns:** `resolveRetailCustomer`/`resolveRetailCustomerIdentity`/`cacheToDirectory`/`decideCustomer` (retail-customer.ts); `createRetailQBInvoice`/`sendRetailQBInvoice`/`syncRetailQBInvoice`/`listRetailCustomerCandidates`/`setRetailCustomerChoice`/`invoiceParty` (retail-invoice-service.ts); `chooseInvoiceParty` (invoice-party.ts — billing customer vs service customer); `createRetailInvoiceInQB`/`sendRetailInvoiceInQB` (retail-invoice-write.ts); `queryQBO`/`qbApiRequest` (client.ts)
- **Routes:** `app/api/workflow/orders/[id]/invoice/{route, create-qb, send-qb, sync-qb, customer, billing, override}`
- **Tables:** `apps/quickbooks/schema.ts` (QB connection/tokens); invoice state on `job_estimates.qb_*`
- **Tests:** `apps/quickbooks/*.test.ts` (retail-customer, invoice-party, retail-invoice, customers, …)
- **Links:** reads Invoice Draft (workflow); writes directory cache (`customers.quickbooks_customer_id`). **Retail & dealer QB are isolated.** Prod QB only works in the deployed app (tokens AES-GCM encrypted; sandbox-only locally).

## Finance / CFO (read-only money view)
- **Files:** `apps/finance/{schema.ts, db.ts, cfo.ts, safe-to-spend.ts, transactions.ts, obligations-discovery.ts, qbo-sync.ts, ar.ts, receipts-cfo.ts, txn-class.ts, sync-health.ts}`; reconciliation: `apps/finance/{purchase-links.ts, purchase-match.ts, purchase-ledger.ts, reconcile-links.ts, qb-purchases.ts}`
- **Routes:** `app/admin/finance/` (CFO page, ADMIN_PASSWORD), `app/admin/finance/reconcile` (review queues), `app/api/cron/finance-sync` (daily 09:00 UTC, see `vercel.json`)
- **Tables:** `fin_transactions`, `fin_accounts`, `fin_plaid_items`, `fin_plaid_accounts`, `fin_balance_snapshots`, `fin_obligations`, `fin_expected_inflows`, `fin_ar_invoices`, `fin_debts`, `fin_receipt_matches`, `fin_sync_runs`, `fin_events`, `purchase_links` and `fin_qb_purchases` (migration 0079). Note: `apps/finance/schema.ts` is **not** re-exported by `drizzle/schema.ts`.
- **Links:** read-only over QuickBooks + bank data; never feeds pricing/invoicing. Never decrypt Plaid tokens locally.
- **What is actually connected (traced in code 2026-11-13):**

  | Connection | State |
  |---|---|
  | Plaid → `fin_transactions` / balances (cron + "Sync now") | **Working** — production rows present, last sync run `ok` on 2026-11-13 |
  | QuickBooks → P&L / balance sheet / A/R totals, accounts, open invoices | **Working, read-only** (`qbo-sync.ts`, `ar.ts`) |
  | Receipt ↔ bank transaction (`fin_receipt_matches`) | **Manual, persisted** — a person confirms on the CFO page; 0 confirmed rows in production on 2026-11-13 |
  | Receipt ↔ QuickBooks entry, receipt ↔ vehicle cost line, check ↔ bank payment, check ↔ receipt, bank payment ↔ QuickBooks entry (`purchase_links`) | **Manual, persisted** — suggested on `/admin/finance/reconcile`, saved only when a person confirms; undo keeps history; audited in `fin_events`. 0 rows in production at release |
  | Purchases "counted once" across receipts, bank, checks, QuickBooks, vehicle ledger | **Working as a view** on `/admin/finance/reconcile` — merges only confirmed matches (+ a check and the QuickBooks entry it created). Unmatched duplicates still count twice and the page says so. No other report consumes it |
  | Receipt ↔ customer job (`expense_allocations`) | **Working** (see Expenses below) |
  | Expected bill (`fin_obligations`) ↔ the payment that paid it | **Manual, persisted** (`purchase_links` kind `bill_payment`); suggested by vendor name + amount. Forecast and paid totals are shown side by side, never added. **Safe-to-Spend does not read it** |
  | QuickBooks expense records (Purchase / Bill) | **Read-only mirror** (`fin_qb_purchases`, last 120 days, filled by the daily QuickBooks sync from the production company). **Empty until the first sync after release** — verify rows exist before relying on it. Receipts are never posted; only Write-a-Check creates a QuickBooks Purchase |
  | Sales-inventory vehicle ledger ↔ bank (`vehicle_financial_events.fin_transaction_id`) | **Not wired** — column exists, nothing writes it |
  | Sales-inventory vehicle ledger ↔ `business_receipts` | **Manual, persisted** match for the same purchase; each list keeps its own totals — only the counted-once view deduplicates |
  | `checks` ↔ bank / receipts / QuickBooks | Check ↔ its own QuickBooks entry: **by id** (`qbo_txn_id`). Check ↔ bank payment and check ↔ receipt: **manual, persisted** |

## Auto Sales (used-car inventory + per-vehicle ledger)
- **Files:** `apps/auto-sales/{schema.ts, calc.ts, report.ts, db.ts}`
- **Routes:** `app/auto-sales/` (employee), admin report; manager-gated (separate from ADMIN_PASSWORD)
- **Links:** ONE append-only per-vehicle financial ledger; no QBO mutation. Integer-cents canonical calc.

## Marketing
- **Files:** `apps/marketing/{schema.ts, db.ts, report.ts, leads.ts, optin.ts, attribution*, …}`
- **Routes:** `app/marketing/`, `app/sms-opt-in`, `app/unsubscribe/[token]`, `app/api/twilio/*`
- **State (production flags, 2026-11-13):** `marketing_enabled` = true; `marketing_sms_live`, `marketing_email_live`, `marketing_facebook_live` and `marketing_autopilot_enabled` = false. A send with no live provider is reported as `dry_run`, never `sent` (`apps/marketing/providers/index.ts`). No SMS provider is operating.
- **Links:** reads canonical customers/orders/photos; no QB writes.

## Authentication / identity / roles
- **Files:** `apps/auth/{employee-guard.ts, employee-session.ts}`; actor resolution `apps/workflow/identity.ts` (`getActor`); middleware `proxy.ts`
- **Key fns:** `authenticatedActorFromRequest` (employee-guard.ts) — used by API routes; signed `ps_emp` cookie is source of truth
- **Roles:** `employees.role` ∈ `employee | manager | admin`. Managers are individual PINs (env `PIN_*`). `/admin` is password-only (ADMIN_PASSWORD).

## Database & migrations
- **Files:** `platform/db.ts` (`getDb` — wraps `guardNeonClient`), `platform/prod-db-guard.ts` (fail-closed write guard: blocks local prod writes unless `DATABASE_ENV=development` or `ALLOW_PROD_DB_WRITES=1`; inert on Vercel), `drizzle/schema.ts` (re-export aggregator), `drizzle/migrations/manual/NNNN_*.sql` (numbered, latest 0078)
- **Tools:** `scripts/db-target.ts` (verify effective branch — prod `ep-morning-base-adq5h6rq` vs dev). `scripts/` is excluded from Vercel builds (`.vercelignore`)
- **Roles:** the app connects only through `APP_DATABASE_URL` as `pitt_stop_app` (DML, no DDL). Migrations are applied by hand as the owner role; nothing in the build or deploy runs them (`docs/DB_CREDENTIAL_ROTATION_COMPLETED_2026-11-03.md`).
- **Safety:** TWO Neon branches exist; always verify target before writes. Migrations applied deliberately.
- **Previews fail closed:** `platform/preview-guard.ts` refuses database access on a Vercel preview unless the database is positively non-production, and file storage unless an isolated store is declared. `GET /api/health` reports the environment with no setting values. Documentation-only changes skip the Vercel build (`vercel-ignore-build.sh`). See `docs/PREVIEW_SAFETY.md`.

## Other modules (brief)
- **Estimates / Estimator:** `apps/estimates/`, `apps/estimator/` → `app/estimates/`, `app/estimator/`
- **Parts:** `apps/parts/` (`job_parts`, screenshot import tables) → parts section on `app/orders/[id]`
- **Order photos:** `apps/order-photos/` → `app/orders/[id]/photos/` (before/after)
- **Search:** `apps/search/service.ts` → `app/api/search` (global command palette, role-scoped)
- **Checks:** `apps/checks/` → `app/checks/` (physical check printing; writes a QuickBooks Purchase). Production flags 2026-11-13: `checks_enabled`, `checks_live_enabled`, `micr_enabled` = true. See `docs/CHECK_PRINTING_STATUS.md`.
- **Appointments / booking:** `apps/appointments/` → `app/appointments/`, `app/book/`, `app/api/appointments/`; daily notification cron. See `docs/APPOINTMENTS.md`.
- **Staff alerts (booking push):** `apps/staff-alerts/`. See `docs/BOOKING_ALERTS.md`.
- **Oil-change stickers:** `apps/stickers/` → sticker sheet on `app/orders/[id]` + `app/api/workflow/orders/[id]/oil-sticker`, printed through the shared print-bridge queue. Code is on `origin/main`; physical printing is not confirmed here. See `docs/OIL_STICKER_SETUP.md`.
- **Expenses / receipts / job costs:** `apps/expenses/` — **one purchase = one `business_receipts` row** (the expense source of truth).
  - Capture + review: `ui/CaptureExpense.tsx`, `ui/ReviewCard.tsx`, `actions.ts`, `db.ts`; routes `app/expenses/`, `app/api/expenses/receipt/*` (photo, PDF, pasted text).
  - **Job expenses (2026-11-13, migration 0078):** `expense_allocations` links a receipt — whole or split — to a job or overhead. Pure rules `allocations.ts`; DB `job-expenses.ts`; actions `job-actions.ts`; job-screen UI `app/orders/[id]/JobExpenses.tsx`; picker `ui/JobPicker.tsx`. An allocation is a pointer, never a second expense — no business total reads it.
  - Checks/warnings: `checks.ts` (questionable date, amounts, duplicate evidence).
  - **Reconcile view:** `reconcile.ts` + `ui/ReconcileView.tsx` → `/expenses/reconcile` (manager) and `/admin/finance/reconcile` (owner; adds bank + expected-bill queues). Read-only.
  - Bank match stays in `apps/finance/receipts-cfo.ts` (`fin_receipt_matches`, human-confirmed); `apps/finance/txn-class.ts` keeps card payments / transfers / payroll / loan payments out of receipt matching.
  - Tests: `apps/expenses/*.test.ts` (incl. `job-expenses.integration.test.ts`). Full write-up: `docs/JOB_EXPENSES_2026-11-13.md`.
  - **Reading verified live 2026-11-13** with fictional PDF, photo and pasted-text documents (vendor, date, subtotal, shipping, tax, total, invoice/order number all correct; an unknown card was not guessed). Managers can re-check any stored receipt with “Check the reading” (`checkReadingAction`), which saves nothing.
- **Settings / flags:** `apps/settings/` → `app_settings` table (flag *values* drift — verify live)

## Change notes (historical — each is on `origin/main`)
- **Customer DB fix — DEPLOYED prod commit `16a2f33`, migration `0049_third_party_billing.sql` applied (2026-10-08).** Work Board customers now get canonical profiles; historical Quick Entry records reconciled (81 orders linked, 28 customers created, 0 remaining/orphans); third-party billing added (billing customer may differ from vehicle owner; invoice recipient stored per work order). **Live third-party QuickBooks invoicing remains UNVERIFIED** (needs a real third-party job in the deployed app). See `DATA_FLOWS.md` for the mechanics.

## Service matching, parts labor review, Manage services (deployed 2026-10-16, origin/main 8a34539)
Detail: `docs/service-matching-parts-labor-2026-10-16.md`.
- Interpretation: `apps/quick-entry/service-interpret.ts` (pure) + `service-interpret-ai.ts` (GPT-4o, `OPENAI_API_KEY`) + `service-match-db.ts`; estimate route actions `interpret`, `catalog_list`, `add_service` (catalogId/custom/detail), `select_match`, `set_detail`, `add_part`, `update_part`, `remove_part`, `part_labor`, `add_tires`.
- Parts on estimates + labor review: `apps/parts/estimate-parts.ts`, `labor-review.ts`; gates: `apps/workflow/estimate-review.ts` / `estimate-readiness.ts`.
- Manage services: `/quick-entry/services`, `/api/quick-entry/services`, `apps/quick-entry/shortcuts.ts`. Tables: `service_shortcuts`, `service_catalog_events`; new columns on job_services / job_parts / service_catalog (migration 0052).
