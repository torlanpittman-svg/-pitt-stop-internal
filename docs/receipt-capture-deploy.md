# Business Receipts — deployment & migration runbook

Additive, reversible-safe rollout for the general business-receipt capture module
(`apps/expenses`, routes under `/expenses` + `/api/expenses`). **No production step is executed by
code review or CI — an operator runs these deliberately.**

## 0. Prerequisites / configuration (no secrets in the repo)

Set in the production environment BEFORE deploying (or the feature hard-fails closed, which is intended):

| Env var | Purpose |
|---|---|
| `RECEIPTS_BLOB_READ_WRITE_TOKEN` | Read/write token for a **separate, PRIVATE** Vercel Blob store. Distinct from the public `BLOB_READ_WRITE_TOKEN` (Auto-Sales public receipts). Never falls back to the public store. |
| `OPENAI_API_KEY` | Vision extraction (already used elsewhere). |
| `DATABASE_URL` | Postgres (already set). Never a production URL in tests. |
| PIN identity envs | `PIN_DARRYL/PIN_TONY/PIN_TORLAN/PIN_BART` (+ `EMPLOYEE_PIN` for shared devices) — unchanged; the module reuses the existing manager identities. |

Create the private Blob store as a **new store** (do not repurpose the public one). Retrieval is
server-side only through `/api/expenses/receipt/[id]/image`; no public URL is ever issued.

### PROVISIONED (production) — status
- Project: **pitt-stop-internal** (`prj_0IrwBtr7GKX9a0Knn69gr8bvRzYc`), production branch **main**.
- Private receipt store: **`pitt-stop-receipts-blob`** (`store_RGBv1NrcmWiSyq4H`, access **private**),
  connected to the project with env-var prefix `RECEIPTS_BLOB` → the store-managed variable
  **`RECEIPTS_BLOB_READ_WRITE_TOKEN`** (Vercel manages the value; no human ever copies it).
- The existing public store **`pitt-stop-internal-blob`** (`store_7AC7k9nGMmV5HiOk`) and its
  `BLOB_READ_WRITE_TOKEN` are **UNCHANGED** (verified: same env-var ids before/after). Auto-Sales
  receipt capture (which uses the public `uploadPhoto`) is unaffected.
- Free/Hobby plan (no payment method); Blob free-tier limits apply. Receipt images are ≤4 MB and
  server-downscaled for AI, so usage stays well within the free tier.

## 1. Migration order + runner

Apply in order with the generic manual runner (splits on `;`, each statement idempotent):

```
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0038_business_receipts.sql
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0039_business_receipts_dedup.sql
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0040_business_receipts_hardening.sql
```

- `0038` — `business_receipts` table (+ inline FK to `inventory_vehicles`, `ON DELETE SET NULL`).
- `0039` — partial UNIQUE index on `image_hash WHERE status <> 'rejected'` (upload idempotency).
- `0040` — `processing_token` column (extraction-attempt ownership) + `expense_rate_counters` table (durable ATOMIC rate limiting).

All three are re-runnable (verified against real Postgres in `apps/expenses/*.integration.test.ts`).

## 2. Preflight checks (run BEFORE applying anything)

Run the **read-only** preflight — it modifies nothing, detects fresh-vs-existing, reports which additive
objects are missing, and STOPS (exit 2) if pre-existing active duplicates would make `0039` fail:

```
node scripts/receipts-migrate-preflight.mjs
```

It prints a `GO` / `NO-GO` plan. On a fresh install it confirms "apply 0038 → 0039 → 0040". On an existing
table it lists exactly the missing items and runs the duplicate check only after confirming the table
exists. It reports **counts only** (never receipt contents) and never runs DDL.

`0039` builds a UNIQUE index and **will fail if pre-existing active duplicates exist**. On a fresh install
there are no rows, so it passes. The equivalent manual query (what the preflight runs) is:

```sql
SELECT image_hash, count(*) AS n
FROM business_receipts
WHERE status <> 'rejected' AND image_hash IS NOT NULL
GROUP BY image_hash
HAVING count(*) > 1;
```

Resolution if it returns rows: a manager reviews the duplicates and **rejects** all but one per hash
(rejected rows are excluded from the index), then re-run the preflight. Never auto-delete/merge rows.

## 3. Upgrade path — table already created WITHOUT the FK

`CREATE TABLE IF NOT EXISTS` (0038) will NOT add a missing FK to an already-created table. If the table
predates the FK, add it once (idempotent; run in `psql` — NOT via the `;`-splitting runner, which cannot
execute a `DO` block):

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_receipts_inv_veh_fk') THEN
    ALTER TABLE business_receipts
      ADD CONSTRAINT business_receipts_inv_veh_fk
      FOREIGN KEY (inventory_vehicle_id) REFERENCES inventory_vehicles(id) ON DELETE SET NULL;
  END IF;
END $$;
```

Application-level validation (`db.inventoryVehicleExists`) independently blocks a nonexistent vehicle id
at review/approve time, so integrity holds even before the FK is added. (Upgrade verified in
`apps/expenses/migration.integration.test.ts`.)

## 4. Deploy order + gating

1. Set env vars (§0) and create the private Blob store.
2. Apply migrations §1 (with preflight §2 / upgrade §3 as needed).
3. Only then deploy the application build.

Prevent automatic deploy before prerequisites: keep the feature on `receipt-capture-work` and merge to
the deploy branch **after** migrations + env are in place. The code itself fails closed if a prerequisite
is missing (private token unset → uploads 502; no phantom success), so a premature deploy degrades safely
rather than corrupting data — but the intended gate is "migrate + configure, then merge/deploy."

## 4b. Isolated preview validation (do this FIRST, before production)

Goal: exercise the real routes end-to-end in a deployed environment that **cannot read or write
production data**. Nothing here is a production step.

**Isolation requirements (all four must hold):**
1. **Separate database** — a throwaway Postgres (e.g., a new Neon *branch* or a fresh dev database), NOT
   the production `DATABASE_URL`. Apply 0038→0039→0040 to it.
2. **Separate private Blob store** — a distinct `RECEIPTS_BLOB_READ_WRITE_TOKEN` for a preview-only private
   store, NOT the production private store and NOT the public `BLOB_READ_WRITE_TOKEN`.
3. **Scoped env** — set these on the **Preview** environment only (Vercel env scope = Preview), never
   Production. Confirm the Preview scope does not inherit production `DATABASE_URL` / Blob tokens.
4. **No live externals** — leave QuickBooks disabled (`QB_LIVE`/`QUICKBOOKS_ENABLED` off in Preview); this
   module never calls QuickBooks regardless. Use synthetic receipt images only.

Preview environment variables (NAMES only — set real values in Vercel's Preview scope, never in the repo):

```
DATABASE_URL                     # → throwaway/branch DB (NOT production)
RECEIPTS_BLOB_READ_WRITE_TOKEN   # → preview-only private Blob store
OPENAI_API_KEY                   # extraction (a test key or the existing one; usage is metered)
IDENTITY_SECRET / ADMIN_PASSWORD # session signing (any preview value)
PIN_DARRYL / PIN_TONY / ...      # a manager PIN so review/approve is reachable in preview
```

**Test plan (synthetic only):**
- Capture: upload a synthetic JPEG at `/expenses` as an employee session → lands in the review queue.
- Fail-closed: hit `/expenses/review` and `/api/expenses/receipt/[id]/image` with no session → 401/403.
- Review: as a manager, correct fields, associate a vehicle, **approve** → appears in the monthly summary
  (labeled export-ready, not synced).
- Evidence: the review image loads only via the gated route; the original bytes/hash are preserved.
- Idempotency: re-upload the same synthetic bytes → one receipt (duplicate response).
- Rate limit: exceed the upload/retry limits → clear 429/retry-after.
- Retry ownership: trigger a retry; confirm it does not overwrite a manager correction.
- Confirm no QuickBooks/network side effects occur.

Automated equivalents of all the above already pass in CI-free local tests (unit + real-Postgres
integration); the preview run validates the deployed wiring + env scoping specifically.

## 4c. Isolated preview — provisioning status & exact procedure

Verified against the live Vercel project (read-only): project `pitt-stop-internal` (team `pitt-stop`),
**production branch = `main`**, GitHub `torlanpittman-svg/-pitt-stop-internal`. Branch pushes/PRs create
**SSO-protected** Preview deployments (team-login gated); pushing `receipt-capture-work` does NOT deploy
production. A preview can also be deployed **without pushing** via `vercel deploy` from this worktree.
Plan = **Hobby, no payment method** (so nothing can silently incur cost). **Critical:** the Neon
`DATABASE_URL` and public `BLOB_READ_WRITE_TOKEN` are scoped to Production **and** Preview — i.e. previews
currently SHARE the production DB + public store — so the preview MUST override these per-branch.

**Already provisioned (all Free plan, $0; both UNCONNECTED → zero production/env impact):**
- Empty **Neon** DB `receipts-preview-db` — resource id `store_0ilebuHeqbLLomnC` (external Neon project
  `patient-scene-49638485`), plan **Free** (`free_v3`, no credit card). Fresh project = empty (no
  production data copied; NOT a branch). Provisioned with `--no-connect` (no env vars created).
- Private **Blob** store `receipts-preview-priv` — id `store_XMF59Z0yiQ5DKXWA`, access **private**,
  unconnected (production public store `pitt-stop-internal-blob` untouched).
- Test credentials in the macOS Keychain (service `pittstop-receipt-preview`, accounts `ADMIN_PASSWORD` /
  `IDENTITY_SECRET` / `PIN_TONY`). Retrieve locally: `security find-generic-password -a <ACCT> -s pittstop-receipt-preview -w`.

**Remaining blocker — secure value handoff (one owner step):** the two resource SECRET VALUES (the Neon
connection string and the private-Blob RW token) cannot be read by the CLI token (marketplace secrets API
returns 403), and *connecting* the resources to Preview would OVERWRITE the shared Preview `DATABASE_URL`/
`BLOB_READ_WRITE_TOKEN` (disallowed). So the owner retrieves both from the dashboards and stores them in the
Keychain (their terminal — never in chat); the agent then reads them to apply schema, set BRANCH-scoped
env, deploy, and test. Dashboards:
- Neon connection string: `https://vercel.com/pitt-stop/~/stores/store_0ilebuHeqbLLomnC` (pooled `DATABASE_URL`).
- Blob RW token: `https://vercel.com/pitt-stop/~/stores/blob/store_XMF59Z0yiQ5DKXWA`.

```
security add-generic-password -a PREVIEW_DATABASE_URL   -s pittstop-receipt-preview -w '<neon-conn-string>' -U
security add-generic-password -a RECEIPTS_BLOB_TOKEN    -s pittstop-receipt-preview -w '<blob-rw-token>'   -U
```

**Then (once the empty DB exists) — set BRANCH-SCOPED Preview env for `receipt-capture-work` only** (so
other previews are unaffected; branch-scoped values take precedence over the shared Preview values):

```
# DB — point ALL vars the app reads at the new empty DB (override the shared production DB):
vercel env add DATABASE_URL          preview receipt-capture-work   # (paste in the secure prompt, not chat)
# (also override POSTGRES_URL / POSTGRES_URL_NON_POOLING / DATABASE_URL_UNPOOLED if used by the runner)
# Private receipt storage — the dedicated store's RW token (connect the store to Preview→branch, or set):
vercel env add RECEIPTS_BLOB_READ_WRITE_TOKEN preview receipt-capture-work
# Isolated identity/admin (override production ADMIN_PASSWORD/IDENTITY_SECRET for this branch):
vercel env add ADMIN_PASSWORD        preview receipt-capture-work   # value: keychain ADMIN_PASSWORD
vercel env add IDENTITY_SECRET       preview receipt-capture-work   # value: keychain IDENTITY_SECRET
vercel env add PIN_TONY              preview receipt-capture-work   # value: keychain PIN_TONY (test manager)
vercel env add OPENAI_API_KEY        preview receipt-capture-work   # a restricted TEST key, or omit (manual fallback)
```

Apply the schema to the empty DB. **IMPORTANT — do NOT run only 0038–0040 on an empty DB:** `0038`'s FK
references `inventory_vehicles(id)` and the review picker joins `vehicles`, which are created by EARLIER
migrations. Two cases:

- **Preview (empty DB):** apply the FULL app schema first, in order — the drizzle base migration
  (`drizzle-kit migrate`, which creates `vehicles` and the core tables) then every manual file
  `0001 … 0037` (which includes `0029_auto_sales_b0.sql` → `inventory_vehicles`), THEN `0038 → 0039 → 0040`.
  (Minimal alternative for a receipts-only preview: create `vehicles` + `inventory_vehicles` from the
  workflow/auto-sales schema, then 0038–0040.)
- **Production (existing DB):** the app schema already exists — apply ONLY `0038 → 0039 → 0040`.

```
node scripts/receipts-migrate-preflight.mjs        # confirms fresh vs existing; GO / NO-GO
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0038_business_receipts.sql
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0039_business_receipts_dedup.sql
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0040_business_receipts_hardening.sql
```

**Deploy the preview WITHOUT pushing** (SSO-gated; uses the branch/Preview-scoped env):

```
vercel deploy --scope pitt-stop        # preview URL; NOT production (main only)
```

**VERIFY EFFECTIVE ISOLATION BEFORE ANY WRITE** (do not trust that CLI git metadata picked the branch
config): on the deployed preview, confirm it points at the empty DB and the private store — e.g. the review
queue is empty (no production receipts), and a health/echo of the resolved `BLOB_STORE_ID` / DB host (never
the secret) differs from production. Only then run the write tests. Run the §4b synthetic test plan.

**Cleanup (after validation):**
```
# delete the private test store:
curl -s -X DELETE -H "Authorization: Bearer <cli-token>" \
  "https://api.vercel.com/v1/storage/stores/blob/store_XMF59Z0yiQ5DKXWA?teamId=<team>"   # or: vercel blob delete-store store_XMF59Z0yiQ5DKXWA
# remove the branch-scoped preview env vars:
vercel env rm DATABASE_URL preview receipt-capture-work   # (repeat for each var added)
# remove keychain test creds:
security delete-generic-password -s pittstop-receipt-preview   # (repeat per account)
# delete the throwaway Neon DB + keychain values:
vercel integration resource remove receipts-preview-db --yes --scope pitt-stop
security delete-generic-password -s pittstop-receipt-preview     # removes all preview test secrets
# remove the local link: rm -rf .vercel
```

## 5. Application rollback (RETAINS receipts, evidence, audit history)

To roll back, **revert the application code** (redeploy the prior build). Do **NOT** drop the tables —
that would destroy receipts + audit history + stored evidence references.

The schema is purely additive, so the prior application build simply ignores the new tables/columns.
Leave `business_receipts`, `expense_rate_counters`, the FK, the unique index, and `processing_token` in
place. No data migration is needed to roll back.

If (and only if) a specific additive object must be removed for an unrelated reason, these are safe and
do not touch receipt rows:

```sql
-- optional, additive-object removal only — NOT part of a normal rollback:
DROP INDEX IF EXISTS business_receipts_hash_active_uniq;   -- reverts upload-idempotency (0039)
DROP TABLE IF EXISTS expense_rate_counters;                -- reverts rate limiting (0040)
-- Do NOT drop business_receipts or the processing_token column: they hold receipts/evidence/attribution.
```

## 6. Partial / interrupted migration recovery

Every statement is `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, so a migration that stops midway is
recovered by simply **re-running the same file(s)** in order — already-applied statements are no-ops.
After re-running, verify:

```sql
SELECT 1 FROM information_schema.columns WHERE table_name='business_receipts' AND column_name='processing_token';
SELECT indexname FROM pg_indexes WHERE tablename='business_receipts' AND indexname='business_receipts_hash_active_uniq';
SELECT 1 FROM information_schema.tables WHERE table_name='expense_rate_counters';
SELECT conname FROM pg_constraint WHERE conname LIKE 'business_receipts_%veh%';
```

A stuck extraction lock (a receipt left in `status='processing'` by a crashed retry) self-heals: the
next retry reclaims it after a 3-minute stale window (with a fresh attempt token), and the old attempt's
late result is dropped by the token guard. No manual intervention needed.

## Rate limits (scope · window · atomicity)

Durable, server-enforced, **ATOMIC** (table `expense_rate_counters`), bucketed by the **server-verified
actor** (shared devices fall back to a hashed IP — never a forwarded header as the sole identity for an
authenticated user). Checked **after authentication, before any Blob/AI work**.

- Upload: **60 / 10 min** per actor. Bucket `upload:actor:<key>` (or `upload:shared:<ip-hash>`).
- AI extraction (retry) per manager: **30 / 10 min**. Bucket `extract:actor:<key>`.
- AI extraction (retry) per receipt: **10 / hour**. Bucket `extract:rcpt:<receiptId>`.

**Mechanism (atomic):** one row per `(bucket, window_start)`; a single statement both increments and
enforces the cap —

```sql
INSERT INTO expense_rate_counters (bucket, window_start, count) VALUES ($bucket, $wStart, 1)
ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < $limit
RETURNING count;
```

The `ON CONFLICT DO UPDATE` takes a **row lock**, so concurrent independent connections serialize on the
counter row and exactly `limit` succeed per window (a rejected attempt returns no row and does **not**
consume budget). This needs **no interactive transaction** — the Neon HTTP driver has none.

**Window:** fixed windows aligned to the epoch (`floor(now/window)*window`). A burst can reach `limit` on
either side of a boundary (≤ 2× across it) — the standard trade-off for single-statement atomicity.
`retry-after` points at the next boundary. Bounded cleanup: each admitted call prunes this bucket's earlier
window rows (`window_start < current`), so the table stays small.

**Test limitation (important):** the integration tests run on **PGlite**, an in-process Postgres that
**serializes** execution — they validate the atomic SQL + `ON CONFLICT` semantics and that a burst of
overlapping calls never exceeds the limit, but they do **not** exercise independent OS-level parallel
connections. The concurrency guarantee rests on Postgres's documented single-statement `ON CONFLICT` row
locking (not on the test harness). A future check with a real multi-connection Postgres server (docker/
Neon branch) could demonstrate parallel-connection safety directly.

## Storage integrity (private receipt blob)

Uploads are **immutable** (`allowOverwrite:false`, `addRandomSuffix:false`) to a private store via the
dedicated `RECEIPTS_BLOB_READ_WRITE_TOKEN`. On a write conflict (concurrent create, or a re-upload of
already-stored bytes) the pathname is reused **only after byte verification**: the existing object is
fetched server-side (bounded size + 5 s timeout, namespace-restricted) and its **length + SHA-256 must
exactly match** the incoming original. Any mismatch / missing object / retrieval failure fails safe — the
original write error is rethrown and **no evidence is overwritten or deleted**. No error-message matching;
bytes, tokens, URLs, and SDK errors are never logged.
