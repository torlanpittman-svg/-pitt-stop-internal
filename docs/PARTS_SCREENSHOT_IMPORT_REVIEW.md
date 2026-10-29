# Parts screenshot import — review & status

**Status:** built locally in the isolated worktree `pitt-parts-screenshot-preview` (from `origin/main`
`0147090`). **Not deployed, not pushed, migration not applied, flag OFF.** Pending owner review.

> **Owner correction (current):** the manager/employee split for this workflow was removed — **the Parts
> screenshot-import workflow has EQUAL PERMISSIONS for every authorized shop user** (upload, read, see costs +
> original screenshots, review, link/skip/new, acknowledge duplicates, mark already-placed, save parts,
> cancel an unapplied import). There is no second manager handoff. This does **not** grant employees manager
> roles or widen Invoice Draft / QuickBooks / checks / finance; the manual tracker's billing/sell/credit gates
> are unchanged. Any earlier "manager-only review / employee money-redaction" statement below is **superseded**.

## Current verification — 2026-10-29

This section supersedes the earlier split-role preview and its verification snapshot. The preview now has
only **Parts page** and **Job parts**. Employees and managers have the same screenshot-import permissions.

| Check | Verified result |
|---|---|
| Full test suite | **214 files / 2,668 tests passed**. The subsequent test-only nullable-fixture annotation was checked with its focused **5/5** tests and lint; no runtime source changed afterward. |
| Independent checks outside the repo | **7 files / 59 tests passed**: equal permissions, private originals, unauthenticated/flag-off/wrong-job rejection, uploads/AI failure handling, atomic rollback, and concurrent duplicate saves. |
| Local build | **`next build --webpack` passed**, including its TypeScript phase. This builds locally; it does not deploy. |
| Source type check and scoped lint | **Passed**. The full type check, including tests, has exactly the **10 pre-existing errors** in `apps/estimates/quickbooks.test.ts`; its output matches the baseline byte-for-byte. |
| Phone preview | Shared Job parts checked at **390 px**, no horizontal overflow. Prices and original sample image visible; link to an existing part, confirm already placed, and save to the job succeeded in the synthetic preview. |

**Dot's duplicate-save finding is corrected locally.** The original independent reproduction had 5 passes
and 1 failure: separate imports of the same unreferenced SKU both saved. The revised independent tests
force both callers through their preliminary checks before allowing either transaction to run. One save
wins; the other remains proposed, requests duplicate acknowledgement, and writes no extra part or audit.
An explicit acknowledgement then succeeds. A concurrent duplicate supplier order requests order
confirmation first, so the user is not prompted twice. Same-batch retries stay idempotent. Distinct SKUs
and different jobs can both save.

The authoritative checks run after a job-row lock in a separate statement inside one READ COMMITTED
transaction. SQL also checks repeated new SKUs within an import. The actual installed Neon Drizzle batch
path was checked with a fake client to confirm the production-write guard blocks writes before transaction
submission. **No live Neon concurrency test was performed**: data tests use in-memory PGlite with a real
transaction adapter; live multi-connection behavior still needs a non-production smoke test before release.

Current phone screenshots in the chat's review outputs: `parts-page-shared.jpg` and `shared-job-parts.jpg`.
Older employee/manager screenshots are historical. The preview uses synthetic fixtures: **live AI extraction
accuracy, private Blob storage, and the deployed authentication path have not been exercised**. No real
PartsTech order, migration, production write, push, deployment, or flag change occurred.

## What it does (business outcome)
The quickest phone workflow for the existing, logged-in PartsTech (NAPA / O'Reilly) — **no PartsTech API**.

1. **Standalone Parts page** (`/parts`): one big **Open PartsTech** button (opens `https://app.partstech.com/`
   in a new tab), plus guidance and a link to the Work Board. No embedding, scraping, stored credentials, or
   guessed VIN deep links. Ordering + delivery happen in PartsTech ("choose shop at checkout").
2. **From a job** (Work Board → order → Parts → **Import from screenshot**): **Copy VIN** (reuses the job's
   decoded VIN), open PartsTech, build the cart, screenshot the cart/quote/order, come back, and **upload
   1–4 screenshots**. The app reads **descriptions, part numbers, quantities, supplier, and visible unit
   PURCHASE cost**; the reviewer (any authorized shop user) corrects and **saves them as tracked parts on the
   SAME job**. PartsTech never needs the job reference.

**It never bills, never writes QuickBooks or an expense record, never marks received/paid.** For a reviewer-
confirmed **placed order** (purchase + supplier + order #) it can mark the new parts **Ordered** in one tap
(still no real supplier order). Existing money/Invoice Draft/VIN decoder/canonical descriptions are unchanged.

## Flags & switches (all default OFF / reversible env reads, no DB dependency)
| Env var | Default | Effect |
|---|---|---|
| `PARTS_SCREENSHOT_IMPORT_ENABLED` | **off** | Master switch for the whole import feature (upload/read/review/apply + the panel). Off ⇒ the Parts section renders exactly as today. When ON, it ALSO makes Parts visible to every authorized shop user (the import workflow is an equal-permission feature), even if `PARTS_EMPLOYEE_VISIBLE` is off. |
| `PARTS_EMPLOYEE_VISIBLE` | off | Legacy rollout gate for the **manual** tracker to employees. When the import flag is OFF, this still governs employee visibility exactly as before. |
| `PART_IMPORTS_BLOB_READ_WRITE_TOKEN` (optional) | — | Private Blob store for screenshots; falls back to `RECEIPTS_BLOB_READ_WRITE_TOKEN`. |

Visibility = `manager/admin || PARTS_EMPLOYEE_VISIBLE || PARTS_SCREENSHOT_IMPORT_ENABLED`. So with the import
flag ON, employees reach the Parts tile/page/job panel too; with it OFF the legacy rollout behavior is
preserved exactly. The import panel itself is hidden for everyone until `PARTS_SCREENSHOT_IMPORT_ENABLED` is on.

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
Shared review: fix description / qty / unit cost · New / Link / Skip · [already placed?]
     ▼  (locked job transaction: duplicate check + claim + insert/link + audit)
job_parts (needed, or ordered)  ──►  existing Parts tracker / Invoice Draft (unchanged)
```

## Key safety properties
- **Trust neither model nor client.** Strict money grammar (integer cents; negatives/exponents/mixed-text/
  sub-cent → null; a real $0 stays 0). Quantity is **never guessed** (missing ⇒ null; reviewer confirms a
  positive qty before apply). Purchase cost comes **only** from an explicit `unitCost`; generic `price`/
  `cost`/MSRP is list metadata, never the purchase cost. Tax/shipping/core are document metadata only — no
  markup/sell/tax arithmetic.
- **Private originals.** Screenshots are validated (magic bytes + real raster decode with a pixel ceiling +
  size cap) and stored in a **private** Blob namespace *before* any AI. Retrieval is via an authenticated,
  **job-/batch-/image-scoped** server route behind the SAME import gate as the rest of the workflow — any
  authorized shop user may view the original during review (equal permissions); no public URL/token leaks.
- **Atomic + per-job locked apply.** Batch+images are created in one statement; the AI proposal is persisted
  in one statement (a failure stays `reading`, never a fake proposal). **Apply runs inside a real per-job
  transaction** — Neon HTTP has no interactive callback transaction, but `db.batch([...])` IS a noninteractive
  transaction (`client.transaction`, guard-covered). The batch is three SEPARATE statements: (1) `SET
  TRANSACTION ISOLATION LEVEL READ COMMITTED`; (2) `SELECT … FROM service_orders WHERE id = $job FOR UPDATE`
  (locks THIS job only — different jobs never share a lock); (3) the apply CTE, which claims the batch
  (`proposed→applied`), inserts/links, writes the append-only `service_order_events` audit, and asserts in-SQL
  that every selected row produced exactly one insert/link (else the whole transaction rolls back — nothing
  committed, no audit). Because step 3 is a separate statement under READ COMMITTED, its snapshot is taken
  **after** the lock wait, so it sees a sibling import's just-committed parts and can gate on them (Read
  Committed gives each command a new snapshot — see refs). A per-import-row unique index still guarantees one
  live part per source line.
- **All-or-nothing reads.** Every required screenshot must read AND extract and the batch must yield ≥1 line,
  else the read is a recoverable `failed` (never a partial success). Page disagreements on supplier/order/type
  are persisted (`read_warnings`) and surfaced, never silently first-won.
- **Duplicates (incl. the concurrent-apply race).** Resume on `capture_id` (conflicting retry payload
  rejected) and on the canonical set hash. The duplicate checks — a NEW SKU already tracked on the job, the
  SAME SKU repeated within this import, a screenshot already imported here, and the same supplier order
  already applied — run as **friendly JS prechecks AND authoritatively inside the locked apply transaction**
  on the fresh post-lock snapshot. So two DISTINCT proposed imports on the same job with the same SKU and no
  order reference, applied in parallel, can no longer both succeed: the loser's claim is gated with no partial
  writes. When the claim is gated, the response matches the precheck order — a duplicate supplier ORDER asks
  for `needsDuplicateConfirm` FIRST, otherwise a SKU/screenshot duplicate asks for `needsDuplicateAck` (so a
  same-order+same-SKU race never asks for acknowledgement and then re-asks for confirmation). A genuine
  additional import is then applied only with the explicit confirmation/acknowledgement. The applied
  `(order, lower(supplier), lower(order-ref))` partial unique index remains a backstop for the referenced case.
- **Links never clobber.** A `link` fills only empty operational fields (supplier/ref/cost via COALESCE) and
  promotes a still-`needed` part to `ordered`; it never touches sell/received/returned/labor/invoice state.
  Ineligible targets (cancelled / wrong job / customer-supplied / already-imported / duplicate) are rejected
  both up front and atomically in the claim's `WHERE`.
- **Optimistic concurrency.** Each batch has a `revision`; review/apply/cancel carry the revision the reviewer
  last saw, so no one overwrites — or applies — edits they did not see.
- **Permissions (EQUAL).** Every authorized shop user (manager/admin, individual employee, or a legacy
  shared-PIN session) has the SAME import capability: upload, read, see costs + original screenshots, review,
  link/skip/new, acknowledge duplicates, mark already-placed, save parts, cancel an unapplied import. The gate
  requires a valid session + the feature flag; unauthenticated and feature-off stay denied. The `actorName`/
  `actorKey` carry audit attribution only — no role is surfaced and `manager:true` is never faked. This does
  NOT widen roles or any other permission; the manual tracker's billing/sell/credit gates are unchanged.

## Changed / new files
- `apps/parts/visibility.ts` — new `partsScreenshotImportEnabled()` flag (manual tracker gate unchanged).
- `apps/parts/schema.ts` — `job_parts.import_row_id` + 3 new tables (`part_import_batches/_images/_rows`) with
  checks/indexes. `apps/parts/import-normalize.ts`, `import-ai.ts`, `import-image.ts`, `import-storage.ts`,
  `import-read.ts`, `import-db.ts` — pure normalizer, AI reader, fail-closed decode, private storage, shared
  read step, atomic data layer (apply now wrapped in a per-job locked `db.batch` transaction).
  `apps/parts/import-batch-test-adapter.ts` — TEST-ONLY faithful `db.batch` over one PGlite transaction
  (never imported by runtime code; shared by the import-db tests + the coordinator's independent harness).
- `drizzle/migrations/manual/0066_part_screenshot_imports.sql` — additive migration.
- `app/api/workflow/orders/[id]/parts/imports/**` — scoped routes: `_gate.ts` (shared equal-permission gate +
  UUID/same-origin), `_body.ts` (bounded body reader), collection (fast-ack upload + validate-all-before-
  store), `[batchId]` (read/review/apply/cancel; mutations require the client's revision; full view to every
  authorized user), `[batchId]/images/[imageId]` (private job-scoped stream behind the same gate).
- `app/parts/page.tsx` + `app/parts/PartsLanding.tsx` (shared presentational landing). `app/orders/[id]/
  PartImportPanel.tsx` + a small wiring change in `app/orders/[id]/PartsSection.tsx` (renders the panel keyed
  by orderId; hidden when the flag is off). `app/page.tsx` — Parts home tile (uses existing parts visibility).
- `app/parts/preview/**` + `scripts/parts-preview/**` — guarded non-production preview harness (synthetic;
  two views — Parts page + one shared Job-parts screen — with order / quote-missing-cost / failed / reading /
  cancelled scenarios). Hard-off in production.
- Tests: `apps/parts/import-normalize.test.ts`, `import-ai.test.ts`, `import-read.test.ts`, `import-db.test.ts`,
  `apps/parts/visibility.test.ts`, and under `app/api/workflow/orders/[id]/parts/imports/`: the collection
  `route.test.ts`, `_gate.test.ts`, `[batchId]/route.test.ts`, and `[batchId]/images/[imageId]/route.test.ts`.

## Test / preview commands (Codex runs; Claude cannot execute)
- Targeted tests: `npx vitest run apps/parts app/api/workflow/orders/\[id\]/parts` — normalizer (strict
  money/qty, cost≠list≠total, injected text, bounds, supplier conflict, batch hash), AI merge (conflict
  detection, mocked OpenAI, fail-closed), read all-or-nothing (partial image failure → failed), the PGlite
  data layer (atomic create/propose, idempotent resume, apply new/ordered, link eligibility + promote without
  clobber, **skipped-write rollback via a runtime count assertion**, **case-insensitive duplicate-order DB
  guard**, duplicate-SKU ack incl. repeated-within-import, supplier/quantity/order-ref link-conflict reject,
  stale-revision conflict, soft cancel + audit, **the concurrent DISTINCT-import race: parallel same-SKU
  unreferenced imports apply exactly once — loser gets `needsDuplicateAck`, explicit ack then adds the extra
  part, distinct SKUs both apply, and the lock is per-job**), the shared gate (`_gate.test.ts`: unauthenticated 401,
  feature-off 403, authorized employee/manager/shared-PIN admitted identically with generic attribution), the
  batch route (wrong-job read, required integer revision, **equal-permission review/apply/cancel succeed**,
  **full money in GET to every user**, **malformed-edit rejection**, oversized body), the image route (shared
  gate, equal access, wrong-job/wrong-image 404), the visibility matrix (manager || legacy flag || import
  flag), and the upload route (fast ack, validate-all-before-store, storage-failure, captureId-as-file,
  byte-stream cap).
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
- **Concurrent-apply race (Dot):** fixed by the per-job locked `db.batch` transaction above. The PGlite test
  adapter runs the three statements sequentially in one `PGlite.transaction` (faithful to the Neon path, not
  a Promise.all/no-op fake). **Live Neon concurrency is NOT claimed tested** — PGlite serializes connections,
  so the test validates the lock + fresh-snapshot duplicate recheck logic, and the `FOR UPDATE` + READ
  COMMITTED design is what serializes real concurrent Neon transactions.

### References (transaction/batch design)
- Drizzle batch API (noninteractive transaction): https://orm.drizzle.team/docs/batch-api
- Neon serverless driver (HTTP; no interactive transactions, batch over `client.transaction`): https://neon.com/docs/serverless/serverless-driver
- PostgreSQL Read Committed (each command gets a fresh snapshot, so a post-lock statement sees prior commits): https://www.postgresql.org/docs/current/transaction-iso.html
- Verified in installed source: `node_modules/drizzle-orm/neon-http/session.js` (`batch()` builds guarded `client.query` calls then `client.transaction(builtQueries)`); `node_modules/drizzle-orm/pg-core/query-builders/raw.js` (`PgRaw.getQuery()/_prepare()/mapResult`). `platform/db` / `prod-db-guard` are unmodified; `guardNeonClient` already covers `query`/`transaction`.


## Independent verification — 2026-10-29 (Codex)

> **Superseded in part by the owner's equal-permissions correction.** The run below predates that change, so
> any "employee money-redaction / manager-only review / employee vs manager preview split" observations in it
> no longer describe the current behavior (all authorized users now have the same import capability; the
> preview has a single shared Job-parts screen). The non-role findings (atomicity, idempotency, validation,
> image handling, build/types) still stand. Re-verification of the current code is pending the coordinator's
> run — not claimed here.

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

1. Owner reviews the Parts page and the single shared Job-parts flow. Per the owner's equal-permissions
   correction, turning on `PARTS_SCREENSHOT_IMPORT_ENABLED` makes this workflow available — with identical
   capability — to every authorized shop user (it also makes Parts visible to employees, independent of the
   legacy `PARTS_EMPLOYEE_VISIBLE` flag). The manual tracker's billing/sell/credit gates are unchanged.
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
