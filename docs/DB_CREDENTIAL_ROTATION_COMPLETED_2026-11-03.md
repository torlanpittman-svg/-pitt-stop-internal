# Neon database credential rotation — COMPLETED (2026-11-03)

> **STATUS: DONE.** The exposed `neondb_owner` password no longer works on either Neon branch, production runs on a
> dedicated least-privilege role, and every local copy was reconciled. This file contains **no passwords**.
> Supersedes `docs/DB_CREDENTIAL_ROTATION_HANDOFF_2026-11-03.md` (the pre-execution investigation; keep for history).
> Booking confirmation email (`docs/BOOKING_EMAIL_RELEASE_2026-11-03.md`) was untouched and is still live.

## 1. What changed (Option A, zero downtime)

| # | Change | Where |
|---|---|---|
| 1 | New Postgres role **`pitt_stop_app`** (LOGIN, no SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS, no `neon_superuser` membership) created on the production branch `ep-morning-base-adq5h6rq` | Neon project `sweet-star-20785403`, created with SQL as `neondb_owner` |
| 2 | Grants: `CONNECT` on `neondb`; `USAGE` on `public`; `SELECT/INSERT/UPDATE/DELETE` on all 94 `public` tables; `USAGE/SELECT/UPDATE` on all sequences; `ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public` for future tables + sequences. **No `CREATE` on `public`** → DDL is denied (verified: `create table` → "permission denied for schema public"). Object ownership stays with `neondb_owner`. | Neon, production branch |
| 3 | Vercel project env **`DATABASE_URL`** (pooled) and **`DATABASE_URL_UNPOOLED`** edited in place to the `pitt_stop_app` connection strings (same hosts). Scope production + preview + development. These two vars are still *flagged* as managed by the Neon store `neon-indigo-prism` (`store_XLg6xNPWc73MxoLs`) — see §4 caveat. | Vercel project `pitt-stop-internal` (`prj_0IrwBtr7GKX9a0Knn69gr8bvRzYc`) |
| 4 | Production redeployed from the same commit `8ccaa1b` → **`dpl_482gFymi9pJYWz7xh7T89um31M6R`** (READY, PROMOTED, 16:41 UTC). | Vercel |
| 5 | **`neondb_owner` password reset** with `ALTER ROLE … WITH PASSWORD` on **both** branches (`ep-morning-base-adq5h6rq` production and the diverged `ep-bold-surf-adhsy8f5`), after step 4 was verified. Neon resets are branch-scoped, so both were done explicitly. | Neon, via SQL |
| 6 | Six Neon-store vars that embedded the dead owner password deleted from the Vercel project: `PGPASSWORD`, `POSTGRES_PASSWORD`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL`. No code on `origin/main` or in any worktree read them (grep-verified). Non-secret vars (`PGHOST*`, `PGUSER`, `POSTGRES_USER/HOST/DATABASE`, `PGDATABASE`, `NEON_*`, `VITE_NEON_AUTH_URL`) left alone; `PGUSER`/`POSTGRES_USER` still say `neondb_owner` (harmless, unused). | Vercel |
| 7 | **15 local `.env.local` files** (main checkout + 14 worktrees, all of which pointed at the production branch) rewritten: `DATABASE_URL`/`DATABASE_URL_UNPOOLED` → `pitt_stop_app`; the six owner-password vars removed; `PGUSER`/`POSTGRES_USER` → `pitt_stop_app`. Every file kept its branch (`ep-morning-base`) and its `DATABASE_ENV=production`, so the write-guard behaviour is unchanged. | local |
| 8 | **`.env.local.production-backup-20261002-075323` deleted** (the exposure-day copy). | local |
| 9 | **`.claude/settings.local.json`**: the one Bash allowlist entry that embedded the full owner connection string removed (243 entries remain). | local |
| 10 | Old password **redacted** (replaced by `[REDACTED-ROTATED-2026-11-03]`) in 8 Claude transcript `.jsonl` files, 2 Claude file-history snapshots and 1 Codex session file. Nothing else in those files was changed or deleted. | `~/.claude/…`, `~/.codex/…` |

**Not changed:** schema, migrations, app code, QuickBooks/Plaid (their tokens are encrypted inside the DB and survive a role
change), the Postmark booking email, the `bold-surf` branch data, the Neon store/integration itself, the `neon_auth` schema.

## 2. Verification evidence (all 2026-11-03 UTC)

Before the owner reset (production on `pitt_stop_app`, old credential still valid):
- `GET /api/workflow/orders` → 200, 304 jobs (744 KB).
- `GET /api/cron/finance-sync?diag=1` (bearer) → 200, `dbHost=ep-morning-base-…-pooler`, 3 Plaid items / 5 accounts / 1254 transactions.
- `GET /api/book/availability?services=mini_detail` on `book.pittstopdetailandautosales.com` → 200 `{ok:true, open:true}`.
- **Booking write:** `POST /api/book/drafts` (public branded host) → `{ok:true}`; row `28cdecfa-…` in `booking_drafts` (`TEST / Credential rotation check`, `follow_up_status=not_permitted` so no email can ever go out) + its `booking_draft_events` row. **Cleanup:** closed through the app's own staff function `setDraftStaffStatus(id,'closed')` (the Leads page action), itself executed as `pitt_stop_app` → `staff_status=closed`.
- **Background job write:** `GET /api/cron/finance-sync` with the cron bearer (the same call Vercel Cron makes) → 200 in 13 s: `fin_sync_runs` row written, Plaid balances/transactions refreshed (2 items, 0 added), obligations 44/118, inflows 22 rows, QuickBooks read-only sync `ok:true`. No QB transaction created, no email.
- Vercel runtime logs for `dpl_482gFymi…` (error + warning levels): **none**.
- Local: `tsx scripts/db-target.ts` → endpoint `ep-morning-base-adq5h6rq-pooler`, PRODUCTION, write-guard ACTIVE, live round-trip OK as **`role=pitt_stop_app`**.

After the owner reset:
- `neondb_owner` + **old** password → `password authentication failed` on **both** `ep-morning-base-adq5h6rq` and `ep-bold-surf-adhsy8f5`; new password works on both.
- `GET /api/workflow/orders` → 200; `finance-sync?diag=1` → 200 same host/counts; booking availability → 200; runtime logs still clean. Production target still `dpl_482gFymi…`.

## 3. Where credentials are managed now (values are NOT in this file)

| Credential | Lives in | Used by |
|---|---|---|
| `pitt_stop_app` (app role) | Vercel project env `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (prod+preview+dev); every local `.env.local` `DATABASE_URL` | The deployed app, Vercel crons, local `next dev`, `scripts/db-target.ts`, ad-hoc `tsx` scripts |
| `neondb_owner` (owner / migrations) | **Only** `DATABASE_URL_OWNER` in the main checkout's `.env.local` (git-ignored, mode 600) | `drizzle-kit` migrations: `DATABASE_URL="$DATABASE_URL_OWNER" ALLOW_PROD_DB_WRITES=1 npm run db:migrate`; any DDL/role work |
| Neon console / Neon-managed Vercel vars | **Do not know the new owner password** (it was set via SQL). The console's "Connect" string for `neondb_owner` is stale until someone clicks *Reset password* there — see §4. | — |

Rule: migrations run as `neondb_owner` (so new tables are owned by it and the default-privilege grants apply to `pitt_stop_app`
automatically); the app never runs as the owner. If a future migration creates objects as a *different* role, re-run the grants in §1 row 2.

## 4. Caveats and recovery

1. ~~Neon-store resync will overwrite `DATABASE_URL`~~ **CLOSED by the follow-up in §6 (same day):** the app no longer reads
   `DATABASE_URL` at all. A Neon-console *Reset password* or Vercel *Rotate secrets* still rewrites the Neon-managed vars
   (and recreates the six deleted ones) — that is now harmless to the app. Only `APP_DATABASE_URL` matters; it is hand-managed.
2. **Lost `pitt_stop_app` password:** as `neondb_owner`, `ALTER ROLE pitt_stop_app WITH PASSWORD '…'`, then update the Vercel vars
   + local files and redeploy. Lost **owner** password: Neon console → Roles → `neondb_owner` → Reset password (then caveat 1 applies).
3. **Rollback to the owner role** (only if the app role ever lacks a privilege): point `DATABASE_URL` at `DATABASE_URL_OWNER`'s value
   in Vercel and redeploy. Don't — fix the grant instead (`GRANT … TO pitt_stop_app`).
4. **Stale preview deployments** built before 16:37 UTC carry the dead owner URL and will fail on DB access; the next preview build is fine.
5. `vercel env pull` now pulls `pitt_stop_app` (not the owner) — and will never pull `DATABASE_URL_OWNER`; add it by hand to a new checkout only if it needs to run migrations.
6. Full-text search proved the old password is gone from every file under `~/.claude`, `~/.codex`, `~/Projects`, `/private/tmp`, shell histories and `~/.config`. The current session's own transcript never contained it.

## 5. Re-verify (any time)
```
node_modules/.bin/tsx scripts/db-target.ts        # expect role=pitt_stop_app, endpoint ep-morning-base-…
curl -s https://pitt-stop-internal.vercel.app/api/workflow/orders | head -c 200
```

## 6. Follow-up (2026-11-03, later the same day): app-owned connection variable

**Problem closed:** `DATABASE_URL` is managed by the Neon store, so any secret refresh would have put the owner credential
back into the variable the app read, silently restoring owner access on the next deploy.

**Change (scoped, commit on `main`):**
- New `platform/db-url.ts` — `appDatabaseUrl()` / `hasAppDatabase()` / `requireAppDatabaseUrl()` / `appDatabaseHost()` read
  **only `APP_DATABASE_URL`**. There is **no fallback** to `DATABASE_URL`: missing → throws a clear error (the message carries no
  credential). Tests in `platform/db-url.test.ts` pin the no-fallback behaviour.
- Every runtime connection path now goes through it: `platform/db.ts` (`getDb`, the only `neon()` constructor at runtime),
  `apps/quickbooks/db.ts` (3 presence checks), `apps/vehicle-entry/db.ts` + `invoice-db.ts`, `app/api/mock-qb/invoices`,
  the three `app/api/vehicle-entry/pilot-*` routes (demo-mode switches), and the `finance-sync?diag=1` host display.
  Without this, "demo mode" would also have keyed off the integration-managed variable.
- `platform/prod-db-guard.ts` classifies `APP_DATABASE_URL` first (then legacy `DATABASE_URL` for old local scripts) —
  classification only, still fail-closed; `scripts/db-target.ts` reads `APP_DATABASE_URL` and prints the role in the URL.
- **Migrations stay separate:** `drizzle.config.ts` requires `DATABASE_URL_OWNER` (owner role; local-only variable) and throws
  without it. Nothing migrates on the app role.
- Vercel: hand-managed `APP_DATABASE_URL` (production + preview + development, type encrypted, **not** store-managed) =
  the `pitt_stop_app` string. The Neon-managed `DATABASE_URL`/`DATABASE_URL_UNPOOLED` were left on the app role but are
  no longer read by the app. Local: `APP_DATABASE_URL` added next to `DATABASE_URL` in all 15 `.env.local` files
  (legacy ad-hoc `scripts/*.mjs` still read `DATABASE_URL`, which stays on the app role locally).

**Branch targets (verified via the per-target values, hosts only):** production, preview and development all →
`ep-morning-base-adq5h6rq` (the live branch). There is no separate preview/dev branch: `ep-bold-surf-adhsy8f5` is a
stale, diverged copy that nothing points at. Local write-protection is unchanged (`DATABASE_ENV=production` + the guard).

**Remaining limitations:** preview deployments built before this change carry whichever `DATABASE_URL` was baked at their
build time; those older than 16:37 UTC hold the dead owner password and will fail on DB access until rebuilt. The legacy
`scripts/*.mjs` helpers still read `DATABASE_URL` (app role locally) — fine, but they are not protected from a future
`vercel env pull` that re-imports the owner string into `DATABASE_URL`; `APP_DATABASE_URL` is never pulled from the store.

