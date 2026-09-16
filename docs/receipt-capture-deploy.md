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

## 1. Migration order + runner

Apply in order with the generic manual runner (splits on `;`, each statement idempotent):

```
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0038_business_receipts.sql
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0039_business_receipts_dedup.sql
node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0040_business_receipts_hardening.sql
```

- `0038` — `business_receipts` table (+ inline FK to `inventory_vehicles`, `ON DELETE SET NULL`).
- `0039` — partial UNIQUE index on `image_hash WHERE status <> 'rejected'` (upload idempotency).
- `0040` — `processing_token` column (extraction-attempt ownership) + `expense_rate_events` table (durable rate limiting).

All three are re-runnable (verified against real Postgres in `apps/expenses/*.integration.test.ts`).

## 2. Preflight checks (run BEFORE 0039)

`0039` builds a UNIQUE index and **will fail if pre-existing active duplicates exist**. On a fresh
install there are no rows, so it passes. If `business_receipts` already has data, run this preflight and
STOP if it returns any row — do **not** delete or merge rows to force the index:

```sql
SELECT image_hash, count(*) AS n
FROM business_receipts
WHERE status <> 'rejected'
GROUP BY image_hash
HAVING count(*) > 1;
```

Resolution if it returns rows: a manager reviews the duplicates and **rejects** all but one per hash
(rejected rows are excluded from the index), then re-run `0039`. Never auto-delete historical rows.

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

## 5. Application rollback (RETAINS receipts, evidence, audit history)

To roll back, **revert the application code** (redeploy the prior build). Do **NOT** drop the tables —
that would destroy receipts + audit history + stored evidence references.

The schema is purely additive, so the prior application build simply ignores the new tables/columns.
Leave `business_receipts`, `expense_rate_events`, the FK, the unique index, and `processing_token` in
place. No data migration is needed to roll back.

If (and only if) a specific additive object must be removed for an unrelated reason, these are safe and
do not touch receipt rows:

```sql
-- optional, additive-object removal only — NOT part of a normal rollback:
DROP INDEX IF EXISTS business_receipts_hash_active_uniq;   -- reverts upload-idempotency (0039)
DROP TABLE IF EXISTS expense_rate_events;                  -- reverts rate limiting (0040)
-- Do NOT drop business_receipts or the processing_token column: they hold receipts/evidence/attribution.
```

## 6. Partial / interrupted migration recovery

Every statement is `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, so a migration that stops midway is
recovered by simply **re-running the same file(s)** in order — already-applied statements are no-ops.
After re-running, verify:

```sql
SELECT 1 FROM information_schema.columns WHERE table_name='business_receipts' AND column_name='processing_token';
SELECT indexname FROM pg_indexes WHERE tablename='business_receipts' AND indexname='business_receipts_hash_active_uniq';
SELECT 1 FROM information_schema.tables WHERE table_name='expense_rate_events';
SELECT conname FROM pg_constraint WHERE conname LIKE 'business_receipts_%veh%';
```

A stuck extraction lock (a receipt left in `status='processing'` by a crashed retry) self-heals: the
next retry reclaims it after a 3-minute stale window (with a fresh attempt token), and the old attempt's
late result is dropped by the token guard. No manual intervention needed.

## Rate limits (scope · window)

Durable, server-enforced (table `expense_rate_events`), bucketed by the **server-verified actor**
(shared devices fall back to a hashed IP — never a forwarded header as the sole identity for an
authenticated user):

- Upload: **60 / 10 min** per actor.
- AI extraction (retry) per manager: **30 / 10 min**.
- AI extraction (retry) per receipt: **10 / hour**.

These are distinct from the per-receipt extraction ownership lock (which prevents *concurrent* AI calls;
the limits prevent *repeated* ones). Exceeding a limit returns a clear `429` / retry-after message.
