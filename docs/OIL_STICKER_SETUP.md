# Oil-Change Sticker Printing — Setup & Status

Last updated: **2026-10-30**. Feature implemented, NOT yet deployed; no physical QL-800 print has
been made yet.

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

## Shop-computer (Windows laptop `LAPTOP-RF8IO1H2`) setup — one-time, needs the owner

1. **Install the QL-800 Windows driver** (Brother support → QL-800 → "Printer Driver"; choose a
   driver-only install, P-touch Editor not needed). Plug in the QL-800 by USB.
2. **Turn OFF Editor Lite mode** — hold the printer's Editor Lite button until its green light
   goes out. (In Editor Lite mode the printer mounts as a USB drive and the Windows driver cannot
   print to it.)
3. **Load the DK-2212 roll** and feed/cut once so the printer detects it.
4. In **Printing Preferences** for the QL-800 driver set: paper **62 mm continuous**
   ("62mm x 100mm" / continuous tape format), **Auto Cut ON**, priority **Quality**. These are
   fallback defaults; each job also carries its exact 62 × 50 mm page size
   (SumatraPDF `noscale,paper=auto`).
5. **Add the label printer to the bridge config**: edit `C:\pittstop\print-bridge.config.json`
   and add one line inside the braces (the exact printer name as Windows shows it, usually
   `"Brother QL-800"`):
   ```json
   "LABEL_PRINTER_NAME": "Brother QL-800"
   ```
   Nothing else in the config changes. Without this line the bridge keeps working for checks and
   simply never receives sticker jobs.
6. **Run the bridge update** `PittStop-Bridge-Update-R3.cmd` (on the owner's Mac Desktop; embeds
   bridge **v2.1.0**, SHA-256 `d1706241a2911b…`). Same safety behaviour as R2: checks first,
   backup, stop supervisor+bridge together, replace one file, restart through the task, rollback
   on failure, token never shown. Expect `UPDATED OK`.
7. Verify in the app (checks screen or sticker form): bridge online, **v2.1.0**, and the sticker
   form shows "Label printer link online".

## What still needs a REAL printer to verify

Everything below is verified in code/tests only, not on hardware:

- SumatraPDF `-print-settings "noscale,paper=auto"` handing the 62 × 50 mm page to the QL-800
  driver at actual size (no scaling/clipping), and the auto-cut at the page edge.
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
