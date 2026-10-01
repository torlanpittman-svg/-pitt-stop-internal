# Parts purchasing and tracking

Every repair order has a **Parts** section (`app/orders/{id}/PartsSection.tsx`) for tracking the parts a
job needs: description, part number, supplier, quantity, manager-only cost/sell price, supplier
order/confirmation number, expected arrival, received quantities, and returns/core credits. It works
with **any** supplier — NAPA, O'Reilly, AutoZone, or a dealer counter order placed by phone or website.
The Work Board shows a **WAITING ON PARTS** badge on jobs with outstanding parts, without changing the
job's existing workflow status.

## Data model

New table `job_parts` (migration 0044, `apps/parts/schema.ts`), one row per tracked part on a
`service_orders` row. It is deliberately **separate** from `job_line_items` (the estimate/invoice lines)
so that:

- A saved part never looks "ordered" until a real order is recorded.
- Procurement cost tracking never double-counts against the invoice. An optional `job_line_item_id`
  links a tracked part back to its billing line for reference; billing stays authoritative in the
  estimate/QuickBooks path, which this feature does not touch.

Status lifecycle: `needed → ordered → partially_received → received`, with `cancelled` terminal.

## Status & quantity integrity

All transitions live in pure, unit-tested logic (`apps/parts/status.ts`, `apps/parts/status.test.ts`):

- **A part is added as `needed`.** Saving a part never implies it was ordered.
- **`ordered` requires evidence.** `markOrdered` fails closed unless a supplier *or* a supplier
  order/confirmation number is recorded (`canMarkOrdered`). This is what keeps "saved" from reading as
  "ordered".
- **Receiving** clamps to `[0, quantity]` and derives `partially_received` vs `received`. Partial
  deliveries and multiple suppliers are supported (each part line tracks its own supplier/order/arrival).
- **`cancelled` is terminal** — receiving/returning never resurrect it, and cancelled parts never count
  toward the waiting indicator.
- **Returns & core credits** accumulate on the line (`returnedQuantity`, `returnCreditCents`,
  `isCore`, `coreCreditCents`); credit amounts are manager-only.

## Work Board indicator (additive)

`listActiveOrders` computes `partsWaiting` per order from `ordersWithWaitingParts` (any part in
`needed | ordered | partially_received`). `VehicleCard` renders an amber **WAITING ON PARTS** chip
alongside the existing URGENT/RETAIL/DEALER badges. This is purely a signal — it does not change
status, sort order, pricing, production, or QuickBooks.

## Parts → billing (explicit, no missing or duplicate charge)

A tracked part does not bill automatically. A manager uses the explicit **Add to invoice** action
(`action: 'bill'`) on a part, which:

- Reuses the authoritative estimate path — `getOrCreateEstimate` → a single shared **Parts** service →
  `addLine(type:'part', priceCents=sell, costCents=cost, taxCategory:'repair_parts')` →
  `recomputeEstimate` — so pricing/fees/tax and QuickBooks stay authoritative. No raw inserts.
- **Requires a sell price** (manager-only) — it refuses to create a $0 line, so a tracked part is never
  silently billed at nothing (no missing charge).
- **Links** `job_parts.job_line_item_id` to the created line and is **idempotent**: billing an
  already-linked part creates no second line (no duplicate charge).
- If the order already has a QuickBooks invoice, it is flagged **sync-needed** so the new line isn't
  missed on an invoice that was already created.

The Parts list shows each part's billing state (**On invoice** / **Not billed**) so unbilled parts are
visible (no silently-missing charge). `billed` reflects a **live** line only — if the estimate line is
later deleted, the part reads unbilled again and can be re-billed. Procurement cost (`unit_cost_cents`)
is tracking-only and never feeds the invoice or CFO totals; billing cost/price live solely on the
estimate line, so costs are never double-counted. Covered by `apps/parts/db.test.ts` (sell-price guard,
single line, idempotency, stale-line re-bill).

Outstanding returns/core credits stay visible after a part is received: a `creditOutstanding` flag
(e.g. "Core deposit outstanding") persists on the card until the credit is recorded — tested to remain
true through `received` and clear once the core credit is entered.

## Permissions

- The parts API (`/api/workflow/orders/{id}/parts`, GET + action POST) is under the employee session
  gate with in-handler re-checks.
- Cost, sell price, return credit, and core credit are **manager-only**: stripped from GET responses
  and ignored on write for non-managers (mirrors invoice-draft gating). Employees can still add parts,
  mark them ordered, receive, and record a return quantity.
- Cross-order edits are rejected: a part referenced in a POST must belong to the route's order.

## Preserved behavior

No change to estimates, invoices, `job_line_items`, or QuickBooks. Parts tracking is a parallel
procurement record; it never writes to the billing path or places real supplier orders.

## Release

1. Apply `drizzle/migrations/manual/0044_job_parts.sql` before deploying (`CREATE TABLE IF NOT
   EXISTS job_parts` + two indexes; additive, safe to re-run). It references `service_orders` and
   `job_line_items`, both of which already exist.
2. Deploy via the existing Vercel process. No feature flag.

## Validation

- `apps/parts/status.test.ts` (pure) + `apps/parts/db.test.ts` (PGlite): add-as-needed,
  order-requires-evidence, partial→full receiving, cancel terminal, returns/core credits, and the
  Work Board waiting set. All pass.
- TypeScript + lint (changed files) clean. Live UI against the production database was **not**
  exercised because migration 0044 has not been applied there (no authorization to alter that schema).

## PartsTech & direct ordering — investigation

Per the owner's direction, the manual workflow above works with all current suppliers today. Direct
API ordering is a separate track. Summary of findings (full detail below, gathered from current
official documentation):

The manual workflow does not depend on any of this. Direct ordering is blocked only pending
credentials / partner approval / commercial access, which is called out explicitly so nothing here
is simulated.

### Supplier integration findings (current official docs, Oct 2026)

**PartsTech (recommended primary path).** PartsTech runs an official Parts Ordering API / SMS partner
program built for third-party shop-management systems; it aggregates ~20,000 suppliers (incl. NAPA,
O'Reilly, AutoZone, and many local/dealer counters) behind one search. Critical distinction the owner
asked about:

- A **shop account** lets the shop order through PartsTech's own UI. It does **not** grant API access.
- Integrating our custom app requires **developer/partner onboarding** — PartsTech approves us as an
  integration partner and issues credentials; the shop then connects by entering a PartsTech
  username + API key in our app. So two prerequisites: (a) PartsTech partner approval, and (b) a shop
  PartsTech account whose credentials we use. Treat API access as approval-gated, not self-serve.
- Capability model (per secondary/official sources; confirm against the real partner docs): username +
  API key auth; parts/tire search by keyword/VIN/plate; a punchout cart that returns a Quote **or** an
  Order; webhooks (`SUBMIT_QUOTE`, `PURCHASE`) to a partner-hosted callback. Orders can genuinely be
  placed (not quote-only). The exact auth, endpoints, and whether headless (non-punchout) ordering is
  allowed are **behind partner onboarding and were not invented here** — confirm directly with
  PartsTech before building the automated flow. Start at https://www.partstech.com/ (Integrations).

**Supplier-direct.** None of these offer a realistic self-serve ordering API for a small shop's custom
app:
- **NAPA PROLink** — a NAPA-approved SMS integration for search+ordering, not an open public API. Reach
  NAPA via an approved integration or via PartsTech. (napatracs.com/extensions/prolink-estimator)
- **O'Reilly First Call / Pro** — commercial web portal; no public ordering API documented.
- **AutoZone Pro / Commercial** — electronic ordering + e-catalog for commercial accounts via partner
  arrangement; no public self-serve API. (autozonepro.com)

**Dealer / OEM parts.** Online options exist but are **per-dealer and must be verified for each dealer**
— they are not a single integration. RevolutionParts and SimplePart power dealer-side OEM e-commerce
storefronts (buy through a participating dealer's web store, not a buyer-side API); PartsTrader is a
large but collision-focused procurement marketplace. Replacing phone orders is realistic only
dealer-by-dealer where that dealer runs an online store.

**Bottom line / recommended sequence.** (1) Manual parts entry — shipped now, covers all four sources
today with zero external credentials, dealer orders logged after the call. (2) Apply to the PartsTech
partner program; confirm real API auth/order capabilities before designing automation. (3) Keep dealer
parts as a manual/phone (or per-dealer portal) workflow, logged in the app. Blocked-pending-access:
PartsTech API (partner approval + key + shop account); NAPA/O'Reilly/AutoZone direct (approved/
commercial partner, no self-serve); dealer OEM online (per-dealer, mostly manual).

## Not in scope

Advanced inventory automation, stock-on-hand, and a separate technician app.
