# Check Printing — Status and Handoff

Last updated: **2026-10-13**.

Stock: **Blue Summit BSS-92588-301** — genuinely blank, 3-part perforated, check in the TOP position,
3.5" check section (first perforation 3.5" from the top), no preprinted MICR. This is the stock actually
in use (owner-confirmed 2026-10-12). Earlier revisions of this file said a "replacement MICR-compliant
stock" had superseded it; that was wrong and has been removed.

Path: Pitt Stop OS (phone) → cloud print queue → Windows shop-laptop bridge (`LAPTOP-RF8IO1H2`,
`C:\pittstop`, SumatraPDF `noscale`) → Brother HL-L2420DW.

## Purchase payload fix — deployment approved 2026-10-13

Owner attempted check10356 (Test/$1). QBO Purchase400/code2010 rejected unsupported property.
Live read-only state: one failed check10356, not_printed, operating sequence10357. Number10356 is
reserved for this durable intent; do not reset/release it or start over. No retry or print authorized.
Root cause: nested EntityRef under AccountBasedExpenseLineDetail is unsupported in Intuit schema;
top-level Purchase.EntityRef remains correct. Scoped local fix removes nested field only. New mocked
payload tests failed2/passed14 before correction; full suite after fix 134files/1387tests passed,
webpack production build passed. Failed-screen copy corrected to reserved number / same-check retry,
without blanket assurance that ambiguous failures cannot have reached QBO. Requestid/recovery unchanged.
No real QuickBooks write or print performed during diagnosis. Owner approved deployment only; no assistant retry or print. Production base7c0c93a.
After verifying new deployment READY, owner opens Check history →10356 →Retry QuickBooks.
This reuses the saved check and number. Printing remains a separate owner action.
Schema: https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/AccountBasedExpenseLineDetail.html

## Login fix live — 2026-10-13, 12:29 PM Central

Production commit **7c0c93ace49e7798c3e853a79e55dfdb7acdf5fd**, Vercel
**dpl_5zY5dDaViChMZdCf9zeLAQZxr2ge READY**, production alias confirmed through Vercel API.
Read-only live GET /api/checks without credentials: JSON401, NO Basic challenge; admin setup
still returns Basic challenge. Local signed-session tests prove Torlan reaches real handler with
mocked financial service; employees denied. Full suite 1,378 tests, typecheck and build passed.
Live/MICR ON, realm pinned, bridge online v2.0.1, QBO active production, zero checks, next10356.
No check created or printed. Owner can cancel old dialog, refresh and enter/confirm on phone.
Status handoff through deployment approval committed in 7c0c93a; this post-deploy verification
is a local follow-up pending the next scoped release. Earlier deployment-pending notes are superseded.

## Manager password-prompt fix — deployment approved 2026-10-13

Owner hit native Basic-Auth prompt while recording as Torlan. Root cause: proxy operational classifier
matched /api/checks/ descendants but missed exact /api/checks, so GET/POST root fell to admin gate.
Release worktree contains one-line exact-match fix in proxy.ts, plus proxy.test.ts and
app/api/checks/route.test.ts (real signed fake sessions/proxy/handler; financial service mocked).
Red reproduction: 8 failed / 17 passed; after fix full suite 134 files / 1,378 tests passed,
production webpack build passed. Ordinary employee denied; admin setup/specimen stay admin-only.
No check route/service/printing code changed. Read-only production check after owner attempt: zero
checks, next 10356; live/MICR remain enabled. No real test transaction or print sent.
Owner explicitly approved deploying this fix, without any check creation or printing.
Pre-deployment production base: 5d0f6b0. Verify the resulting Vercel deployment before claiming live.

## Owner-approved enablement — 2026-10-13, 12:18 PM Central

Owner explicitly authorized enabling real checks and MICR, with no check recording or printing.
POST /api/admin/checks/setup with only micrEnabled=true and liveEnabled=true returned 200/ok.
Independent GET verified liveEnabled=true, micrEnabled=true, micr.ready=true, config ready, and
realmPinned=true (production QBO). Bridge online v2.0.1, exact Brother printer. Operating sequence
still 10356, recent checks zero. No check/print endpoint was called; no check or print was initiated.
The owner will enter payee/amount/purpose and confirm on their phone. Refresh /checks first.
Then Record & Print Check records to QBO; separate Send Check to Shop Printer sends the physical job.
Auto Sales sequence remains uninitialized. Older OFF/unpinned notes below are historical and superseded.
Owner declined bank-reader visit as a prerequisite; acceptance remains unverified, not claimed proven.

## Latest release — 2026-10-13

Owner-approved screen-only deployment: **`5d0f6b07cfe338ff77c24e2a7117c4ecde5811f5`**, fast-forward from
`f88c079`. Vercel **`dpl_14tLcSByixAJNDbtPrjPD6cTwRpP`** is READY and aliases include
`pitt-stop-internal.vercel.app`. Authenticated read-only GET `/checks` returned 200 with the updated
review button, dark background, history navigation and wrapping long text.

- Dark mobile-first form/review; long payees wrap; recent cards separate identity from actions;
  accessible navigation and on-screen print toolbar. Printable check geometry/CSS is unchanged.
- Preserved production `CheckPrintPanel` and its paper confirmation/stuck-job/reprint safeguards.
  Recent checks use View / Print to the detail page, not direct reprint. Eight check handlers,
  two print handlers and printable markup were compared byte-for-byte with the production base.
- Verification: full suite **132 files / 1,353 tests passed**, explicit typecheck, production webpack
  build, diff whitespace check, isolated mocked browser checks at phone/desktop widths, review and
  recorded/error states. No production POST was used for verification.
- **No check created, print queued, QuickBooks write, migration, bank/config/flag change.**
- Release worktree: `/Users/torlanpittman/.codex/worktrees/check-screen-release/pitt-stop-internal`,
  branch `codex/check-screen-release`. Main checkout has unrelated work and older check logic:
  never copy its check files wholesale over production; transplant scoped changes from origin/main.
- This handoff and local instruction/memory edits are saved locally for the next scoped release;
  they were not part of the two-file UI commit. The status document is included with the subsequent
owner-approved manager-login fix; local instruction and memory files remain local.

**Evidence freshness:** runtime flags, sequence, counts and QBO readiness below are historical
2026-10-12 observations, not reverified by this UI deployment. Read them live before enabling or
issuing anything. Owner subsequently confirmed **exactly one specimen printed**. The supplied Windows
TempCheck screenshot reports **CLEAN: 0 leftover folders, 0 files, 4 temp folders checked, 0 unreadable,
bridge v2.0.1**. Bank-reader acceptance remains unverified. Do not repeat a specimen or cleanup step
merely because an older handoff says it is pending.

## Where things stood — 2026-10-12 historical verification

- **Previous production release was `f88c079`** (`origin/main`, deployed 2026-10-12, owner-approved; Vercel
  deployment `dpl_28vzy6xyRuYs3N3PxWvmv1FtSkLK`, READY). It adds the six-digit MICR check number, the
  admin-only bank specimen print, and records bridge v2.0.1 + the Windows updater. The production build
  (`next build --webpack`) passed on that exact commit, with a clean tree, before the fast-forward push
  from `55a8234`. Migration `0050_check_print_safety.sql` is applied; this release has no migration.
  (Earlier the same day `55a8234` was redeployed unchanged so the bank numbers took effect.)
- **Bank numbers are live in the server environment and validate.** `/api/admin/checks/setup` reports
  `secretsPresent`, `routingValid` (9 digits, ABA checksum passes), `accountValid`, `fontInstalled` — all
  true — with masks routing `••••5995`, account `••••2649`. The account mask matches the operating
  account. Values were never read or displayed. "Valid" means well-formed; it does **not** prove the
  account number is written the way American Momentum encodes it on a check (see "Not yet established").
- **MICR is OFF** (`micr_enabled`), **live recording is OFF** (`checks_live_enabled`), the QuickBooks
  company is **not pinned**, production has **0 checks**. So `micr.ready` is false and no negotiable line
  can print.
- **VOID test from the phone app PASSED twice (owner, 2026-10-12)** on the Blue Summit stock: once
  through the v1 bridge, once through bridge v2.0.1 after the update. **The owner approves the visual
  layout**, MICR line (E-13B test line of zeros) included. Both VOID jobs still show `submitted` in the
  queue — nobody tapped "it printed" in the app; harmless.
- **Visual approval is not bank-reader acceptance.** Nothing printed so far has been read by a bank or a
  MICR reader.
- Compatible **MICR toner is installed**. The free **GnuMICR** E-13B font is deployed and loads.
- **Bridge v2.0.1 is installed, VOID-tested, and reboot-tested** (see "Windows bridge").
- **QuickBooks (production) verified read-only 2026-10-12:** connection `active`, environment
  `production`, no last error. Operating bank = Account 31 "Pitt Stop Detail *2649" (Bank/Checking,
  active); Auto Sales bank = Account 48 "Pitt Stop Auto Sales *5600" (active). Category accounts, all
  active: customer_job → 16 "Cost of Goods Sold:Job Supplies"; shop_general → 51 "Supplies";
  equipment → 112 "Equipment" (fixed asset); auto_sales → 88 "Cost of Goods Sold:Reconditioning";
  owner_personal → 21 "Owner's Pay & Personal Expenses" (equity); other → 20 "Ask My Accountant".
  `readiness.ready` is true with no missing category accounts. No QuickBooks write was made.
- **Operating check sequence = #10356 (owner-approved 2026-10-12), not consumed.** The owner stated the
  highest operating-account check used, handwritten included, is 10355. Conflict check before the change:
  production QuickBooks has no Purchase and no BillPayment numbered 10345–10999 (10356 queried exactly:
  none); Pitt Stop has 0 check records. Changed from 20000 → 10356 through `/api/admin/checks/sequence`
  (`force`, because it lowers the number). **Audit trail:** the `check_sequence` row records
  `updated_by = Admin`, `updated_at = 2026-10-12T21:42:09Z`; the previous value (20000, set 2026-09-10 by
  Admin) is recorded only here. The deployed code has no append-only log for sequence changes — add one
  with the next approved deploy.
- **Future collision to remember:** QuickBooks already holds operating-account checks **#13043–13047**
  (Feb–Mar 2026, a different check series). The sequence reaches them after ~2,687 checks; the write path
  stops on a number that already exists on the same bank account, but the sequence should be moved past
  that block before then. Handwritten checks 10345–10355 are not in QuickBooks yet.

## Next steps, in order

1. ~~Bank numbers in Vercel~~ — done. ~~Bridge update~~ — done. ~~VOID test through the new bridge~~ —
   done. ~~Reboot test~~ — done. ~~Redeploy + masked verification~~ — done (all 2026-10-12).
2. ~~Starting check number~~ — done: 10356 (2026-10-12).
3. **Validate the real MICR line and bank acceptance** — see "MICR / bank acceptance — where it stands".
   Specimen deployment, exactly one physical specimen and Windows TempCheck CLEAN are complete.
   Reader acceptance has not been verified; do not claim visual approval proves it.
4. Turn on `micr_enabled`, then go live through the `/api/admin/checks/setup` interlock (it refuses
   unless everything is ready, and pins the production QuickBooks company). Each needs owner approval.
5. **First real check only on explicit owner authorization**, after the owner designates payee, amount,
   and check number. Then verify exactly one QuickBooks transaction and the matching paper check.

## MICR / bank acceptance — where it stands

**Confirmed by the owner against a real American Momentum check (2026-10-12), digits never shared:**

- The full account number on the check matches what was entered in Vercel, **including all leading
  zeros**. (The app keeps leading zeros: the number is handled as text end to end; covered by a test.)
- The check number in the bank's MICR line is **six digits with a leading zero** (e.g. 10355 reads
  010355).

**Not explicitly confirmed:** the field order (check number / routing / account) and the exact position
of the On-Us symbol after the account. The app prints `⑈check#⑈  ⑆routing⑆  account⑈`; the bank's reader
test settles both.

**Deployed in `f88c079` (2026-10-12). Exactly one specimen printed, owner-confirmed.**

1. **Six-digit check number in the MICR line.** Code before `f88c079` printed 10356 as five digits. The
   change zero-pads the Auxiliary On-Us check number to six (`MICR_CHECK_NUMBER_MIN_DIGITS` in
   `apps/checks/micr.ts`): 10356 → `010356`. Padding grows the field to the left only; the last digit
   stays at position 46 and nothing to its right moves. The number printed on the check face is not
   padded. The approved VOID test line (five zeros) is unchanged.
2. **Bank specimen print.** `POST /api/admin/checks/specimen` (**admin only**: the proxy requires
   `ADMIN_PASSWORD` and the handler itself refuses any non-admin identity, manager PIN sessions included;
   requires the body `{ "confirm": "PRINT BANK SPECIMEN" }`) sends one page to the shop printer carrying the **real**
   routing/account line with check number **000000**, on the approved layout, with
   `VOID - BANK TEST SPECIMEN - NOT NEGOTIABLE` across the face, a large `VOID` over the signature line,
   and VOID in the payee, amount, and amount-in-words fields — all solid black and all above the 5/8"
   MICR clear band, which carries only the MICR line. It:
   - works with `micr_enabled` **off** (that switch still gates negotiable checks; a real check is still
     refused);
   - creates no check record, writes nothing to QuickBooks, takes no check number (10356 stays unused);
   - never stores the bank numbers — the line is built at the moment the bridge claims the job, and the
     job is refused if the numbers or the font are not valid then;
   - **cannot be duplicated by a retry or double-click:** one atomic "slot" (a single `app_settings` row,
     `check_specimen_slot`, taken with an upsert Postgres evaluates against the latest committed row)
     lets exactly one request through per 10 minutes; anything else in that window gets the first job
     back — even after it has printed. A request that fails before queuing gives the slot back;
   - is recorded as a `print_jobs` row of kind `specimen` with who and when.
   No database migration. `apps/checks/pdf.ts` and `apps/checks/layout.ts` (geometry, rendering) are
   untouched.
3. `scripts/check-specimen-preview.ts` renders the specimen locally with **placeholder** numbers for
   layout review.

**The specimen PDF is sensitive (real bank numbers). Where it can and cannot exist:**

- Not in the database: the queued job holds only a placeholder; the line is built in memory when the
  bridge claims the job.
- Not in logs: only the job id and requester are logged; refusal reasons carry no data.
- Not in any browser or public storage: it is returned once, over HTTPS, to the token-authenticated bridge
  (`Cache-Control: no-store`), never to a web page; the admin route returns booleans and a job id only.
- On the laptop: a temp file only while printing — deleted by bridge v2.0.1 afterwards (see the temp-PDF
  gate) — and transiently in the Windows print spooler.
- On paper: the specimen itself. Treat the printed page like a voided check: hand it to the bank or shred
  it.

Verified before deploy: full suite 1353/1353 (new tests: six-digit padding, leading zeros kept, specimen
contents, nothing stored, nothing in the clear band, no check/QuickBooks/number side effects, refusals,
eight simultaneous requests → one job, retry after printing → same job, admin-only route), `tsc` clean,
production build clean, and a rendered preview (placeholder numbers) inspected by eye.

Verified in production after deploy (2026-10-12, read-only plus refused requests — no specimen sent):

- Vercel reports the production deployment READY on `f88c079`.
- Specimen route: no credentials → 401; wrong admin password → 401; forged employee cookie → 401; admin
  without the confirmation phrase → 400 and nothing queued; admin GET → readiness booleans only (all
  true), `Cache-Control: no-store`. A real manager PIN session was not tried live; that refusal is
  covered by the route test and by the proxy's admin gate.
- `liveEnabled` false, `micrEnabled` false, realm not pinned; masks unchanged (`••••5995` / `••••2649`);
  layout offsets 0/0, section 3.5", top position.
- Operating sequence still 10356 (row unchanged since 21:42:09Z); 0 checks; 0 specimen jobs; no print
  job created since the bridge VOID test; the specimen slot row does not exist yet.
- Bridge `LAPTOP-RF8IO1H2` online, v2.0.1.

**One bank specimen sent (owner-approved, 2026-10-12):** job `13ea8e38-83fa-41c7-9c6a-3e24752334ee`, kind
`specimen`, requested by Admin at 22:07:00Z, one request, no retry. Claimed by `LAPTOP-RF8IO1H2` at
22:07:02Z; `submitted` at 22:07:32Z (the job left the Windows print spooler — not proof of paper). The
stored job holds only the placeholder (no MICR cells). Afterwards: 1 specimen job in total, 0 checks,
sequence still 10356, MICR and live recording still off. **Owner confirmed exactly one page came out and supplied a CLEAN Windows TempCheck result.
Bank-reader validation remains unverified.**

**Owner follow-up (recorded 2026-10-13):** exactly one specimen printed; Windows TempCheck CLEAN
(0 folders/files, 4 temp folders inspected, 0 unreadable, bridge v2.0.1). The bank request given
to the owner: ask American Momentum treasury management / deposit operations for a MICR print-quality
test of one VOID specimen on the operating account (••••2649), run on magnetic item-processing equipment
(a teller image scanner alone reads optically and does not test the toner), confirming: no rejects;
routing, full account number with leading zeros, and six-digit check number each read into the correct
field; symbol placement and field order match their specification for this account; signal strength and
position within tolerance (ANSI X9.100-160-1 / X9.100-20); how many specimens they require; whether new
check stock must be registered (incl. Positive Pay); and a written result with name and date.

**Still outstanding:**

1. ~~Commit, deploy, verify~~ — done (`f88c079`).
2. ~~One specimen and Windows TempCheck~~ — done, owner-confirmed; do not resend.
3. **The bank's reader verdict on that specimen** (American Momentum branch / treasury services):
   character recognition, toner signal strength, field order, and position — including the two known
   geometric risks: characters sit on the bottom line of the 3/16"–7/16" band with no downward tolerance,
   and the Blue Summit border near the 5/8" clear band. **Bank-reader validation is NOT done.**
4. Optional: a MICR position gauge (clear overlay) before the bank visit.

A MICR-only adjustment, if the bank asks for one, goes through `micr_layout` and needs owner approval.

## Do not change

Approved by the owner on paper. Preserve as is:

- Letter page (8.5×11), 3.5" top check section, check in the top position
- SumatraPDF `noscale` (100%, actual size) printing and the Brother print path
- Global `offsetX = 0`, `offsetY = 0`
- Every non-MICR field: company block, date, payee, numeric and written amount, bank name, memo,
  signature line, check number
- The current MICR line: GnuMICR at 12 pt, baseline 3/16" (0.1875") above the perforation (3.3125" from
  the page top), fixed positions from the right edge (`micr_layout` = baseline 0.1875, right margin
  0.3125, amount field 1.625, pitch 0.125, size 12)

A MICR-only adjustment, if a reader test ever calls for one, goes through `micr_layout` (below) and
needs the owner's approval. It never touches the non-MICR fields.

## Not yet established

- **Bank / MICR-reader acceptance** of the printed line: font, toner signal strength, and position have
  only been judged by eye.
- **Vertical tolerance.** At the approved baseline the 0.117"-tall characters sit on the bottom line of
  the standard 3/16"–7/16" MICR band, with no downward tolerance. Not gauge-checked.
- **Blue Summit bottom border vs. the 5/8" MICR clear band** — untested.
- **American Momentum's MICR layout:** account digits (with leading zeros) and the six-digit check number
  are owner-confirmed against a real check; field order and symbol placement are not.
- **Real bank information printed on one non-negotiable specimen**, owner-confirmed; no bank-reader result.
- **QuickBooks `requestid` de-duplication** is covered by tests against a stub, not against QuickBooks.
- Auto Sales (*5600) check sequence is uninitialised, so Auto Sales checks stay fail-closed.
- **Append-only audit for check-sequence changes** — does not exist (the row keeps only the last who/when).
  Needs a small table + migration in a later approved deploy. The 20000 → 10356 change is recorded in this
  document only.
- **Windows temporary-PDF cleanup inspection passed** (owner screenshot); see latest evidence above.

## Windows bridge — v2.0.1 installed and verified (2026-10-12)

**How the bridge actually runs on the laptop** (owner-supplied evidence, 2026-10-12):

```
scheduled task PittStopPrintBridge
  -> wscript.exe "C:\pittstop\start-bridge.vbs"          (exits immediately)
  -> hidden  cmd /c C:\pittstop\start-bridge.bat          (the SUPERVISOR: an endless loop)
  -> node print-bridge.mjs >> C:\pittstop\bridge.log      (relative path; relaunched 5 s after it exits)
```

So killing `node` alone only makes the supervisor start another, and starting the task while a supervisor
is alive creates a second bridge. Anything that restarts the bridge must stop supervisor and node
together and start exactly one.

**Result (owner + production evidence, 2026-10-12):**

- Updater R2 succeeded on the laptop; a physical VOID test through the new bridge succeeded.
- The owner then rebooted the laptop and logged in without starting the bridge by hand.
- Production `/api/checks/bridge-status` at 4:21 PM Central (checked by Codex), and the `print_bridges`
  row re-read afterwards: bridge `LAPTOP-RF8IO1H2`, online, **version 2.0.1**, started
  `2026-10-12T21:20:16.767Z` (after the reboot), printer `Brother HL-L2420DW Printer`, heartbeat current.
- So on real Windows: R2 runs, v2.0.1 prints through SumatraPDF `noscale`, and auto-start survives a
  reboot.

**Temporary check PDFs — verification status:**

- **Proven by really running bridge v2.0.1 (on macOS, 2026-10-12):** with jobs that print and jobs whose
  print command fails, the PDF exists only while printing and its folder is gone afterwards; folders left
  by an earlier run are swept at startup; unrelated temp folders are untouched.
- **Observed on the laptop: CLEAN**, as shown in the owner screenshot. `PittStop-Bridge-TempCheck.cmd` (4,246 bytes, SHA-256
  `8fc8ca445831f7d2…`; on the owner's Mac Desktop **and uploaded 2026-10-12 to the owner's Google Drive,
  My Drive, "Owned by me", not shared** — file id `1yH5Nzl3kOr-L1iE1DTMORfqFidREM3JQ`; built with
  `node scripts/build-bridge-update.mjs --tempcheck <out.cmd>`) is a read-only inspection: it counts
  `pittstop-check-*` folders in every temp directory and prints one `RESULT:` line (`CLEAN` /
  `LEFTOVERS FOUND` / `INCOMPLETE`). It deletes and changes nothing. The owner ran it on Windows and supplied the CLEAN result;
  no repeat is needed solely because of this UI release.

### What went wrong with the first updater (`PittStop-Bridge-Update.cmd`, withdrawn)

Three attempts on 2026-10-12: the new bridge logged a normal start each time, then ~35–45 s later the
updater declared failure, rolled back, and said the restored bridge was not running — while Windows
showed one `node print-bridge.mjs` running.

- **Cause (from the code, the timings, and a replay — not yet confirmed on Windows):** the updater decided
  "is the bridge running?" by reading `.Count` straight off the process query. In Windows PowerShell 5.1
  a *single* CIM process object has no usable `.Count`, so exactly one bridge read as none. The updater
  waited its full 40 s for a process that was already there, then "failed"; the same blind spot made it
  report the restored bridge as not running. It was a false alarm in the updater; the new bridge itself
  had started normally. Replaying that updater against a model of the launch chain reproduces the
  laptop's outcome only under this assumption (see "How far it has been verified").
- **Not the cause:** the relative path. `node print-bridge.mjs` did match the old filter. (The old filter
  was too *loose*, not too strict — it would have matched any Node process with "print-bridge" anywhere
  in its command line.)
- **Second, real defect, found while tracing the supervisor:** the first updater knew nothing about the
  `cmd` loop. It killed only `node` and then started the task, which can leave two supervisors and two
  bridges running.
- R2 records `diagnostic: one process object .Count = …` in its log, which settles the cause on the
  first Windows run.

### Update R2 — `PittStop-Bridge-Update-R2.cmd`

One self-contained file (50,573 bytes, SHA-256 `30097093a22e713f10f50735f4da141681f616d696f01fde199c331c3d448922`),
on the owner's Mac Desktop. It embeds exactly one file: bridge **v2.0.1** (SHA-256 `e79bdff4d310…`).
Rebuild: `node scripts/build-bridge-update.mjs <output.cmd>` from `scripts/windows/bridge-update.ps1` +
`scripts/print-bridge.mjs`. It carries no token, config, or bank data.

Bridge **v2.0.1** = the deployed v2.0.0 plus one log line: `connected — server accepted this bridge's
token`, written once per (re)connection. Nothing in the print path changed (`noscale` command line is
byte-identical). v2.0.x over v1: deletes each check PDF after printing and sweeps leftovers at startup,
watches the Windows print spooler, reports version and start time with the heartbeat, retries result
reports.

What R2 does:

1. **Checks first, changing nothing:** finds the bridge, config, and the one auto-start task; requires
   printer `Brother HL-L2420DW Printer` (present in Windows), SumatraPDF, Node 18+, an empty print queue;
   verifies the embedded script's SHA-256 and runs `node --check` on it. Refuses if another copy of the
   updater is running (named mutex).
2. **Backs up** the installed script as `print-bridge.backup-<hash>.mjs` — an existing backup is never
   overwritten, so the original v1 backup from the earlier attempts is preserved.
3. **Stops supervisor(s) and bridge(s) together**, supervisors first, and waits 8 s (longer than the
   supervisor's 5 s relaunch delay) to prove nothing comes back. It identifies only this install's
   processes: `node.exe` running `print-bridge.mjs` by bare/relative name or by a full path into the
   bridge folder; `cmd.exe` running `start-bridge.bat` likewise (or being the live parent of such a
   bridge); `wscript` running `start-bridge.vbs`. A same-named file in any other folder, and every other
   Node process, is left alone. Leftover duplicates from the earlier attempts are cleaned up here.
4. **Replaces only `print-bridge.mjs`** and deletes leftover `pittstop-check-*` temp folders.
5. **Starts through the existing task and verifies:** exactly one bridge and at most one supervisor; the
   *same* process id still alive 15 s later (under a supervisor a crashing bridge is relaunched, so mere
   existence proves nothing); and the bridge's own `bridge.log` showing `v2.0.1 starting` and
   `connected — server accepted`. The updater never uses the token itself.
6. **Rolls back on a genuine failure** (process missing, crash loop, duplicates, token rejected, config
   unreadable) with the same stop / start / checks. A network outage is not a failure: the bridge stays
   installed and the result says the connection is unconfirmed.

It never shows, changes, or regenerates the token or config; never edits the task, `start-bridge.vbs`,
`start-bridge.bat`, printer, server address, or print settings; never prints; never changes a Windows
policy (`-ExecutionPolicy Bypass` applies to its own process only). Every line shown or logged passes
through a filter that blanks the token. Log: `C:\pittstop\bridge-update.log`; on any non-success a copy
is placed next to the update file as `PittStop-Bridge-Diagnostics.txt` (process list, task settings,
file names/sizes/hashes, recent bridge log lines — no token, no config contents).

Result lines: `UPDATED OK`, `ALREADY UP TO DATE`, `UPDATED - SERVER CONNECTION NOT CONFIRMED`,
`UPDATED - VERSION NOT CONFIRMED ON THIS LAPTOP`, `NOT UPDATED - …`, `ROLLED BACK - …`,
`UPDATE STOPPED BY AN ERROR`.

### How far it has been verified

- **Really run, on macOS:** bridge v2.0.1 launched by relative path (`node print-bridge.mjs`) against a
  local stand-in server logs `v2.0.1 starting` and `connected`, sends `version: 2.0.1` in its heartbeat,
  and logs `unauthorized` (never the token) when the token is wrong.
- **Simulated (`scripts/windows/test/sim.ps1`, PowerShell 7 on macOS, Windows commands replaced by a model
  of the task → wscript → cmd loop → node chain, with the single-object `.Count` behaviour emulated):**
  update from one running v1 bridge; repeat runs; three leftover supervisors + bridges; nothing running;
  crash-looping new bridge → rollback to exactly one v1; rejected token → rollback; network down;
  missing `bridge.log`; wrong printer / busy queue / missing task; unexpected errors at several points;
  a second concurrent copy. Each ended with exactly one bridge (or the untouched original), unrelated
  look-alike processes alive, config and supervisor scripts unchanged, and no token in any output.
  The process-matching rule passes 20 Windows command-line cases (`scripts/windows/test/names.ps1`).
- **Replay of the first updater in the same model:** it reproduces the laptop's result (rollback after
  ~40 s, "restored bridge NOT running", one bridge actually running) only when the single-object `.Count`
  behaviour is emulated *and* stopping the task ends its process tree. Without the `.Count` behaviour it
  reports success.
- **On Windows:** R2 ran successfully on the laptop on 2026-10-12 (see the result above). The cause of the
  first updater's failure is still an inference until someone reads the `diagnostic: one process object
  .Count = …` line in `C:\pittstop\bridge-update.log`.
- **Verifiable remotely after it runs:** `print_bridges` row for `LAPTOP-RF8IO1H2` gains
  `version = 2.0.1`, a fresh `started_at`, and the printer name (all empty under v1).
- **Only the owner can confirm:** the result line on the laptop, paper from a VOID test, and that the
  bridge returns after a reboot.

## Code location

- Deployed UI: `origin/main` at `5d0f6b0`, based on check safety/specimen release `f88c079`.
- Current release worktree: `/Users/torlanpittman/.codex/worktrees/check-screen-release/pitt-stop-internal`,
  branch `codex/check-screen-release`.
- Earlier worktree `.ps-worktrees/checks-hardening` is historical; it is not the newest UI code.
- Local main checkout is divergent. Start future scoped releases from freshly verified origin/main.
- Handoff copies are maintained locally; this status document ships with the manager-login fix.

## Print-path safety model

"Sent to the printer" is never treated as "printed".

| Job status | What it proves |
|---|---|
| `queued` | Waiting for the bridge. Expires after 10 minutes — never prints late/unattended. |
| `claimed` | Handed to the bridge, no report yet. After 3 minutes it is an *uncertain* outcome a manager settles. |
| `submitted` | The printer driver accepted it (with bridge v2: it left the spooler). **Not proof of paper.** |
| `stuck` | A manager said no check came out, but the original may still be in Windows or the printer. Still blocks a resend until it is confirmed **cleared** (queue emptied + printer power-cycled) or it printed after all. |
| `printed` | A manager confirmed in the app that the paper check came out. |
| `failed` / `expired` / `canceled` | Nothing (more) will print for this job. |

- One open job per check (`queued`/`claimed`/`submitted`/`stuck`) — enforced in code **and** by the partial unique
  index `print_jobs_one_active_per_check` (migration `0050`). A double tap cannot print two checks.
- After a confirmed print, another copy needs an explicit **Reprint** (original destroyed / never left).
- A real check is re-validated when the bridge claims it: still recorded in QuickBooks, and its MICR line
  resolves to real E-13B. Otherwise the job is failed and **nothing prints** (no placeholder "checks").
- On blank stock a browser printout can never be recorded as the printed check.
- The bridge sends a heartbeat on every poll (`print_bridges`), shown as "Shop printer link: online/offline".

## QuickBooks write safety

- Go-live interlock: `checks_live_enabled` can only be turned on via `/api/admin/checks/setup` when the
  config is complete, the MICR line is ready, and QuickBooks is the **production** company — which is then
  pinned (`check_qbo_realm_id`). Every write is refused on any other company/environment.
- One writer at a time per check (`qb_status = 'writing'` lock, stale after 3 minutes) + a stable
  QuickBooks `requestid`, so concurrent or repeated retries cannot create two Purchases.
- Crash recovery adopts an existing Purchase only on an exact match (bank account + payee + amount + date);
  any other check with that number on the same bank account stops the write.
- Check dates use US Central time.
- No automatic voiding exists, and CFO calculations do not consume checks. Both are deliberately out of
  scope for this phase.

## MICR line — font and geometry

- **Font: GnuMICR 0.30 (GPL v2)**, the unmodified Type 1 font, kept with its license and source in
  `apps/checks/fonts/gnumicr/` and embedded in the PDF at print time. No paid or licensed font is needed.
  Printed at exactly **12 pt** (its design size): 0.125" pitch, 0.117" character height, 0.013" stroke
  module, right-aligned characters. Symbols: `A` transit, `B` amount, `C` on-us, `D` dash.
- **Horizontal: fixed ANSI positions from the right edge** (position 1's right edge 5/16" from the right
  edge, 8 positions/inch): 1–12 Amount (blank), 13 blank, 14 On-Us symbol + account from 15, 32 blank,
  33–43 transit, 44 blank, 45+ auxiliary On-Us (check number). Fields never move with account length.
- **Vertical:** baseline 3/16" above the perforation.
- Bank numbers live only in server env and the real line is built only when the bridge claims a job.
- `npx tsx scripts/check-void-preview.ts <dir>` builds the VOID page locally, plus a version with a
  position gauge overlay.

## MICR-only calibration write path (`micr_layout`)

MICR coordinates are changed ONLY through the manager/admin-gated endpoint
`/api/admin/checks/micr-layout` (`apps/checks/micr-config.ts`). It:
- writes ONLY the `micr_layout` setting; the five allowed fields are `baselineFromBottomIn`,
  `rightMarginIn`, `amountFieldIn`, `pitchIn`, `sizePt`;
- **rejects** any non‑MICR geometry key (`offsetX`/`offsetY`/`sectionHeightIn`/`position`/`fields`/
  `perField`) and the `micr_enabled` flag;
- range-validates every value (no silent coercion);
- **requires an explicit reason** and records who / when / old / new append-only in `micr_layout_audit`
  (migration `0037_micr_layout_audit.sql`);
- **never** enables MICR, creates a check or QuickBooks transaction, or consumes / advances a check number.

## Go-live gate

- ✅ Non-MICR layout — approved on paper.
- ✅ MICR line layout — visually approved on the Blue Summit stock (owner, 2026-10-12).
- ✅ MICR toner installed.
- ✅ E-13B font bundled, deployed, loading in production.
- ✅ Print-path and QuickBooks safety hardening deployed (`55a8234`, migration `0050`).
- ✅ `MICR_ROUTING` / `MICR_ACCOUNT` entered in Vercel, redeployed, present and well-formed (2026-10-12).
- ✅ Bridge v2.0.1 installed, VOID-tested, reboot-tested (2026-10-12).
- ✅ QuickBooks production connection, operating bank, and category accounts verified read-only.
- ✅ Starting check number approved and set: 10356 (2026-10-12), unconsumed.
- ✅ Temp-PDF inspection on the laptop reports CLEAN (owner screenshot).
- ✅ Account number (incl. leading zeros) and six-digit check-number format confirmed by the owner against a
  real AMB check (2026-10-12).
- ✅ Six-digit padding + bank specimen mode deployed and verified (`f88c079`, 2026-10-12).
- ✅ Exactly one non-negotiable specimen printed (owner-confirmed).
- ⬜ Bank-reader acceptance remains unverified.
- ⬜ `micr_enabled` on.
- ⬜ `checks_live_enabled` on via the interlock.
- ⬜ Explicit owner authorization of the first real check: payee, amount, check number.

## Read-only readiness check — 2026-10-13, 12:15 PM Central

Owner explicitly declined a bank-verification visit; do not require that visit as a prerequisite or
claim bank-reader acceptance is proven. Live GET checks: bridge online v2.0.1 / Brother HL-L2420DW
Printer; QuickBooks connected, active, production, no last error; operating account *2649 and all
category mappings configured; bank secrets present and well-formed, font installed. Operating next
number 10356, zero recent checks. MICR and live recording still OFF; realm not pinned. Remaining
software action is owner-approved enablement through the existing setup interlock (pins QBO realm).
No settings changed, no financial records or print jobs created. Current UI records after final
Record & Print confirmation, then shows a separate Send Check to Shop Printer button.
