# Parts screenshot import — review & status

**Status:** built locally in the isolated worktree `pitt-parts-screenshot-preview` (from `origin/main`
`0147090`). **Not deployed, not pushed, migration not applied, flag OFF.** Pending owner review.

## What it does (business outcome)
The quickest phone workflow for the existing, logged-in PartsTech (NAPA / O'Reilly) — **no PartsTech API**.

1. **Standalone Parts page** (`/parts`): one big **Open PartsTech** button (opens `https://app.partstech.com/`
   in a new tab), plus guidance and a link to the Work Board. No embedding, scraping, stored credentials, or
   guessed VIN deep links. Ordering + delivery happen in PartsTech ("choose shop at checkout").
2. **From a job** (Work Board → order → Parts → **Import from screenshot**): **Copy VIN** (reuses the job's
   decoded VIN), open PartsTech, build the cart, screenshot the cart/quote/order, come back, and **upload
   1–4 screenshots**. The app reads **descriptions, part numbers, quantities, supplier, and visible unit
   PURCHASE cost**; a manager reviews/corrects and **saves them as tracked parts on the SAME job**. PartsTech
   never needs the job reference.

**It never bills, never writes QuickBooks or an expense record, never marks received/paid.** For a
manager-confirmed **placed order** (purchase + supplier + order #) it can mark the new parts **Ordered** in
one tap (still no real supplier order). Existing money/Invoice Draft/VIN decoder/canonical descriptions are
unchanged.

## Flags & switches (all default OFF / reversible env reads, no DB dependency)
| Env var | Default | Effect |
|---|---|---|
| `PARTS_SCREENSHOT_IMPORT_ENABLED` | **off** | Master switch for the whole import feature (upload/read/review/apply + the panel). Off ⇒ the Parts section renders exactly as today. |
| `PARTS_EMPLOYEE_VISIBLE` | off | Existing gate: whether employees (not just managers) see Parts at all. Import also requires this. |
| `PART_IMPORTS_BLOB_READ_WRITE_TOKEN` (optional) | — | Private Blob store for screenshots; falls back to `RECEIPTS_BLOB_READ_WRITE_TOKEN`. |

Managers/admins always see Parts; employees need `PARTS_EMPLOYEE_VISIBLE`. The import panel is hidden for
everyone until `PARTS_SCREENSHOT_IMPORT_ENABLED` is on.

## Enablement / rollback (pending owner approval — NOT done)
**Order matters — migration BEFORE code deploy:**
1. **Apply migration `drizzle/migrations/manual/0066_part_screenshot_imports.sql` FIRST**, before deploying
   this code — even with the import flag off. The migration adds a `job_parts.import_row_id` column, and this
   code's existing `select(... job_parts ...)` reads every column; deploying the code against a pre-migration
   database would error on the missing column. (Additive only: 3 new tables + the one nullable column +
   indexes/checks; safe to re-run.)
2. **Then deploy this code** (import flag still off → the Parts section renders exactly as today).
3. **Then set `PARTS_SCREENSHOT_IMPORT_ENABLED=true`** (and the Blob token) in the deploy env to turn it on.
4. **Rollback = set the flag off** (no schema change needed). Imported parts are ordinary `job_parts` rows and
   remain. (Dropping the tables/column, if ever wanted, is a separate deliberate step and must come *after*
   rolling back the code that reads the column.)

## No-API flow (ASCII)
```
/parts or Job ─► Open PartsTech (new tab) ─► [in PartsTech: find parts, choose shop, screenshot]
     │                                                  │
   Copy VIN ──────────────────────────────────────────┘
     ▼
Job ▸ Parts ▸ Import from screenshot ▸ upload 1–4 PNG/JPEG/WebP
     ▼  (saved privately FIRST)            ▼ (AI read: per-image → merge, conflicts flagged)
   batch 'uploaded' ───── read ──────► 'proposed'  (or 'failed' = recoverable: retry / add manually)
     ▼
Manager review: fix description / qty / unit cost · New / Link / Skip · [already placed?]
     ▼  (atomic apply: claim + insert/link + audit, all-or-nothing)
job_parts (needed, or ordered)  ──►  existing Parts tracker / Invoice Draft (unchanged)
```

## Key safety properties
- **Trust neither model nor client.** Strict money grammar (integer cents; negatives/exponents/mixed-text/
  sub-cent → null; a real $0 stays 0). Quantity is **never guessed** (missing ⇒ null; reviewer confirms a
  positive qty before apply). Purchase cost comes **only** from an explicit `unitCost`; generic `price`/
  `cost`/MSRP is list metadata, never the purchase cost. Tax/shipping/core are document metadata only — no
  markup/sell/tax arithmetic.
- **Private originals.** Screenshots are validated (magic bytes + real raster decode with a pixel ceiling +
  size cap) and stored in a **private** Blob namespace *before* any AI. Retrieval is a **manager-only**,
  job-scoped server route. Employees never see costs, document totals, or the original screenshots.
- **Atomic + idempotent (Neon HTTP has no interactive txn — single-statement CTEs).** Batch+images are
  created in one statement; the AI proposal is persisted in one statement (a failure stays `reading`, never a
  fake proposal); **apply claims the batch (`proposed→applied`) and inserts/links + writes the append-only
  `service_order_events` audit in one statement, with an in-SQL assertion that every selected row produced
  exactly one insert/link** — if a concurrent cancel/trigger silently skips a write, the whole apply rolls
  back (nothing committed, no audit). A per-import-row unique index guarantees one live part per source line.
- **All-or-nothing reads.** Every required screenshot must read AND extract and the batch must yield ≥1 line,
  else the read is a recoverable `failed` (never a partial success). Page disagreements on supplier/order/type
  are persisted (`read_warnings`) and surfaced, never silently first-won.
- **Duplicates.** Resume on `capture_id` (conflicting retry payload rejected) and on the canonical set hash;
  warn on overlapping image subsets and duplicate SKUs; **block a duplicate supplier order by default**
  (friendly precheck **and** a partial unique index on applied `(order,supplier,order-ref)`), overridable only
  by an explicit manager "legitimate additional import" confirmation.
- **Links never clobber.** A `link` fills only empty operational fields (supplier/ref/cost via COALESCE) and
  promotes a still-`needed` part to `ordered`; it never touches sell/received/returned/labor/invoice state.
  Ineligible targets (cancelled / wrong job / customer-supplied / already-imported / duplicate) are rejected
  both up front and atomically in the claim's `WHERE`.
- **Optimistic concurrency.** Each batch has a `revision`; review/apply/cancel carry the revision the manager
  last saw, so no one overwrites — or applies — edits they did not see.
- **Roles.** Upload + non-money status = any authorized shop user (behind both gates). Review/apply/cancel +
  original-image retrieval = manager/admin. No new permission escalation; the mature manual tracker and its
  manager-only cost/sell rules are unchanged.

## Changed / new files
- `apps/parts/visibility.ts` — new `partsScreenshotImportEnabled()` flag (manual tracker gate unchanged).
- `apps/parts/schema.ts` — `job_parts.import_row_id` + 3 new tables (`part_import_batches/_images/_rows`) with
  checks/indexes. `apps/parts/import-normalize.ts`, `import-ai.ts`, `import-image.ts`, `import-storage.ts`,
  `import-read.ts`, `import-db.ts` — pure normalizer, AI reader, fail-closed decode, private storage, shared
  read step, atomic data layer.
- `drizzle/migrations/manual/0066_part_screenshot_imports.sql` — additive migration.
- `app/api/workflow/orders/[id]/parts/imports/**` — scoped routes: `_gate.ts` (auth/UUID/same-origin),
  collection (fast-ack upload + bounded body + validate-all-before-store), `[batchId]` (read/review/apply/
  cancel; mutations require the client's revision), `[batchId]/images/[imageId]` (manager-only stream).
- `app/parts/page.tsx` + `app/parts/PartsLanding.tsx` (shared presentational landing). `app/orders/[id]/
  PartImportPanel.tsx` + a small wiring change in `app/orders/[id]/PartsSection.tsx` (renders the panel keyed
  by orderId; hidden when the flag is off). `app/page.tsx` — Parts home tile (uses existing parts visibility).
- `app/parts/preview/**` + `scripts/parts-preview/**` — guarded non-production preview harness (synthetic;
  order / quote-missing-cost / failed / cancelled / employee scenarios). Hard-off in production.
- Tests: `apps/parts/import-normalize.test.ts`, `import-ai.test.ts`, `import-read.test.ts`, `import-db.test.ts`,
  and `app/api/workflow/orders/[id]/parts/imports/[batchId]/route.test.ts`.

## Test / preview commands (Codex runs; Claude cannot execute)
- Targeted tests: `npx vitest run apps/parts app/api/workflow/orders/\[id\]/parts` — normalizer (strict
  money/qty, cost≠list≠total, injected text, bounds, supplier conflict, batch hash), AI merge (conflict
  detection, mocked OpenAI, fail-closed), read all-or-nothing (partial image failure → failed), the PGlite
  data layer (atomic create/propose, idempotent resume, apply new/ordered, link eligibility + promote without
  clobber, **skipped-write rollback via a runtime count assertion**, **case-insensitive duplicate-order DB
  guard**, duplicate-SKU ack incl. repeated-within-import, supplier/quantity/order-ref link-conflict reject,
  stale-revision conflict, soft cancel + audit), the batch route (wrong-job read, required integer revision,
  employee apply denial, **malformed-edit rejection**, oversized body, employee money redaction), and the
  upload route (fast ack, validate-all-before-store, storage-failure, captureId-as-file, byte-stream cap).
- Broad (schema/`drizzle/schema.ts` touched): `npm test` + `tsc --noEmit`. Baseline before this work: 206
  files / 2574 tests passing; `tsc` had 10 pre-existing errors only in `apps/estimates/quickbooks.test.ts`
  (unrelated, unchanged).
- External APIs are **mocked**; **no live DB, no real OpenAI/PartsTech, no Blob** are exercised by tests.
- Local preview (owner review): `npm run dev` → `http://localhost:3000/parts/preview` (non-production only;
  synthetic data; **live AI accuracy is NOT exercised or claimed**). See `scripts/parts-preview/README.md`.

## Assumptions / limitations
- One import = **one supplier order** (up to 4 pages). A mixed-supplier document is flagged and blocks the
  "already placed" fast-path until corrected; parts still import as `needed`.
- A read that finds no parts, or any screenshot that can't be read, is a **recoverable `failed`** state
  (retry / enter manually) — never a success with invented rows.
- The AI reader uses the existing OpenAI GPT-4o vision pattern (35s timeout, no auto-retry). Live extraction
  accuracy is **not** claimed verified — the preview uses synthetic fixtures; real screenshots should be spot-
  checked after enablement.
- `getImportJobContext` reads the job's decoded VIN for **Copy VIN**; no new VIN decode is performed.


## Independent verification — 2026-10-29 (Codex)

Claude Code implemented the feature in session `69738cc7-a5ee-4c42-b99e-54a10fa3a216`; Codex reviewed the
actual changes, supplied failure cases, and ran the commands below. The same Claude session handled all
corrections. Its final round completed normally with no permission denials. No deployment or live data action
was performed. The original dirty checkout was left intact; this work is isolated on
`codex/parts-screenshot-preview` at `/private/tmp/pitt-parts-screenshot-preview`.

| Check | Verified result |
|---|---|
| Full suite (`npm test`) | **212 files / 2,649 tests passed**. The final small preview-navigation and mock-lint cleanup was subsequently checked with the targeted suite, lint and build. |
| Final targeted parts + import routes | **12 files / 146 tests passed**. |
| Independent adversarial checks outside the repo | **32 passed**: atomic create/proposal/apply, skipped-update rollback, capture retry conflict, quantity/order-reference link conflicts, duplicate SKU acknowledgement, wrong-job/read permissions, request byte caps, strict malformed-input rejection, all-or-nothing image validation/storage failure, failed AI page, and existing-proposal reuse without another AI call. |
| Scoped ESLint | **Passed, no errors or warnings**. |
| Production build (`next build --webpack`) | **Passed**, including Next's TypeScript phase. Initial restricted-network attempt could not download existing Google Fonts; retry with font download access passed, as did the final build after preview navigation changes. |
| Source-only TypeScript | **Passed** (temporary verification config excludes test files). |
| Full `tsc --noEmit` including tests | Exactly the **10 pre-existing errors in `apps/estimates/quickbooks.test.ts`**; output matches the baseline, no added feature errors. Unrelated file unchanged. |
| Migration rehearsal | In-memory PGlite: fresh application, repeat application, case-insensitive supplier-order uniqueness, and explicit duplicate exception passed. **No Neon migration executed.** |
| Image handling | Synthetic valid PNG decode/derived JPEG, truncated/garbage rejection, and upload-byte limits verified. |

Evidence logs and independent harnesses are in `/private/tmp/pitt-parts-coordination/`. Final logs:
`review-targeted.log`, `final-independent.log`, `final-full-tests.log`, `review-lint.log`,
`review-build.log`, `final-types.log`, `final-source-types.log`, `migration-review.log`.

### Browser checks and owner preview

Local preview: **http://127.0.0.1:3016/parts/preview** (this Mac only). Uses the real components with synthetic
fixtures; it does not connect to a real job, supplier order, AI, or Blob storage. The preview page and sample
image route return 404 in production. Source PNGs are deliberately marked SAMPLE / NOT A REAL ORDER.

Verified at a 390px phone viewport and a 1280px desktop viewport, without horizontal overflow:
- Parts landing, employee upload and non-money review, manager review, and actual sample-source image.
- Real file picker selection of the synthetic PNG, client image preparation, then the fixture's saved
  manager-review state. An initial picker was interrupted; a fresh bounded attempt succeeded.
- Natural `59.50` price entry, draft save and persistence; unit cost distinct from list price and line total.
- Duplicate warning; linking the existing sample part; placed-order confirmation; save reports two lines on
  the sample job. Backend tests verify the actual persisted status and idempotency separately.
- Quote with missing purchase cost remains blank, can save without becoming a placed order.
- Reading recovery control, cancelled import read-only, employee view has no monetary fields or originals.
- The preview Work Board link now switches to the sample employee job; real page links keep their normal
  destinations. Temporary viewport overrides were reset. No browser console errors on the final flow.

Phone screenshots saved for review: `parts-page.jpg`, `employee-upload.jpg`, `employee-review.jpg`, and
`manager-review.jpg` in the chat's outputs folder. The fixture transport returns sample rows; it is not proof
of live OCR accuracy or every server rule. The real server rules are covered separately by the tests.

### Handoff and remaining launch work

**Ready for owner workflow review, not authorized for launch.** Dot should independently review this package
and collect the owner's decisions there. No desktop-only approval is required for this local build.

1. Owner reviews the Parts page and employee-upload / manager-price-review flow. Employees remain behind
   the existing `PARTS_EMPLOYEE_VISIBLE` gate (default off); enabling employee access is a separate choice.
2. Before any release, compare current remote main/deployed state again, resolve migration numbering if
   needed, and follow the repository's established scoped-worktree deployment process.
3. Obtain explicit owner approval for the specific production migration/deploy/flag changes. Apply the
   additive migration **before** code deployment, even if the import flag is off; enable the import flag
   only when storage/AI are configured and the owner approves.
4. Live OpenAI extraction accuracy, private Blob round-trip, and real-phone PartsTech tab/checkout behavior
   remain untested. Arrange an approved smoke test before broad rollout. No real parts order is required
   to test screenshot import, and no real order has been placed by this work.

Cancellation preserves the import/audit and creates no parts. An applied import cannot be cancelled through
this import screen; any later part correction uses the existing part tracker. Reopening or retrying an
applied batch is a no-op for part creation. Re-uploading the identical active screenshot set resumes the
same job import; a conflicting capture payload is rejected. Linking fills an empty purchase cost but keeps
an existing saved cost and never changes sell price, billing, labor, or received state.
