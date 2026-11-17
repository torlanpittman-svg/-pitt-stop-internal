# "Attended — estimate declined" — implementation handoff (2026-11-17)

**Status: LOCAL SOURCE ONLY — NOT deployed, NOT pushed, migration 0081 NOT applied to production.**
Branch `codex/appointment-estimate-declined` (worktree off remote-main baseline `d87b702`). No live database
was connected during this work; database tests used fictional embedded PGlite fixtures.

**Review round 2 applied.** Codex's independent review found the first draft could commit
`status='declined'` while a concurrently Won/job-linked lead stayed unchanged (returned as a
`lead:'conflict'` partial success), and that a dangling lead reference proceeded as `'missing'`. Both
are corrected: the operation is now fail-closed — **the decline and the linked lead's move to Lost
commit together or nothing is written**, and a dangling lead reference refuses with a clear error.

**Verification state: reviewed and verified locally by Codex on 2026-11-17.** Final full suite: **265 files / 3,479 tests passed**. Final production build (webpack, including TypeScript) passed. Scoped ESLint passed on all 14 changed TypeScript files. Source fingerprints were unchanged throughout the final checks. This is ready for owner approval of migration + production release, not a live-release claim.

## What it does

A manager/admin records that a customer **attended** their confirmed drop-off, received an estimate, and
**declined** it. One fail-closed atomic statement marks the appointment `declined`, marks the linked
marketing lead **Lost**, writes the append-only `appointment_events` (`estimate_declined`) and canonical
`marketing_events` (`lead_updated`) audits, and retires the appointment's pending notices. No Job, no
invoice, or customer email is created by this action. Full behaviour spec: `docs/APPOINTMENTS.md`
("Attended — estimate declined").

## Changed files

| File | Change |
|---|---|
| `drizzle/migrations/manual/0081_appointment_estimate_declined.sql` | NEW — extends `appointments_status_chk` with `'declined'`; idempotent **and wrapped in BEGIN/COMMIT** so a failed ADD cannot leave the table unconstrained; no new columns, no privilege change |
| `apps/appointments/schema.ts` | status comment lists `declined` |
| `apps/appointments/db.ts` | NEW `declineEstimate()` (fail-closed, lock-ordered — see below) + `DeclineLeadOutcome` (`'lost' \| 'none' \| 'already'` only); `addInternalNote` accepts `declined` |
| `apps/appointments/checkin.ts` | claim UPDATE re-checks `status IN ('confirmed','arrived')` (kept per review); refusal reports the real terminal status |
| `apps/appointments/notify.ts` | `staleReason`: confirmation/reschedule stale when `declined`; never a "missed send" |
| `apps/appointments/public.ts` | `PublicAppointment.status` union includes `declined` |
| `app/appointments/labels.ts` | staff badge "Attended — estimate declined" (neutral tone) |
| `app/appointments/actions.ts` | NEW `declineEstimateAction`: manager gate inside the action (same `manager()` helper as cancel/reschedule), explicit `typeof` checks on id and reason, UUID check, trims then **rejects** a >300-char reason; revalidates `/appointments`, `/appointments/[id]`, `/marketing/leads`, `/marketing/report`, `/marketing`; no dispatch |
| `app/appointments/[id]/AppointmentActions.tsx` | decline button + inline form: `aria-labelledby` heading, visible optional Reason label, 48px targets, pending-disabled submit, `role=status` success / `role=alert` error, `aria-expanded/controls`, focus moves to the Reason field on open; success copy for complete outcomes only; Check-in button gains `min-w-48` so the row wraps readably beside the new long button; `checkinStarted` prop. Check-in/vehicle-selection flow untouched |
| `app/appointments/[id]/page.tsx` | passes `checkinStarted`; History shows the decline reason + "lead marked Lost" |
| `app/book/a/[token]/page.tsx` | customer-safe copy: "Visit completed — no work scheduled" |
| `docs/APPOINTMENTS.md` | behaviour section |
| Tests | `apps/appointments/decline.integration.test.ts`, `apps/appointments/decline-checkin-race.integration.test.ts` (fixture now carries the real `vehicles` columns so the claim race is actually reached), `app/appointments/decline-action.auth.test.ts`, additions to `app/appointments/[id]/AppointmentActions.test.tsx` |

## The fail-closed statement (apps/appointments/db.ts)

Consistent lock order, one parameterized statement:

1. `appt` CTE — `SELECT … FOR UPDATE` on the appointment with **every** eligibility condition in its
   WHERE (`confirmed`, `service_order_id IS NULL`, `checkin_started_at IS NULL`).
2. `lead` CTE — `SELECT … FOR UPDATE OF l` on the linked lead (`status <> 'won'`, `service_order_id IS NULL`),
   joined off the **locked appointment row's** `marketing_lead_id` — never the stale preflight object, so
   a re-linked lead can never cause the wrong row to be updated.
3. A gate (`ok`) passes only when the appointment is locked AND (no lead is linked OR the lead is
   locked-and-eligible). Both UPDATEs, both audits and the notice sweep run `FROM` that gate.

PostgreSQL semantics this relies on (READ COMMITTED, identical in PGlite): `FOR UPDATE` waits for a
concurrent writer, then re-evaluates its conditions on the **newest** row version; a row that no longer
qualifies drops out, the gate comes up empty, and the statement writes nothing. Locks acquired by the
CTEs are held to commit, so the subsequent updates cannot be raced after the gate passed. Both locking
CTEs are marked `MATERIALIZED` so the planner cannot inline away their evaluation. This operation acquires locks in appointment → lead order. A database error aborts the whole statement; no successful partial outcome is returned.
The preflight reads exist **only** for clear error messages; on refusal the function re-reads fresh
state to say exactly why (already declined → `'already'` replay; claimed/cancelled/job-linked;
Won/job-linked lead; dangling lead reference → explicit "fix the lead link" conflict).

Outcomes: `'lost'`, `'none'` (no linked lead — stated, not claimed), `'already'` (idempotent retry —
no second audit, never touches a lead a manager has since changed). **No partial success exists**; the
former `'missing'`/`'conflict'` success variants are removed from the type, the UI and the audit meta.

## Independent verification

- Appointment suite after the review corrections: 16 files / 275 tests passed.
- Final `npm test`: 265 files / 3,479 tests passed (49.68s, exit 0).
- Final `NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build --webpack`: exit 0; webpack, TypeScript and static generation passed.
- ESLint: all 14 changed/new TypeScript files, exit 0. `git diff --check` passed.
- Red/green proof: copied the implementation and test to a disposable directory, restored only the first-draft decline function, and ran the new lead-turns-Won regression. It failed for the expected reason: the old function returned `declined` + `lead:'conflict'` instead of refusing. The final full suite verifies the corrected function. The actual worktree was never reverted for this proof.
- Browser verification used the actual `AppointmentActions` component and Tailwind CSS with mocked actions and fictional data. Desktop and 390px phone layouts, opening focus, pending-disabled submit, conflict/error, success announcement, and terminal-action hiding were checked. No browser console errors. This fixture is not a live end-to-end database test.
- UI proof: `/Users/torlanpittman/.codex/visualizations/2026/11/07/01a1b77e-9b9b-7df3-84d5-fed488f3340e/appointment-declined-preview.jpg` and `appointment-declined-result.jpg`.
- Temporary verification logs: `/tmp/pitt-declined-final-tests.log`, `/tmp/pitt-declined-final-build.log`, `/tmp/pitt-declined-lint.log`, `/tmp/pitt-declined-red-proof.log`.
- Claude Code implementation/review session: `9e1e35d0-322b-4443-86ad-0993b862797c`, both runs exit 0, no permission denials. Codex independently inspected the actual diff and ran the checks.
- PostgreSQL reference for the locking review: [Read Committed / SELECT FOR UPDATE](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED), [data-modifying WITH statements](https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-MODIFYING).

## Risks / limits

- PGlite runs one connection, so true multi-session lock contention can't execute in tests; the forced
  interleave exercises the exact reviewed window (preflight → write) deterministically, and the
  correctness argument rests on the documented `FOR UPDATE` re-evaluation semantics, which are the
  same engine semantics on Neon.
- A declined appointment drops out of the "New online bookings" alert (that list is `confirmed`-only) —
  intended: it was handled in person.
- Migration 0081 must be applied (owner-approved, deliberate) **before** deploying this code; until then
  a decline fails closed on the check constraint (no partial write).
- Deploy follows the established non-standard flow (scoped worktree off `origin/main`, FF push,
  deliberate migration) — owner approval required; nothing in this session touched production.

## Release boundary

Approval is still required for the scoped production push/deployment and applying migration 0081 to the verified production database. Apply the constraint migration before releasing the app. There is no backfill and no automatic change to an existing appointment or lead. No customer send/test inquiry is required. After any use of the new status, retain the expanded constraint during rollback; do not rewrite outcomes to cancellations or delete audit history. Prefer a forward correction if a live issue is found.
