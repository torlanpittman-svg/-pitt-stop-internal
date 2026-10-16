# Service matching, odor package, special-order parts + labor review, Manage services (2026-10-16)

## What it does
- **Rushed entry → confirmed catalog service.** `apps/quick-entry/service-interpret.ts` (pure): shorthand
  + near-miss typo correction ("shamp pass seat" → "shampoo passenger seat"), exact name / approved
  alternate name → one-tap confirm, owner odor rules, tire clarification, part detection, area/component
  extraction ("driver-side mirror assembly"). `service-interpret-ai.ts`: GPT-4o (same provider/key as the
  Quick Entry NL interpreter, `OPENAI_API_KEY`) suggests up to 3 *existing* catalog items by index; any
  area/part words must come from the employee's own entry; no price/qty/tax/description fields exist in
  its schema. AI unavailable/timeout → entry kept, deterministic choices + Browse all + Custom.
  Orchestrated by `service-match-db.ts#interpretServiceEntry` (read-only), exposed as the estimate
  route action `interpret`.
- **Identity ≠ display name ≠ job detail.** `job_services.catalog_id` (0051) + new `detail`,
  `match_method`, `entry_text` (original wording), `catalog_description` (canonical text snapshotted when
  the identity is chosen → later catalog edits affect future additions only). Invoice text =
  `composeLineDescription(canonical, detail)` in `apps/quickbooks/retail-format.ts` ("Seat Shampoo —
  passenger seat"); the estimate shows the exact same string. Correcting a match = `selectServiceMatch`
  (price/qty/tax untouched; audited `service_matched`).
- **Odor definitions.** `service_catalog.service_role`: `odor_duct` (Air Duct Cleaning), `odor_ozone`
  ("Odor / Ozone Treatment" — description = ozone + fabric steam, no ducts; role UNCONFIRMED pending
  manager review), `odor_complete` (new **Complete Odor Treatment**, approved wording "Complete odor
  treatment, including air duct cleaning and ozone treatment.", price entered per job until a default is
  set). Package + separate duct/ozone line = `odor_overlap` (remove the line, or "keep both on purpose",
  audited). Generic odor wording ("Odor Treatment", "car smells bad") is never auto-stamped — it asks.
- **Parts.** One estimate row per special-order part (`job_services.kind='part'`) + its `job_parts`
  record (supply shop|customer, fitment, vendor part #, vendor cost vs customer price). Billed under the
  EXISTING QuickBooks NonInventory item "Part" (looked up, never created). Customer-supplied = no charge.
  `billPart` (Job-detail tracker) now also creates one row per part (the old shared "Parts" bucket sent
  only the first line to QuickBooks and failed the total check).
- **Installation-labor review** (`apps/parts/labor-review.ts`, `estimate-parts.ts`): every part starts
  `needs_review`; resolve by Add installation (existing "Installation Labor" catalog service, entered
  price), Already included (explicit link; one line may cover several parts), Part only, or manager
  Waive (reason, audited). Removing / re-matching the covering line re-opens the review.
- **Gates** (`apps/workflow/estimate-review.ts`): retail invoice CREATE + SYNC, standalone estimate SEND,
  and marking an estimate sent refuse until parts labor / odor overlap / odor choice are resolved. Drafts
  always save. Job completion is never gated.
- **Manage services** (`/quick-entry/services`, `apps/quick-entry/shortcuts.ts`, API
  `/api/quick-entry/services`, manager/admin server-side): shortcuts (`service_shortcuts`) reference
  catalog ids; rename/regroup/reorder/hide/restore; edit canonical description, default price behavior,
  QuickBooks item (selected from the live list only); add a new catalog service (duplicates refused);
  review queue; manager-approved alternate names; usage suggestions (read-only). Audited in
  `service_catalog_events`. Quick Entry + new-estimate shortcut buttons read this table (fallback: the
  original 5-item menu).

## Migration
`drizzle/migrations/manual/0052_service_matching_parts_labor.sql` — additive/idempotent. Must be applied
BEFORE the code deploys (catalog queries select the new columns). Adds 4 catalog rows (Complete Odor
Treatment, Installation Labor, Seat Shampoo, Painting / Refinishing) in `mapping_review` with QB sync off
(bill as Labor with their canonical text until a manager picks the existing QB item), and seeds the
14 usage-based shortcuts only if the table is empty.

## Open owner decisions
See the release report: QuickBooks items for the new/mapping-review rows, Odor/Ozone role confirmation,
Complete Odor Treatment default price, the legacy "Odor Treatment" alias, and parts sales-tax treatment
(part lines are created non-taxable to match the retail QuickBooks convention, TaxCodeRef NON).

## Follow-up (2026-10-16, migration 0053)

**QuickBooks mappings (0053, precondition-guarded, idempotent).** Seven rows left in `mapping_review` by
0052 now bill under existing, active QuickBooks items: Air Duct Cleaning→#76 Air duct, Cabin Air Filter
Replacement→#88, Complete Odor Treatment→#68 Odor Treatment, Installation Labor→#73 Install, Painting /
Refinishing→#57 Paint, Paint Touch-Up→#35, Seat Shampoo→#23 Clean seats. A row is only touched if it is
still exactly as 0052 left it (no ref, `mapping_review`, candidate = target). Only the item reference
changes. The invoice text stays the catalog's approved description, or the service **name** until one is
written. The items' historical QuickBooks text ("Clean rear seats", "Paint front bumper…") is never
used. Rows without an approved description stay flagged (`review_flag`) in Manage services → "Needs a
manager decision" until a manager writes one. Retail lines are always sent `TaxCodeRef NON`, so an
item's own taxable flag never changes tax.

**Ozone.** New `ozone_treatment` ("Ozone Treatment", ozone only, owner definition, item #24 "Ozone",
description "Ozone treatment.", price per job, role `odor_ozone` confirmed). The legacy combined
`odor_ozone` "Odor / Ozone Treatment" (ozone + fabric steam, $300) is `active=false`: its price,
description, aliases and existing lines are untouched, and it still bills #24 on existing jobs. It is
no longer offered for new picks or label stamping (`resolveCatalogIds` now matches active rows only).
The "Ozone Treatment" shortcut points at the new row with the same label, group and order. 0053 skips all
of this if a manager already confirmed the legacy row's role.

**Employee Quick Entry** now uses the shared interpreter (`interpretServiceEntry`). Production has
the natural-language box (`qe_nl_enabled`) **off** (since 2026-08-12, left as is). The path employees
actually use is "＋ Other": when they finish typing a line (Enter or leaving the field), it is sent as
`{ text, line: true }`. That works regardless of the flag, needs a signed-in employee, and returns
services only, never a price or a note.
`POST /api/quick-entry/interpret` returns `entries[]`: raw entry, corrected text, status, intent,
area, part, and real catalog candidates. Price parsing and the note classifier are unchanged, and only
managers/admins get the price. The screen (`linesFromEntries` & helpers in `apps/quick-entry/job-lines.ts`)
adds clear matches directly. Unclear ones are added as typed, with a short question (which service /
who supplies the part / tires mode + qty). "Keep as typed" never marks a confirmed one-off, so the
manager's odor/part review still applies. `createQuickEntryJob` sanitizes the new line fields
(client-sent `custom` is ignored). It creates confirmed parts via `addEstimatePart` and clarified tires
via `addTireWork` (no prices). It promotes labels with `PromoteHint` (identity, `entry_text`, detail).
`promoteTextServices` never re-creates a live part, including customer-supplied ones, as a service.

**Parts typed as services.** `classifyPartWording` (shared rules) → readiness issue `service_as_part`
(blocks estimate send / invoice create, never sync or completion). Estimate actions:
- `convert_to_part` (`convertServiceToPart`): one SQL statement, same row + price line; price/qty/tax/cost
  unchanged. A unique live part per row (`job_parts_active_service_uniq`) makes retries safe. Audited
  as `service_converted_to_part`.
- `clarify_part` (`clarifyServiceWithPart`): the line stays as the labor at its price, the part is added
  separately and linked as `included`.
- "It's a service": `select_match` with `custom`.

"Replace…/R&R…/tires" wording is `ambiguous` and is never auto-converted.
