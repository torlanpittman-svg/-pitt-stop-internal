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
  Our cost · each (manager), Customer price · each (manager), Part number, Quantity (default 1).
  Submit = **Add part to service** / **Add to this job**. A brief “✓ … added to …” notice appears where it happened,
  the new row is highlighted and scrolled into view.
- **Part rows** show only name · customer amount · Remove. No ordered/received/waiting/“charged” labels anywhere
  (the Work Board WAITING ON PARTS chip and “· N waiting” are gone too). Historical `job_parts` status data is untouched.
- **Remove part** asks once (“Remove ‘Oil filter’ from ‘Oil Change’ and the job total?”), removes only that part + its
  charge; the service stays. An employee tapping Remove on a **charged** part sees
  *“This part is on the customer’s invoice. Ask a manager to remove it.”* — enforced server-side too.
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
| Remove part | `POST /parts {action:'remove'}` → `removeEstimatePartWithLabor(…,{action:'keep'})` (line + record, audited, QB only flagged) |
| Remove service | `POST /estimate {action:'remove_service_with_parts'}` → `removeServiceWithParts` (each attached part via `removeEstimatePart`, then `removeEstimateService`; audit `service_removed_with_parts`) |
| Employee pricing | employees cannot set cost/price (server strips); their part is saved **unpriced** → Invoice Draft `pricingIncomplete` blocks QB invoice creation until a manager prices it (existing Edit-part sheet) or removes it |

## Files

- `apps/parts/estimate-parts.ts` — `attachedPartsOf`, `partIsCharged`, `addPartForJob`, `removeServiceWithParts`
- `apps/parts/job-items-view.ts` (new, pure) — grouping, non-manager redaction, confirmation copy, manager-needed messages
- `app/api/workflow/orders/[id]/items/route.ts` (new GET, any shop session) — the Job-screen view
- `app/api/workflow/orders/[id]/parts/route.ts` — `add` → estimate path on retail Jobs; `remove`/`cancel` → one charge-aware rule
- `app/api/workflow/orders/[id]/estimate/route.ts` — `remove_service_with_parts`; `app/orders/[id]/estimate/save-feedback.ts` — its labels/confirmation
- `app/orders/[id]/JobItemsPanel.tsx` (new UI), `app/orders/[id]/JobItems.tsx` (hook: `/items`, `canEdit`, `removeServiceWithParts`), `app/orders/[id]/OrderDetail.tsx` (wiring)
- `app/work-board/VehicleCard.tsx`, `app/work-board/WorkBoardClient.tsx` — waiting badge removed
- Tests: `apps/parts/job-items-view.test.ts`, `apps/parts/remove-service-with-parts.test.ts` (PGlite, money/removal/audit/QB-flag/retry), `app/api/workflow/orders/[id]/parts/route.test.ts`

## Verification (2026-11-03)

- `npx tsc --noEmit`: clean (the only errors are pre-existing in the untouched `apps/estimates/quickbooks.test.ts`).
- ESLint on every changed file: no new findings (OrderDetail’s existing react-hooks errors are identical on origin/main).
- Full suite `npm test`: 3013/3014; the one failure was a 5 s timeout in `apps/quickbooks/invoice-consolidation.test.ts`
  while the dev server was compiling; re-run alone → 55/55.
- `next build --webpack`: passes.
- 390 px headless walkthrough (real page + components, data layer stubbed by route interception, no DB writes):
  20/20 checks — employee/manager views, form placement + focus, More-details order, Quantity=1, confirmations,
  manager-needed messages, service removal with attached parts, part removal keeps service, no forbidden labels,
  no horizontal scroll. Screenshots: scratchpad `shots-guided/`.

## Decisions for the owner (see the chat report)

Employees now see customer prices on the Job screen; employee-added parts block QB invoice creation until priced;
Remove service stays manager-only; no kill-switch flag was added (rollback = redeploy previous commit).
