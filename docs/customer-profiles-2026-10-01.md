# Customer profiles and history

Employees and managers can open a customer from search or the home **Customers** tile and see one
screen with contact info, linked vehicles, open jobs, and a chronological history of repair orders,
estimates, and (manager-only) invoices — each linking to the existing job. From a vehicle, **Start new
repair order** carries the customer and vehicle forward into the normal Work Board flow.

## Where to find it

- Home → **Customers** tile (`/customers`) — search by name, phone, email, plate, or VIN. Reuses the
  existing global search (`/api/search`), filtered to the `customers` category.
- Global search (Cmd/Ctrl+K): a customer hit now opens its profile (`/customers/{id}`) instead of only
  offering tap-to-call. Vehicles and jobs remain navigable as before.
- `/customers/{id}` — the profile page.

## Identity reconciliation (no destructive merge)

The app holds several customer representations: the canonical directory `customers` (stable UUID,
imported/merged from AutoLeap + QuickBooks + Quick Entry), denormalized `service_orders.customer_name`,
and `quick_entry_jobs` contact strings. This feature does **not** merge or rewrite any of them.

The profile shows **two separate sections** so one person's financials are never attributed to another:

**1. Repair history — the customer's OWN transactions.** An order is "own" only when they authorized it:
- **linked** — `service_orders.customer_id = {customer}` (set going forward; see migration 0043), OR
- **contact** — a `quick_entry_jobs` phone/email that EXACTLY matches the customer's, AND that contact
  is **unique in the directory** (belongs to exactly one customer). A shared phone/email (families,
  shops, placeholders like `no@no.com`) and phones under 7 digits are ignored — never used to attribute
  work. Own rows carry amounts and invoices (manager-only).

**2. Service on this customer's vehicles.** Prior/other service on vehicles they *currently* own but did
**not** authorize (e.g. a previous owner's repairs on a car that was later sold to them). These are
shown as the vehicle's service record with amounts, invoices, and the other customer's name/contact
**stripped server-side for every role** — a previous owner's financial/contact data is never attached
to the new owner's profile.

A record is **never** attached by name alone. Current vehicle ownership alone places an order only in
the redacted vehicle-service section, never in the customer's own financial history. This is covered by
`apps/directory/customer-profile.test.ts`: name-only excluded, another customer excluded, a **vehicle
changing owners** (prior owner's amount/invoice/name never leak to the new owner, while the prior owner
keeps their own transaction), and **shared/placeholder contacts** attributing work to no one.

Going forward, **Start new repair order** writes `service_orders.customer_id`, so new work is linked by
stable id from the start. The action fails closed if the chosen vehicle is not linked to that customer,
and returns the existing active order for a vehicle instead of creating a duplicate.

## Search (name, phone, email, plate, VIN)

The `/customers` page uses a dedicated directory search (`searchCustomers` → `/api/customers/search`)
that matches customer name/phone/email **and joins `customer_vehicles → vehicles`** so a **plate or VIN
query returns the owning customer** (the global `customers` search category only looks at customer
fields and could not do this). Plate/VIN matching is formatting-insensitive; results flag when the hit
came from a vehicle. Covered by tests (`searchCustomers` by name, phone, plate, full/partial VIN).

## History completeness, pagination, permissions

- Both sections are paginated (`/api/customers/{id}/history?mode=own|vehicle&offset=&limit=`). Each shows
  "N of M records" and a **Load older records** control; `total` comes from the same matched set as the
  page, so older records are never silently dropped.
- Pricing/amounts and invoice references are **manager-only** (stripped server-side for employees via
  `redactHistoryForEmployee`), mirroring the existing invoice-draft gating. Contact, vehicles, services,
  dates, and statuses are visible to any authenticated employee.
- Both the pages and the APIs are under the existing employee session gate (`proxy.ts`), with
  defense-in-depth re-checks in each route handler.

## AutoLeap limitation (made explicit)

The AutoLeap Customer Report export (`data/imports/…customer-report-export…csv`, parsed by
`scripts/import-autoleap-customers.mjs` / `apps/directory/normalize.mjs`) contains **customers and
vehicle summaries only** — no repair orders, line items, or invoices. There is no AutoLeap export or
API in use that provides historical documents. The profile page states this directly: history shows
records created in Pitt Stop; older AutoLeap repair orders/invoices are not imported. No importer was
built against an invented schema.

## Release

1. Apply `drizzle/migrations/manual/0043_customer_links.sql` before deploying. It adds a nullable
   `service_orders.customer_id` (FK → `customers`, `ON DELETE SET NULL`) plus an index. It rewrites no
   existing rows; historical orders keep `customer_id = NULL` and are matched at read time. The FK is
   declared in SQL only (not in the Drizzle table) to avoid a circular schema import; the Drizzle
   column is a plain uuid. Safe to re-run (`IF NOT EXISTS` / guarded `ADD CONSTRAINT`).
2. Deploy via the existing Vercel process. No feature flag.

## Validation

- `apps/directory/customer-profile.test.ts` (8 tests, PGlite): profile load, safe matching
  (name-only excluded, foreign records excluded, match labels), amount/invoice surfacing, pagination
  total/`hasMore`, and employee redaction.
- TypeScript, lint (changed files), and the full existing suite pass (one pre-existing Quick Entry
  catalog test failure is unrelated — it belongs to in-progress service-bubble work).
- UI verified against fixtures in automated tests; live UI against the production database was **not**
  exercised because migration 0043 has not been applied there (no authorization to alter that schema).

## Not in scope

Marketing/comms, scheduling, and AutoLeap historical-document import (no export exists). Merging the
estimator's separate `retail_customers` into the directory was deliberately avoided (no destructive
consolidation).
