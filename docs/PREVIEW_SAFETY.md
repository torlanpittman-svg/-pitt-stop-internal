# Preview deployments — safety (2026-11-13)

A Vercel **preview** runs unreleased branch code. This project has one database branch and one set of file
stores, so a preview configured like production would let unreleased code read and change real data.

## What is enforced in code (fail closed)

`platform/preview-guard.ts`, called from `platform/db.ts` and every file-storage token reader:

| On a preview deployment… | Result |
|---|---|
| `APP_DATABASE_URL` is the known production endpoint | **every query refused** (reads included) |
| the database is not declared non-production (`DATABASE_ENV` unset/unknown) | **every query refused** |
| `DATABASE_ENV=preview` (or development/dev/test/staging) **and** a non-production endpoint | allowed |
| `PREVIEW_STORAGE_ISOLATED` is not `1` | **every file upload / read refused** |

Production (`VERCEL_ENV=production`) and local development are unaffected. Local writes to production stay
blocked by `platform/prod-db-guard.ts`. Nothing in a build or deploy runs migrations; the app role cannot run DDL.

`GET /api/health` returns a non-secret `environment` block (`vercelEnv`, `databaseTarget`, `databaseAccess`,
`storageAccess`, reasons, commit). It never returns a URL, host, token or setting value. Use it to check any
deployment.

## Documentation-only changes do not build

`vercel.json` → `ignoreCommand: bash vercel-ignore-build.sh`. The script skips a deployment only when every
file changed since the last successful deployment of that branch is `docs/**` or `*.md`. For a branch's first
deployment it compares against where the branch left `main`. Any doubt (no base, fetch failure, no diff) →
build. So a docs-only branch creates no preview, and a docs-only commit on `main` does not redeploy production.
A branch must contain this `vercel.json` (i.e. be based on a commit at or after this release) for the skip to apply.

## State verified on 2026-11-13

- Preview environment variables (names and targets only, read through the Vercel API): `APP_DATABASE_URL`,
  the Neon-managed `DATABASE_URL`/`PG*`/`POSTGRES_*` family, `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID` and
  `RECEIPTS_BLOB_READ_WRITE_TOKEN` are all set for **preview**. QuickBooks, Plaid, Postmark, OpenAI and
  `CRON_SECRET` are production-only. Crons run only on production.
- Whether the preview database value is the production endpoint is reported by the preview's own
  `/api/health` (`databaseTarget`) — see the release notes for the observed value.
- Previews are behind Vercel Authentication (`all_except_custom_domains`).

## To give previews working, isolated data (needs an owner decision — not done)

1. Neon: create a branch (e.g. `preview`) from production, or an empty one, and a role for it.
2. Vercel → Project → Environment Variables, **Preview** target only: set `APP_DATABASE_URL` to that branch and
   add `DATABASE_ENV=preview`. Leave Production untouched.
3. Vercel Blob: create a separate store; set `BLOB_READ_WRITE_TOKEN` and `RECEIPTS_BLOB_READ_WRITE_TOKEN` for
   **Preview** to it, and add `PREVIEW_STORAGE_ISOLATED=1`.
4. Apply `drizzle/migrations/manual/*.sql` to the preview branch as its owner.
5. Check the preview's `/api/health`: `databaseTarget: declared-non-production`, both accesses `allowed`.

Until then, previews build but cannot touch data — which is the intended safe state. Removing the production
database and storage variables from the Preview target entirely is a further hardening the owner can choose.

## Existing preview deployments

Previews built **before** this release do not contain the guard. Those built before the 2026-11-03 credential
rotation hold a database credential that no longer works; later ones can still reach production data as the app
role, behind Vercel Authentication and the app's own PIN/password gates. Deleting old preview deployments in
Vercel removes that exposure; it is the owner's call and is listed in the release notes.
