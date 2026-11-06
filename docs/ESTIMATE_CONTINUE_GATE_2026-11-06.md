# New Estimate — "all information entered, but Continue does nothing" (2026-11-06)

**Report:** estimate form for Brian McDonald, every field visibly filled, Continue could not be clicked.

## What could and could not be inspected
- The form was not open in this Mac's Chrome (the only Pitt Stop tab was appointment PS-JHF6X2); no
  browser-automation session was reachable, so the live DOM was not inspected. Nothing was refreshed,
  navigated, cleared or submitted.
- Production (read-only): no customer, appointment, intake, estimate or job named McDonald exists, so the
  form had not been saved — consistent with a Details step that never got past Continue.

## Root cause (from the code at production `4886fd3`)
`app/quick-entry/QuickEntryFlow.tsx` serves both Quick Entry and **New Estimate** (`mode='estimate'`,
`/estimates/new`). Its Details-step Continue was a plain `disabled=` button with five silent conditions:
first name blank · a VIN read still in flight (`vinBusy`) · saved-vehicle picker unresolved
(`vehicleMode==='pick'`) · and, for an estimate, year must match `/^\d{4}$/` **untrimmed**, make and model
non-blank. None of them was shown on screen, so a form that *looks* complete stays stuck. The two ways a
visibly complete estimate form hits this:
1. **Year with whitespace** — phone keyboards append a space after a suggestion ("2019 "), or dictation
   adds punctuation. Make/model were trimmed; year was not. The standalone-estimate API has the same
   untrimmed regex (`apps/estimates/db.ts`), so even a client-side fix alone would then 400.
2. **Saved vehicle with no year/make/model on file** — selecting a returning customer's vehicle hides the
   year/make/model inputs, so there was nothing on screen to complete.
The other three conditions (first name, VIN read pending, vehicle pick) were equally invisible.

## Fix (branch `fix/estimate-continue`, worktree `Projects/.ps-worktrees/estimate-continue`, off origin/main 4886fd3)
- `app/quick-entry/continue-gate.ts` — ONE pure rule `continueBlockers()` that keeps every requirement and
  names what is missing (field + message); `normalizeVehicleText()` trims year/make/model.
- `app/quick-entry/ContinueBar.tsx` — Continue is always tappable; tapping with gaps lists each reason
  (`role=alert`), each line scrolls to its input; inputs get `aria-invalid` + a red outline.
- `QuickEntryFlow.tsx` — uses the gate; a saved vehicle missing year/make/model shows those inputs inline
  (same `vehicleId`, no duplicate vehicle); the vehicle text is trimmed before moving on and before POST.
- `apps/estimates/db.ts` — `year: z.string().trim().regex(/^\d{4}$/)` so the API judges the year the same way.
- No validation was weakened: a non-4-digit year, blank make/model/first name, a pending VIN read and an
  unresolved vehicle pick still stop Continue — now with the reason on screen.

## Verification
- `npx vitest run app/quick-entry apps/estimates apps/quick-entry` → 27 files / 361 tests pass
  (+ `intake-input-year.test.ts`, 2 tests). New: `continue-gate.test.ts` (10), `ContinueBar.test.tsx` (3).
- `tsc --noEmit`: 0 errors outside the 10 pre-existing in `apps/estimates/quickbooks.test.ts`.
- ESLint: new files clean; `QuickEntryFlow.tsx` has exactly the 11 pre-existing problems it had on origin/main
  (verified by linting the origin/main copy), none added.
- No migration, no flag, no production data, no sends, no push, no deploy. For Codex's independent review.

## Review corrections (Codex review of 89fef12 — two blocking findings, both fixed)
1. **Saved-vehicle editor vanished while typing.** Its visibility was derived from "year/make/model empty",
   so entering the first digit of a missing year hid the editor with an invalid year left behind. Now it is
   state (`savedEditOpen`) captured when the saved vehicle is chosen (open if `savedVehicleComplete()` is
   false — missing field OR a year that is not 4 digits), reopened the same way when a draft restores an
   incomplete saved vehicle, openable by hand via "Edit details", and closed only by choosing another
   vehicle / adding a new one. Typing never changes it. The selected vehicle id is kept throughout.
2. **Completed details were discarded.** `createIntake` recorded the saved row as-is. Now
   `apps/estimates/vehicle-completion.ts` (`completeSavedVehicle`) decides, per field: a valid saved value
   stays (never replaced by typed text — corrections belong to the Job's Edit Vehicle), a blank or
   non-4-digit year / blank make / blank model is filled from the intake; the VIN is never touched. The
   estimate's intake record (`quick_entry_jobs`) stores the completed vehicle, and the SAME `vehicles` row
   is updated inside the transactional batch with per-field SQL guards (`CASE WHEN year ~ '^[0-9]{4}$'
   THEN year ELSE …`, `COALESCE(NULLIF(btrim(make), ''), …)`), so a concurrent correction made after the
   row was read is kept, never overwritten. Audited like Edit Vehicle: `service_order_events`
   `vehicle_corrected` with `changed/old/new` per field (append-only). No duplicate vehicle is created.

### Verification after the corrections
- Full suite: `npx vitest run` → **248 files / 3,163 tests pass** (Codex's earlier run was 363 in the
  scoped modules; the scoped run is now 30 files / 373 tests).
- New/extended coverage: `apps/estimates/vehicle-completion.test.ts` (4: no-year, missing make+model,
  invalid "19" year corrected / valid year never replaced, complete vehicle untouched),
  `apps/estimates/intake-saved-vehicle-completion.test.ts` (4: vehicle id + VIN kept, intake stores the
  completed values, guarded in-place update, audit event; no write for a complete vehicle),
  `app/quick-entry/continue-gate.test.ts` (+2 for `savedVehicleComplete`).
- `tsc --noEmit`: 0 errors outside the 10 pre-existing in `apps/estimates/quickbooks.test.ts`.
- ESLint: new/changed files clean; `QuickEntryFlow.tsx` at exactly its 11 pre-existing problems.
- `next build --webpack`: see the line below.

### Remaining limitations
- Brian McDonald's live form was never inspected (not open in this Mac's Chrome, no automation session);
  his exact blocker is unconfirmed. The fix covers every condition that could silently block Continue.
- The saved-vehicle editor's "stays open while typing" behaviour is enforced by construction (state set
  only at selection / hydration / Edit details) and pinned by the pure-rule tests; there is no DOM-driven
  keystroke test in this repo's convention (no jsdom), so Codex may want a manual tap-through.
- Completing a saved vehicle writes `vehicles.year/make/model` only when blank/invalid; a wrong-but-valid
  saved value still needs the Job's Edit Vehicle (by design).
- `next build --webpack` after the corrections: passed (exit 0).
