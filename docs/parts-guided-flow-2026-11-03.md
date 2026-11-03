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
| Customer price | typed by whoever adds the part; `addPartForJob` requires it (explicit, ≥ 0, whole cents) and forces `supply='shop'` so `addEstimatePart` creates the priced line once — `lineAmountCents(price, qty)` is what the total and Invoice Draft bill |
| Our cost | `addPartForJob` keeps `unitCostCents` only when `role` is manager/admin (the route also strips it for non-managers); it lands in `job_line_items.cost_cents` and never in the customer charge; `/items` strips it from the view for non-managers |
| Existing unpriced parts | any part that is still unpriced (older data, other entry paths) keeps blocking QB invoice creation via Invoice Draft `pricingIncomplete` until a manager prices it (Edit-part sheet) or removes it — unchanged safeguard |
| Removal after an employee add | an employee-added part now carries a charge, so the existing **charged-part rule applies to it immediately**: the employee who added it sees “Ask a manager to remove it” (see Decisions) |

## Files

- `apps/parts/estimate-parts.ts` — `attachedPartsOf`, `partIsCharged`, `addPartForJob`, `removeServiceWithParts`
- `apps/parts/job-items-view.ts` (new, pure) — grouping, non-manager redaction, confirmation copy, manager-needed messages, `validatePartDraft` (the form's required-price rule)
- `app/api/workflow/orders/[id]/items/route.ts` (new GET, any shop session) — the Job-screen view
- `app/api/workflow/orders/[id]/parts/route.ts` — `add` → estimate path on retail Jobs; `remove`/`cancel` → one charge-aware rule
- `app/api/workflow/orders/[id]/estimate/route.ts` — `remove_service_with_parts`; `app/orders/[id]/estimate/save-feedback.ts` — its labels/confirmation
- `app/orders/[id]/JobItemsPanel.tsx` (new UI), `app/orders/[id]/JobItems.tsx` (hook: `/items`, `canEdit`, `removeServiceWithParts`), `app/orders/[id]/OrderDetail.tsx` (wiring)
- `app/work-board/VehicleCard.tsx`, `app/work-board/WorkBoardClient.tsx` — waiting badge removed
- Tests: `apps/parts/job-items-view.test.ts` (grouping, redaction, copy, draft validation), `apps/parts/remove-service-with-parts.test.ts` (PGlite: employee priced adds attached + standalone, price × qty once, cost never charged / never stored for employees, missing/negative/invalid price refused before any write, explicit $0, existing-unpriced safeguard, removal/audit/QB-flag/retry), `app/api/workflow/orders/[id]/parts/route.test.ts` (price forwarded for every role, cost manager-only, service rejection → 400)

## Verification (2026-11-03, after the required-price change)

- `npx tsc --noEmit`: clean (the only errors are pre-existing in the untouched `apps/estimates/quickbooks.test.ts`).
- ESLint on every changed file: 0 findings (OrderDetail’s existing react-hooks errors are identical on origin/main).
- Targeted: `npx vitest run apps/parts "app/api/workflow/orders/[id]/parts"` → all pass (incl. the new price cases).
- Full suite `npm test`: see the chat report for the run after this change (money/invoice change → full suite required).
- `next build --webpack`: passes.
- 390 px headless walkthrough (real page + components, data layer stubbed by route interception, no DB writes):
  29/29 checks — employee: blank price → More details expands, Customer price focused, message shown, nothing sent;
  negative price refused in place; 12.50 × 2 sends `sellPriceCents=1250`, qty 2, no cost, row shows $25.00; the
  employee’s own (now charged) part → manager message; a legacy unpriced part still removable; manager: More-details
  order Our cost → Customer price → Part number → Quantity, price 18 + cost 7 sent, cost never on the row; plus the
  earlier placement/focus/removal/forbidden-label/no-horizontal-scroll checks. Screenshots: scratchpad `shots-guided/`.

## Decisions for the owner (see the chat report)

- **Decided 2026-11-03:** employees enter the customer price when adding a part (this change). Our cost stays
  manager/admin-only. Remove service, charged-part removal and QuickBooks actions are unchanged.
- **Consequence to confirm:** because an employee-added part is priced immediately, the existing charged-part rule
  means the employee cannot remove it themselves (even a typo seconds later) — a manager must. If that is too strict,
  the next decision is whether an employee may remove a part that is not yet on a QuickBooks invoice.
- Still open: employees see customer prices on the Job screen; no kill-switch flag (rollback = redeploy previous commit).
