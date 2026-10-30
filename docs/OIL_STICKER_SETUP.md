# Oil-Change Sticker Printing — Setup & Status

Last updated: **2026-10-30**. Owner approved preview, migration 0066, deployment, and proceeding to
one sticker test. Migration 0066 is applied to verified production endpoint `ep-morning-base-adq5h6rq`.
Release verification: 2,636 tests / 212 files pass; webpack production build passes. The expiry
regression fails on the original code and passes after scoping sticker sweeps. Deployment and
physical QL-800 verification remain pending at this commit.

## What it is

"Print Oil Change Sticker" on the Job detail screen (all signed-in staff). A form prefills the
vehicle and the vehicle's last sticker mileage, takes current mileage + an editable interval
(miles and months, with manual overrides of the computed next-service values), shows an exact
print preview, and queues the sticker to the shop through the **existing cloud print queue**
(`print_jobs`, kind `sticker`). The Windows shop computer's print bridge claims it and prints on
the **Brother QL-800** over USB. Phones never talk to the printer.

Sticker layout (owner-approved mockup `docs/assets/oil-sticker-approved-mockup.png`): centered
black-and-white Pitt Stop logo, bold "Next service due", calendar icon + large bold date,
speedometer icon + large bold mileage. No vehicle details on the sticker (owner choice).
**62 mm wide × 50 mm cut length** on DK-2212 continuous film.

## Safety / independence model

- **Independent of money and completion.** No QuickBooks, no check records, no bank data; a failed
  sticker can never block Finish Job. Sticker jobs carry `check_id = NULL` and live in their own
  module (`apps/stickers/`).
- **Printer routing is explicit, by name, both ends.** The server offers `sticker` jobs ONLY to a
  bridge that declares a label printer (claim body `labelPrinter`); the deployed v2.0.1 bridge
  declares none, so it can never claim one. Bridge v2.1.0 prints stickers only to
  `LABEL_PRINTER_NAME` and checks only to `PRINTER_NAME` — never the Windows default printer. A
  sticker job reaching a bridge without a label printer is reported **failed**, never redirected.
- **No duplicates.** One waiting (queued/claimed) sticker job per order, enforced by a guarded
  insert AND the partial unique index `print_jobs_one_waiting_sticker_per_order` (migration 0066).
  Reprints are a separate explicit button.
- **No stale prints.** Queued jobs expire after 10 minutes (shared queue TTL) — a sticker sent
  while the shop computer is offline never pops out hours later; the app shows it as expired and
  it must be sent again deliberately.
- **Check printing untouched.** All check/MICR rendering, safeguards, and the CheckPrintPanel are
  unchanged; the claim route only gained kind dispatch, and `claimNextJob` defaults to the
  check-family kinds.

## Label stock (owner-confirmed 2026-10-30)

**Brother DK-2212** — continuous white FILM, 62 mm × 15.2 m. Printable width 58.9 mm (Brother
spec); content is kept inside a centered 56 mm band. Cut length 12.7–1000 mm; ours is 50 mm.

⚠️ **Material note:** DK-2212 is durable, water/smudge-resistant film — good for a windshield —
but its adhesive is **standard (permanent), not Brother's removable grade** (that is paper
DK-4205). On the inside of a windshield it will hold up well; expect it to need a firm peel and
possibly adhesive residue on removal. If easy removal matters more than durability, switch to
DK-4205 removable paper — the layout needs no change (same 62 mm width).

## Release order — migration 0066 BEFORE the code deploy

**Apply `drizzle/migrations/manual/0066_oil_stickers.sql` to production first, then deploy.** The code
declares `print_bridges.label_printer` (`apps/checks/schema.ts`), and `getBridgeStatus()` selects the
whole row — so if the code goes live before the column exists:

- `recordBridgeHeartbeat` fails on every bridge poll. The claim route swallows that error, so **checks
  still print**, but `last_seen_at` stops updating.
- `/api/checks/bridge-status` falls into its catch and answers `{ online: false, unknown: true }`.
- Net effect: **the checks screen reports the shop printer OFFLINE while it is actually working** — the
  wrong signal in the middle of a check run.
- The sticker form itself returns 500 (`labelBridgeStatus` has no catch).

0066 is additive and idempotent (`IF NOT EXISTS` throughout), 0066 is the next free number after 0065,
and the new partial unique index cannot collide with existing rows (its predicate needs `kind =
'sticker'`, which does not exist in production yet). The index build briefly blocks writes to `print_jobs` — apply it when no check is printing. Rolling the code back afterwards is safe:
the table and column are additive and inert without the app.

## Shop-computer (Windows laptop `LAPTOP-RF8IO1H2`) setup — one-time, needs the owner

1. **Install the QL-800 Windows driver** (Brother support → QL-800 → "Printer Driver"; choose a
   driver-only install, P-touch Editor not needed). Plug in the QL-800 by USB.
2. **Turn OFF Editor Lite mode** — hold the printer's Editor Lite button until its green light
   goes out. (In Editor Lite mode the printer mounts as a USB drive and the Windows driver cannot
   print to it.)
3. **Load the DK-2212 roll** and feed/cut once so the printer detects it.
4. In **Printing Preferences** for the QL-800 driver set the paper to an **exact 62 mm × 50 mm**
   format (create/select a 62 × 50 mm custom size if the list only offers "62mm × 100mm"), with
   **Auto Cut ON** and priority **Quality**.
   ⚠️ This form size is not cosmetic: the shop laptop runs **SumatraPDF 3.6.1**, which does **not**
   support `paper=auto`, so the printed page lands on **whatever form the driver has selected**.
   `noscale` keeps the content at true size, but a 62 × 100 mm form means the roll is cut long
   (blank film below the sticker). Match the form to the page and the cut matches too.
5. **Edit the bridge config** `C:\pittstop\print-bridge.config.json`:
   - **Back the file up first** (copy it to `print-bridge.config.json.bak` in the same folder).
   - Add these two lines inside the braces, keeping every existing field exactly as it is (use the
     printer name exactly as Windows shows it, usually `Brother QL-800`):
     ```json
     "LABEL_PRINTER_NAME": "Brother QL-800",
     "LABEL_PRINT_SETTINGS": "noscale"
     ```
   - `LABEL_PRINT_SETTINGS` overrides the bridge's built-in default of `noscale,paper=auto`, which
     SumatraPDF 3.6.1 does not understand. **No change to the bridge binary is needed** — the bridge
     reads this value from the config file.
   - Every line inside the braces except the last one needs a trailing comma.
   ⚠️ **Malformed JSON here takes CHECK printing down too**: the bridge logs `bad config json`,
   continues with an empty config, finds no base URL or token, exits, and the supervisor relaunches it
   in a loop. The config is read **only at process start**, which is why this step comes BEFORE the
   updater (the update is what restarts the bridge). Without these lines the bridge keeps printing
   checks normally and simply never receives sticker jobs.
6. **Run the bridge update** `PittStop-Bridge-Update-R3.cmd` — download it from the app:
   <https://pitt-stop-internal.vercel.app/downloads/PittStop-Bridge-Update-R3.cmd> (embeds bridge
   **v2.1.0**). Same safety behaviour as R2: checks first, backup, stop supervisor+bridge together,
   replace one file, restart through the task, rollback on failure, token never shown. Expect
   `UPDATED OK`. If it reports *"the bridge could not read its config"*, the JSON edit in step 5 is
   broken — restore the `.bak` and redo it.
7. Verify in the app (checks screen or sticker form): bridge online, **v2.1.0**, and the sticker
   form shows "Label printer link online".

## What still needs a REAL printer to verify

Everything below is verified in code/tests only, not on hardware:

- SumatraPDF 3.6.1 `-print-settings "noscale"` handing the 62 × 50 mm page to the QL-800 driver at
  actual size (no scaling/clipping) with the driver's form set to 62 × 50 mm, and the auto-cut
  landing at the page edge. Watch for a long cut (extra blank film) — that means the driver form is
  still 62 × 100 mm, fixable in Printing Preferences alone.
- Darkness/legibility of the logo + icons on DK-2212 film at 300 dpi.
- First physical test: owner approval required (use a real job's sticker with test values, or
  we add a VOID-style test print if wanted).

## Code map

- `apps/stickers/` — `calc.ts` (dates/miles math), `render.ts` (positioned layout, shared by
  preview + PDF), `pdf.ts` (hand-rolled PDF, embedded logo, vector icons), `logo-data.ts`
  (generated logo master), `queue.ts` (guarded enqueue on shared `print_jobs`), `service.ts`
  (validation, sticker rows, job status, render-at-claim), `schema.ts` (`oil_change_stickers`).
- Routes: `app/api/workflow/orders/[id]/oil-sticker` (+ `/status`); claim dispatch in
  `app/api/print-bridge/claim/route.ts`.
- UI: `app/orders/[id]/OilStickerSheet.tsx`, button in `OrderDetail.tsx`.
- Bridge: `scripts/print-bridge.mjs` **v2.1.0**; updater built by `scripts/build-bridge-update.mjs`.
- Migration: `drizzle/migrations/manual/0066_oil_stickers.sql` (additive).
- Assets: `apps/stickers/assets/` (original color logo preserved + print master + conversion
  script), `public/stickers/pitt-stop-logo-print.png` (UI preview).
