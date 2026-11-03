# Neon database credential rotation — HANDOFF (2026-11-03)

> **STATUS: SUPERSEDED — executed 2026-11-03 (Option A). See `docs/DB_CREDENTIAL_ROTATION_COMPLETED_2026-11-03.md`.**
> Corrections found during execution: `DATABASE_URL`/`DATABASE_URL_UNPOOLED` ARE project env vars (hidden by one listing tool), all 18 DB vars are Neon-store-managed yet editable in place, and Neon password resets are branch-scoped (not project-wide).
> Original pre-execution text follows unchanged.
>
> ~~**STATUS: NOT STARTED. Nothing has been rotated, revoked, deleted or changed.**~~
> Investigation is complete and read-only. Execution is **blocked on the owner choosing Option A or B**.
> This document contains **no passwords and no connection strings with secrets**.
> Keep it in the private repo. Dated facts below are **evidence from 2026-11-03 — re-verify before acting.**

Related, already finished and **not** part of this work: booking confirmation email is **COMPLETE and live**
(`docs/BOOKING_EMAIL_RELEASE_2026-11-03.md`). Do not reopen it.

---

## 1. Findings

**What the credential is.** Not a standalone variable. It is the **Neon Postgres role password for
`neondb_owner`**, the *owner* role of Neon project **`sweet-star-20785403`**, surfaced in Vercel as the
storage integration **`neon-indigo-prism`** (store `store_XLg6xNPWc7`, integration
`icfg_AvlEP0zfYZDD572sAvs2gwo5`, created 2026-07-10, plan Launch). The one password is embedded in
`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `PGPASSWORD`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`,
`POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL` and `POSTGRES_PASSWORD`. It is 16 characters.

**Blast radius.** Neon roles are **project-scoped**, so this password reaches **every branch** — production
`ep-morning-base-adq5h6rq` *and* the diverged `ep-bold-surf-adhsy8f5`. `neondb_owner` is the owner role:
full read/write/DDL over all business data.

**How it was exposed.** A `grep` of `.env.local` printed it in cleartext in a Claude Code session on
**2026-10-02**.

**It has NOT been rotated and is still active.** Evidence:
- All 13 DB-related Vercel project env vars report **created 2026-07-11, updated 2026-07-11** — untouched,
  and the exposure was 2026-10-02.
- The same credential still authenticates to production (live read round-trip, 2026-11-03).
- `.env.local` was rewritten 2026-10-05, but that was the Neon *branch repoint*, not a password reset.

**Clean:** the secret is **not in git history** and **not in any tracked repo file**. Every cleartext copy
below is git-ignored.

---

## 2. Affected systems

| # | System | Detail |
|---|---|---|
| 1 | **Production app (the only thing that matters at runtime)** | `platform/db.ts` reads `process.env.DATABASE_URL`. **`DATABASE_URL` is NOT a Vercel project env var** — it is injected at runtime by the Neon integration. Same env serves the crons in `vercel.json` (`/api/cron/appointment-notifications`, `/api/cron/finance-sync`). |
| 2 | **13 stale Vercel project env vars** | `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGPASSWORD`, `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL`, `POSTGRES_PRISMA_URL`, `NEON_AUTH_BASE_URL`/`NEON_PROJECT_ID`. Scope Production+Preview. **No runtime code reads any of them** (verified by grep) — legacy duplicates that will silently go stale. |
| 3 | **Local tooling** | `scripts/db-target.ts`, `drizzle.config.ts` (migrations), ad-hoc `tsx` queries, `app/api/mock-qb/*`, `app/api/vehicle-entry/pilot-*` — all via `DATABASE_URL`. |
| 4 | **Not affected** | Print bridge (own token). QuickBooks + Plaid (their tokens are encrypted *inside* the database, so they survive a password change). |
| 5 | **Scope** | The Neon store lists **one connected project**, `pitt-stop-internal`. No other app depends on it. |

### Files holding cleartext (all git-ignored; value omitted here)
- **13 `.env*` files**
  - `./.env.local`
  - `./.env.local.production-backup-20261002-075323`  ← created the day of the exposure; delete
  - `.env.local` in 11 worktrees: `/private/tmp/pitt-parts-always-open`,
    `/private/tmp/pitt-parts-always-open-release`, `/private/tmp/pitt-parts-release`,
    `~/Projects/.ps-worktrees/{appointments, booking-push, combine-invoices, dealership-manager,
    estimate-name-edits, marketing-system, parts-guided, receipt-payment-class}`
- **8 Claude transcript `.jsonl` files** under
  `~/.claude/projects/-Users-torlanpittman-Projects-pitt-stop-internal/` (incl. originating session
  `8ba21b06-…` and two subagent transcripts)
- **`.claude/settings.local.json` line 8** — a Bash **permission allowlist** entry that embedded the whole
  connection string when a command containing it was approved. Ignored via `~/.config/git/ignore`.

---

## 3. Option A — proposed sequence (RECOMMENDED, zero-downtime)

Chosen because it never revokes the live credential before a replacement is proven, and it stops the app
running as the database owner.

1. **Verify the assumptions in §4 first.** Several change the steps.
2. **Neon → create role** `app_prod` (name TBC). Record the new password straight into the target config —
   never into chat, a file in the repo, or a shell history line.
3. **Grant privileges** on the existing schema, and `ALTER DEFAULT PRIVILEGES` so future objects are usable:
   `CONNECT` on the database, `USAGE` on `public`, `SELECT/INSERT/UPDATE/DELETE` on all tables,
   `USAGE/SELECT` on all sequences. **Do not** make `app_prod` the object owner.
4. **Point the app at `app_prod`:** update `DATABASE_URL` (and `DATABASE_URL_UNPOOLED` if used) wherever the
   integration sources it — see assumption 4.1 — for **Production and Preview**.
5. **Redeploy** production. An env change does not reach an already-built deployment.
6. **Verify on the new role while the old credential is still valid** (§5). Do not proceed until green.
7. **Update local copies** — refresh the 13 `.env*` files, or delete the ones in stale worktrees.
8. **Only now reset the exposed `neondb_owner` password** in Neon. Keep `neondb_owner` as the
   admin/migration credential, **not** embedded in the app.
9. **Clean up the stale surface:** delete or update the 13 legacy project env vars (§2 row 2); delete
   `.env.local.production-backup-20261002-075323`; remove the `.claude/settings.local.json` allowlist line;
   decide on transcript scrubbing.
10. **Re-verify** (§5) and record the outcome in memory + this file.

**Option B (fallback, simpler, has a real gap):** reset `neondb_owner` in Neon, immediately update the
integration + env vars, redeploy. The old password dies the instant it is reset → expect a **~2–5 minute
window** where the running deployment cannot reach the database. Lower complexity, but it revokes before the
replacement is live. Only pick this in a genuinely quiet window.

---

## 4. Assumptions still needing verification

These were **not** confirmed during the read-only investigation. Check each before executing.

1. **Where `DATABASE_URL` is editable.** It is injected by the Neon integration and is *not* a project env
   var. Confirm whether it can be overridden by simply adding a project env var of the same name (and which
   wins), or whether it must change inside the integration/Neon. **This determines steps 4 and 9.**
2. **Whether the integration auto-syncs on a password reset.** Vercel-managed Neon stores often re-push
   connection strings. If it does, Option B gets simpler and the 13 legacy vars still will *not* update.
3. **Whether the 13 legacy vars are integration-managed or hand-created.** Created 2026-07-11, one day after
   the store — ambiguous. Affects whether to delete or update them.
4. **Whether `neondb_owner` is the only existing role** and whether Neon's Launch plan permits extra roles.
5. **Migration ownership.** Drizzle migrations create objects; if ever run as `app_prod`, ownership splits.
   Intended rule: **migrations run as `neondb_owner`, the app runs as `app_prod`** — confirm this works with
   the current migration tooling.
6. **Branch scope of a reset** — confirm in Neon that resetting the role password affects all branches
   (expected) and that nothing depends on the `bold-surf` branch.
7. **Preview deployments** — confirm Preview should move to `app_prod` too, or stay as-is.
8. **A quiet window** — confirm with the owner when shop traffic is low.
9. **Neon console access** — the owner must be signed in; the Neon MCP was deliberately stopped earlier
   (see memory `mcp-connectors-setup`), so this is browser/console work.

---

## 5. Verification (run after step 5, and again after step 10)

1. `node_modules/.bin/tsx scripts/db-target.ts` — prints endpoint, classification and a **live round-trip**.
   Expect endpoint `ep-morning-base-adq5h6rq`, classification PRODUCTION, write-guard ACTIVE.
2. `GET https://pitt-stop-internal.vercel.app/api/workflow/orders` — live board JSON, no auth needed.
3. Exercise one **write** path end to end (e.g. a booking through `book.pittstopdetailandautosales.com`,
   then cancel it) and confirm the row lands.
4. Confirm the next **cron** run succeeds (`/api/cron/appointment-notifications` 22:00 UTC).
5. Check Vercel **runtime logs** for connection/auth errors after the redeploy.

**Rollback:** the role password can be reset again and re-applied; Neon does not destroy the role. If
`app_prod` misbehaves on privileges, point `DATABASE_URL` back at `neondb_owner` (post-reset password) and
redeploy. **No migration is involved in this work**, so there is no schema rollback.

---

## 6. Do NOT

- Do **not** reset `neondb_owner` before the replacement is verified (that is Option B's known cost).
- Do **not** follow the older note in `docs/usability-cleanup-2026-10-01.md` on its own — it lists the seven
  URL env vars but **misses the integration-injected `DATABASE_URL`**, which is the one production uses.
- Do **not** print the password into chat, a file, or a shell command that lands in history.
- Do **not** treat the 2026-11-03 deployment ids, env timestamps or file lists as current — re-verify.

## 7. Approval / execution status

| | |
|---|---|
| Investigation | **Complete** (read-only, 2026-11-03) |
| Owner approval | **NOT GIVEN** — awaiting a choice of Option A or Option B |
| Execution | **NOT STARTED** — nothing rotated, revoked, deleted or changed |
| Recommendation | **Option A** |

Memory: `neon-credential-exposure` (detail), `outstanding-backlog` (this is the top security item),
`local-dev-uses-production-db` (branch safety).
