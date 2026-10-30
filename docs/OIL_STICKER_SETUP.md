# Oil-Change Sticker Printing — Setup & Status

Last updated: **2026-10-30**. Owner approved preview, migration 0066, deployment, and proceeding to
one sticker test. Migration 0066 is applied to verified production endpoint `ep-morning-base-adq5h6rq`.
Release verification: 2,636 tests / 212 files pass; webpack production build passes. The expiry
regression fails on the original code and passes after scoping sticker sweeps. Deployment and
physical QL-800 verification remain pending at this commit.

**Added after that (homepage quick print, local only):** a second entry point that needs **no
migration and no new schema** — it stores nothing of its own, keying everything on the shared
`print_jobs` row. Not deployed; no physical print.

## What it is

Two entry points, **one** sticker design, **one** calculation, **one** print queue:

1. **Job sticker** — "Print Oil Change Sticker" on the Job detail screen (all signed-in staff). A
   form prefills the vehicle and the vehicle's last sticker mileage, takes current mileage + an
   editable interval (miles and months, with manual overrides of the computed next-service values),
   shows an exact print preview, and queues the sticker. Records a row in `oil_change_stickers`
   (which is also the per-vehicle mileage history used for prefill).
2. **Quick sticker** — "Print Oil Change Sticker" on the **homepage**, for the common case where a
   car gets an oil change and nobody is going to open or create a job for it. Same form, same
   preview, same printer. It creates **no** job, customer, vehicle, or `oil_change_stickers` row —
   there is nothing to attach it to, and inventing one would put fiction in the Work Board and in
   the sticker history. Its print request *is* the record (see "Quick stickers" below).

Both queue the sticker to the shop through the **existing cloud print queue** (`print_jobs`, kind
`sticker`, printer target `label`). The Windows shop computer's print bridge claims it and prints on
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
  Reprints are a separate explicit button. Quick stickers have no order to key on and use a
  stronger rule instead — see below.
- **No stale prints.** Queued jobs expire after 10 minutes (shared queue TTL) — a sticker sent
  while the shop computer is offline never pops out hours later; the app shows it as expired and
  it must be sent again deliberately.
- **Check printing untouched.** All check/MICR rendering, safeguards, and the CheckPrintPanel are
  unchanged; the claim route only gained kind dispatch, and `claimNextJob` defaults to the
  check-family kinds.

## Quick stickers (homepage entry) — no job, and no way to double-print

- **No invented records.** No service order, customer, vehicle, or `oil_change_stickers` row. The
  queue payload carries the provenance explicitly: `quick.source = 'quick'`, the request token, the
  actor who asked, and the exact values printed. Its `payload.orderId` / `payload.stickerId` are the
  namespaced string `quick:<requestId>` — deliberately **not** a fabricated UUID — so a quick
  sticker is unmistakable and can never match an order-scoped queue lookup or the partial unique
  index above.
- **The request token is the print job's primary key.** The phone mints a UUID *before* the first
  attempt; the server inserts `print_jobs` with `id = <token> … ON CONFLICT (id) DO NOTHING`. So
  idempotency is **permanent**, not just "while the job is waiting": re-sending a token after the
  job reached submitted / failed / expired reports the ORIGINAL outcome and prints nothing.
- **Ownership.** The token comes from the client, so finding a row proves nothing: every read and
  every repeat verifies the job is a quick sticker belonging to the signed-in actor. Anything else
  (another person's quick sticker, a check job, an order's sticker job) answers a plain 404.
- **Uncertain dispatch never prints twice.** The request is written to `sessionStorage` *before* it
  is sent, with its resolved values and an explicit state. A lost response / reload / reopened
  dialog comes back as "outcome unknown", and the only action offered is a **status check of the
  same token**. A new token can only be minted from a resolved request. A 404 from the status route
  is not treated as proof that nothing printed — its retry re-sends the **same** token, which the
  server can accept only once. That logic is a pure, unit-tested module
  (`app/components/oil-sticker-quick-state.ts`).
- **Auth.** `/api/oil-sticker` and `/api/oil-sticker/status` are not in `proxy.ts`'s matcher (same
  as the job-sticker routes), so the handlers are the gate: `authenticatedActorFromRequest`,
  fail-closed 401. The homepage *button* is visible like the other module tiles.

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
   format in **Portrait** orientation (create/select a 62 × 50 mm custom size if the list only
   offers "62mm × 100mm"), with **Auto Cut ON** and priority **Quality**.
   ⚠️ This form size is not cosmetic: the shop laptop runs **SumatraPDF 3.6.1**, which does **not**
   support `paper=auto`, so the printed page lands on **whatever form the driver has selected**.
   `noscale` keeps the content at true size, but a 62 × 100 mm form means the roll is cut long
   (blank film below the sticker). Match the form to the page and the cut matches too.

   ✅ **This is the configuration the shop laptop is actually set to, and it is correct —
   Portrait, 62 × 50 mm. Do not "re-calibrate" it, change the form size, or change the print
   settings in step 5.** The PDF geometry (62 mm page width, computed cut length, logo and text
   positions in `apps/stickers/render.ts` / `pdf.ts`) is matched to exactly these settings; changing
   either side alone will put the sticker off the label.
5. **Edit the bridge config** `C:\pittstop\print-bridge.config.json`:
   - **Back the file up first** (copy it to `print-bridge.config.json.bak` in the same folder).
   - Add these two lines inside the braces, keeping every existing field exactly as it is (use the
     printer name exactly as Windows shows it, usually `Brother QL-800`):
     ```json
     "LABEL_PRINTER_NAME": "Brother QL-800",
     "LABEL_PRINT_SETTINGS": "noscale,disable-auto-rotation"
     ```
   - `LABEL_PRINT_SETTINGS` overrides the bridge's built-in default of `noscale,paper=auto`, which
     SumatraPDF 3.6.1 does not understand. **No change to the bridge binary is needed** — the bridge
     reads this value from the config file.
   - ✅ **`noscale,disable-auto-rotation` is the setting the shop laptop is actually running, and it
     is correct — keep it verbatim.** `noscale` prints at true size; `disable-auto-rotation` stops
     SumatraPDF from turning the tall 62 × 50 mm page sideways to "fit" the Portrait form, which is
     what lands the design square on the label.
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

The Windows side (driver form Portrait 62 × 50 mm + `noscale,disable-auto-rotation`) is settled and
must be left alone — see steps 4–5. Still **not** verified on hardware:

- Darkness/legibility of the logo + icons on DK-2212 film at 300 dpi.
- A physical sticker from the **homepage quick-print** path specifically (its PDF is byte-for-byte
  the same geometry as the job sticker — same `buildStickerPayload`/`renderStickerPdf` — so this is
  a confirmation, not a new calibration).
- Any further physical test needs owner approval. Nothing in the quick-print work printed
  physically: the browser/API checks were run against mocked routes with no database and no bridge.
  If a long cut (extra blank film) or a sideways sticker ever appears, it is the driver form or the
  `LABEL_PRINT_SETTINGS` line drifting from steps 4–5 — fix it there, never in the layout code.

## Code map

- `apps/stickers/` — `calc.ts` (dates/miles math), `render.ts` (positioned layout, shared by
  preview + PDF; optional `quick` provenance block), `pdf.ts` (hand-rolled PDF, embedded logo,
  vector icons), `logo-data.ts` (generated logo master), `queue.ts` (guarded enqueue + the
  token-keyed quick enqueue on shared `print_jobs`), `service.ts` (THE validation
  `validateStickerInput`, sticker rows, job status, render-at-claim), `quick.ts` (quick-sticker
  service: token idempotency + ownership), `schema.ts` (`oil_change_stickers`).
- Routes: `app/api/workflow/orders/[id]/oil-sticker` (+ `/status`) for a job;
  `app/api/oil-sticker` (+ `/status`) for a quick sticker; claim dispatch in
  `app/api/print-bridge/claim/route.ts` (unchanged — it is entirely payload-driven).
- UI: `app/components/OilStickerForm.tsx` (shared form, preview, status wording),
  `app/components/OilStickerQuickPrint.tsx` + `oil-sticker-quick-state.ts` (homepage entry and its
  tested request lifecycle), `app/orders/[id]/OilStickerSheet.tsx`, buttons in `OrderDetail.tsx`
  and `app/page.tsx`.
- Tests: `apps/stickers/quick.test.ts` (real Postgres via PGlite — idempotency, concurrency,
  ownership, check-queue isolation), `app/api/oil-sticker/route.test.ts` (auth + body contract),
  `app/components/oil-sticker-quick-state.test.ts` (recovery/duplicate-print rules).
- Bridge: `scripts/print-bridge.mjs` **v2.1.0**; updater built by `scripts/build-bridge-update.mjs`.
- Migration: `drizzle/migrations/manual/0066_oil_stickers.sql` (additive).
- Assets: `apps/stickers/assets/` (original color logo preserved + print master + conversion
  script), `public/stickers/pitt-stop-logo-print.png` (UI preview).
