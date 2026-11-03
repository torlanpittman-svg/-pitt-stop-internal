# Guided Services + Parts on the Job screen — 2026-11-03 (local, NOT deployed)

Branch `feat/parts-guided-flow` (worktree `.ps-worktrees/parts-guided`, off production `origin/main` 8ccaa1b).
No migration. No new flag. No production data touched. Nothing sent.

## What an employee / manager now sees on a retail Job (estimate layer on)

```
SERVICES                                   + Add Service
┌──────────────────────────────────────────────────────┐
│ Oil Change                                   $60.00  │
│  │ Oil filter                    $25.00      Remove  │   ← attached part (price × qty)
│  + Add part to this service          Remove service  │
├──────────────────────────────────────────────────────┤
│ Brake Job                                   $200.00  │
│  │ Brake pads                    $45.00      Remove  │
│  │ Rotors                       $180.00      Remove  │
│  + Add part to this service          Remove service  │
└──────────────────────────────────────────────────────┘
PARTS · 4
[            + Add a part            ]
┌──────────────────────────────────────────────────────┐
│ Wiper blades                      $24.00     Remove  │   ← standalone part
└──────────────────────────────────────────────────────┘
Add from a PartsTech screenshot ›                           ← collapsed, secondary
```

- **Add part** opens a form right under the tapped action, focused on **What part?**. *More details* (collapsed):
  Our cost · each (**manager/admin only**), Customer price · each (**everyone — required**), Part number, Quantity
  (default 1). Submit = **Add part to service** / **Add to this job**. A brief “✓ … added to …” notice appears where it
  happened, the new row is highlighted and scrolled into view.
- **Customer price is required (owner decision 2026-11-03).** Whoever adds the part types the customer price so a
  manager never has to price it afterwards. A blank is never treated as $0: on submit the form opens *More details*,
  focuses **Customer price · each** and says *“Enter the customer price · each (use 0 for no charge).”* A negative or
  non-numeric amount is refused the same way. The server (`addPartForJob`) re-validates every add for every role —
  missing, negative or invalid → 400 with the message, nothing written. An explicit **0** is a priced no-charge line.
- **Part rows** show only name · customer amount · Remove. No ordered/received/waiting/“charged” labels anywhere
  (the Work Board WAITING ON PARTS chip and “· N waiting” are gone too). Historical `job_parts` status data is untouched.
- **Remove part** asks once (“Remove ‘Oil filter’ from ‘Oil Change’ and the job total?”), removes only that part + its
  charge; the service and unrelated parts stay; a brief “✓ … removed.” notice follows.
- **Who may remove a part (owner decision 2026-11-03):** an employee may remove any part — attached or standalone,
  priced or not, including one they just added — **until the Job has a QuickBooks invoice**. From then on (including
  parts added after invoicing) Remove shows *“This job has a QuickBooks invoice. Ask a manager to remove this part.”*
  and the server refuses with the same message. “Has a QuickBooks invoice” comes ONLY from the persisted linkage on
  `job_estimates` (`qb_invoice_id`, or a `qb_status` other than `none`/`error`: creating, syncing, created, sent,
  consolidating, linked) — never from a price, an Invoice Draft line, or whether the invoice was emailed. Managers/admins
  remove as before (the linked invoice is only flagged “sync needed”, never voided).
- **Remove service** (manager/admin) asks once and names what goes with it (“… and its 2 attached parts (‘Brake pads’,
  ‘Rotors’)? All of their prices will be removed from the job total.”). An employee sees *“A manager is needed to
  remove a service from this job.”*
- Dealer Jobs and the estimate-off case keep the previous plain Services list + parts tracker (dealer QB isolation).

## How it maps onto the existing model (no parallel systems)

| Concept | Existing record / path |
|---|---|
| Attached part | `job_parts.labor_service_id = service` + `labor_status='included'` (via `decidePartLabor`) |
| Part charge | the estimate’s own `job_services(kind='part')` row + `job_line_items` line (`addEstimatePart`) — `lineAmountCents(price, qty)` once |
| View | `getEstimateView` — same numbers as the Invoice page / Invoice Draft; non-managers get `unitCostCents` stripped |
| Add | `POST /parts {action:'add', laborServiceId?}` → `addPartForJob` (validates the service BEFORE any write) |
| Remove part | `POST /parts {action:'remove'}` (the legacy `cancel` action is the same case) → `removeEstimatePartWithLabor(…,{action:'keep'}, {requireNotInvoiced: true}` for non-managers) (line + record, audited, QB only flagged) |
| Invoiced? | `estimateHasQbInvoice(est)` / `jobHasQbInvoice(orderId)` (estimate-db / estimate-parts) over `job_estimates.qb_invoice_id` + `qb_status`; `GET /items` returns it as `view.qbInvoiced` so the Job screen can show the rule on tap |
| Atomic guard | `removeEstimateService(…, {requireNotInvoiced})`: a `guard` CTE `UPDATE job_estimates … WHERE qb_invoice_id IS NULL AND qb_status IN ('none','error')` in the SAME statement that deletes the part’s line — it takes the estimate row lock and re-evaluates against the committed row, so it is ordered strictly before/after the invoice Create’s compare-and-set (`qb_status → 'creating'`) on that row. Lost guard → `EstimateInvoicedError` (route → 403 `needsManager`). Parts with no estimate line use the same condition inside their `UPDATE job_parts`. |
| Create re-read | `createRetailQBInvoice` now re-reads the estimate **under its lock** and, if `estimateFingerprint()` differs from the pre-lock read, releases the lock (`qb_status` back) and refuses *“The estimate changed while the invoice was being created — review the Invoice Draft and try again.”* **before any QuickBooks write**. Closes a pre-existing window (any edit committing between Create’s read and its lock was invoiced from the stale read, with no sync flag). |
| Remove service | `POST /estimate {action:'remove_service_with_parts'}` → `removeServiceWithParts` (each attached part via `removeEstimatePart`, then `removeEstimateService`; audit `service_removed_with_parts`) |
| Customer price | typed by whoever adds the part; `addPartForJob` requires it (explicit, ≥ 0, whole cents) and forces `supply='shop'` so `addEstimatePart` creates the priced line once — `lineAmountCents(price, qty)` is what the total and Invoice Draft bill |
| Our cost | `addPartForJob` keeps `unitCostCents` only when `role` is manager/admin (the route also strips it for non-managers); it lands in `job_line_items.cost_cents` and never in the customer charge; `/items` strips it from the view for non-managers |
| Existing unpriced parts | any part that is still unpriced (older data, other entry paths) keeps blocking QB invoice creation via Invoice Draft `pricingIncomplete` until a manager prices it (Edit-part sheet) or removes it — unchanged safeguard |
| Removal after an employee add | allowed (confirm → gone) while the Job has no QuickBooks invoice — see “Who may remove a part” above |

## Files

- `apps/parts/estimate-parts.ts` — `attachedPartsOf`, `partIsCharged`, `addPartForJob`, `removeServiceWithParts`, `jobHasQbInvoice`, `PartRemovalOptions` (guard threaded through `removeEstimatePart` / `removeEstimatePartWithLabor`)
- `apps/workflow/estimate-db.ts` — `UNINVOICED_QB_STATUSES`, `estimateHasQbInvoice`, `EstimateInvoicedError`, `removeEstimateService(…, RemoveServiceOptions)` with the guard CTE
- `apps/quickbooks/retail-invoice-service.ts` — `estimateFingerprint` + the post-lock re-read/refuse in `createRetailQBInvoice`
- `apps/parts/job-items-view.ts` (new, pure) — grouping, non-manager redaction, confirmation copy, manager-needed messages, `validatePartDraft` (the form's required-price rule)
- `app/api/workflow/orders/[id]/items/route.ts` (new GET, any shop session) — the Job-screen view
- `app/api/workflow/orders/[id]/parts/route.ts` — `add` → estimate path on retail Jobs; `remove`/`cancel` → the one invoiced-Job rule (pre-check 403 + guarded removal; guard loss → 403)
- `app/api/workflow/orders/[id]/items/route.ts` — adds `view.qbInvoiced`; `app/orders/[id]/estimate/save-feedback.ts` — the field’s type
- `app/api/workflow/orders/[id]/estimate/route.ts` — `remove_service_with_parts`; `app/orders/[id]/estimate/save-feedback.ts` — its labels/confirmation
- `app/orders/[id]/JobItemsPanel.tsx` (new UI), `app/orders/[id]/JobItems.tsx` (hook: `/items`, `canEdit`, `removeServiceWithParts`), `app/orders/[id]/OrderDetail.tsx` (wiring)
- `app/work-board/VehicleCard.tsx`, `app/work-board/WorkBoardClient.tsx` — waiting badge removed
- Tests: `apps/parts/job-items-view.test.ts` (grouping, redaction, copy, draft validation), `apps/parts/remove-service-with-parts.test.ts` (PGlite: employee priced adds attached + standalone, price × qty once, cost never charged / never stored for employees, missing/negative/invalid price refused before any write, explicit $0, existing-unpriced safeguard, removal/audit/QB-flag/retry), `app/api/workflow/orders/[id]/parts/route.test.ts` (price forwarded for every role, cost manager-only, service rejection → 400, invoiced-Job rule incl. the legacy `cancel` action and the atomic-guard 403), `apps/quickbooks/retail-invoice-create-race.test.ts` (PGlite + QB mocked at HTTP: removal committing between Create’s read and its lock → Create refuses before any QB write and releases the lock, retry invoices the current estimate; removal after Create claimed the row → refused by the guard, invoice bills the part)

## Verification (2026-11-03, after the required-price + invoiced-Job removal changes)

- `npx tsc --noEmit`: clean (the only errors are pre-existing in the untouched `apps/estimates/quickbooks.test.ts`).
- ESLint on every changed file: 0 findings (OrderDetail’s existing react-hooks errors are identical on origin/main).
- Targeted: `npx vitest run apps/parts "app/api/workflow/orders/[id]/parts" apps/quickbooks/retail-invoice-create-race.test.ts apps/quickbooks/retail-flat-price.test.ts apps/quickbooks/retail-invoice.test.ts apps/quickbooks/shared-invoice.test.ts apps/quickbooks/invoice-consolidation.test.ts apps/workflow` → 45 files / 605 tests pass.
- Full suite `npm test`: see the chat report for the run after this change (money/invoice change → full suite required).
- `next build --webpack`: passes.
- 390 px headless walkthrough (real page + components, data layer stubbed by route interception, no DB writes):
  33/33 checks — employee: removes their own just-added priced part and a standalone priced part before invoicing
  (confirm → gone, service stays, “✓ … removed.”); with the Job invoiced (fixture `qbInvoiced`) Remove on any part,
  including one added after invoicing, shows the exact manager message and removes nothing; no billing/status labels;
  blank price → More details expands, Customer price focused, message shown, nothing sent;
  negative price refused in place; 12.50 × 2 sends `sellPriceCents=1250`, qty 2, no cost, row shows $25.00; the
  employee’s own (now charged) part → manager message; a legacy unpriced part still removable; manager: More-details
  order Our cost → Customer price → Part number → Quantity, price 18 + cost 7 sent, cost never on the row; plus the
  earlier placement/focus/removal/forbidden-label/no-horizontal-scroll checks. Screenshots: scratchpad `shots-guided/`.

## Decisions for the owner (see the chat report)

- **Decided 2026-11-03:** employees enter the customer price when adding a part (this change). Our cost stays
  manager/admin-only. Remove service, charged-part removal and QuickBooks actions are unchanged.
- **Decided 2026-11-03:** employees may remove parts (attached or standalone) until the Job has a QuickBooks invoice;
  afterwards a manager/admin is needed (implemented as above, enforced on every removal path incl. legacy `cancel`).
- **Note for review:** `qb_status='linked'` (a Job billed on another Job’s shared invoice) counts as invoiced for
  employees even while the member is still *pending* (its charges not yet on the anchor invoice) — conservative on
  purpose. Also, the Create re-read is a small change to the retail QuickBooks Create path (refuse-before-write only).
- Still open: employees see customer prices on the Job screen; no kill-switch flag (rollback = redeploy previous commit).
