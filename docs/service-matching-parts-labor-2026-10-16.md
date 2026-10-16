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
