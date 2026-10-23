# Combine unpaid invoices (retail)

Status (2026-10-22): built and tested on branch `feat/combine-unpaid-invoices` (worktree
`.ps-worktrees/combine-invoices`, based on production `85d6190`). **NOT deployed. Migration 0063 NOT applied.
Flag `retail_qb_combine_invoices_enabled` defaults OFF.** Nothing here has touched production QuickBooks or
production data. Kelvin Cooper's real invoices are untouched.

## What it does

Two retail Jobs of the same customer each already have their own unpaid QuickBooks invoice (made by Pitt Stop).
A manager combines them into one, even after both Jobs are completed:

1. On either Job's invoice (View/Edit Invoice → QuickBooks block): **Combine unpaid invoices…**
2. Pitt Stop lists this customer's other invoices. The customer match is proven by QuickBooks: this invoice's
   CustomerRef, confirmed by email/phone, against the other invoice's CustomerRef. **A name alone never matches.**
3. The manager taps the other invoice.
4. The review shows:
   - both invoice numbers and vehicles;
   - each vehicle's services, fees and total;
   - the exact lines of the combined invoice;
   - the combined total;
   - which invoice stays (defaults to the emailed one, otherwise the older one; "Keep #… instead" swaps them);
   - what happens to the other invoice;
   - whether either invoice was emailed. If one was, the manager must tick a checkbox acknowledging the staff guidance.
5. **Combine invoices** (explicit confirm):
   - the replaced invoice is **voided** in QuickBooks;
   - its Job joins the retained invoice as a shared-invoice member;
   - the retained invoice is updated to bill both vehicles.
6. Afterwards both Jobs point to the same invoice through the existing shared-invoice model: the retained Job is
   the anchor and the other Job is an applied member.
7. Nothing is ever emailed. If the retained invoice had been emailed, it shows "Resend recommended"; resending is
   a separate manual step.

Never changed: Job status, `completedAt`, services, prices, fees, production reporting, history.

## A retained invoice that already bills several vehicles (Kelvin's third vehicle)

The invoice kept may already be a shared invoice (its own Job + APPLIED members — e.g. #100922 after it absorbed
#100924). It can take one more vehicle in two ways:

| The new Job… | Workflow | What happens |
|---|---|---|
| has NO QuickBooks invoice | existing shared-invoice flow: on the new Job's invoice, **Add to an open invoice** → pick #A → open #A's Job → **Review & update invoice** | #A is rewritten once with all vehicles; nothing voided |
| already has its OWN invoice #C | **Combine unpaid invoices…** (from the new Job or from #A's Job) → pick the other → review → Combine | #C is voided; the new Job becomes one more member of #A; #A is rewritten once |

Rules for the combine (server-side, `verifySide` / `buildPreview` / claim):

- An invoice that already bills several vehicles is **always the one kept**, even if the other invoice was emailed or
  is older; "Keep the other instead" is refused. Two multi-vehicle invoices are never combined. Only a
  single-vehicle invoice is ever voided.
- Its existing members must all be **applied** (none pending), still bill the same QuickBooks customer (email /
  phone), and QuickBooks must hold exactly the lines Pitt Stop would write for all of them (current combined layout or
  the legacy per-vehicle layout). Any payment, credit, edit, or vehicle pending review → refused with the reason.
- The claim is fenced on the exact number of applied members reviewed (`retained_member_count`, migration 0063), and
  step 1 re-checks it (plus "no other pending vehicle") before the void. A link that races in → nothing written.
- The existing members' rows are never touched: the update only adds the new member (pending → applied).

After the third vehicle: #A shows three "Vehicle n of 3" sections, ONE shop-supplies line and ONE card-payment line
(each Job's own fee is computed, capped and rounded on its own — the line is just their sum), and its total equals
the sum of the three Jobs' canonical totals.

## Treatment of the replaced invoice: VOID, not delete

The QuickBooks Online Invoice API's void operation is `POST /v3/company/<realm>/invoice?operation=void` with
body `{ Id, SyncToken }`. According to Intuit's Invoice API reference:

- the transaction **stays** in QuickBooks with its number;
- its amounts are set to 0 and its `PrivateNote` marked "Voided". **Production evidence (2026-10-23, read-only):**
  #100897 (id 24167), voided by Pitt Stop on 2026-10-05, reads `PrivateNote = "Voided"` exactly, `TotalAmt` 0,
  `Balance` 0, every line `Amount` 0 — the PSID is **gone**. So a void is identified by the invoice id (in the
  realm-checked company), its DocNumber and its CustomerRef — never by the PSID. (The earlier code adopted a
  previously landed void only if the PSID was still there; after a crash between the void and recording it, that
  would have fallen through to "invoice changed → cancel" on a voided invoice. Fixed and tested with a fake that
  reproduces the real format.)
- a stale SyncToken is rejected;
- voiding **unapplies** any linked payment (it becomes unapplied credit).

So history is preserved and the customer is not billed twice. Nothing is deleted. The replaced invoice's
identity (id, number, SyncToken, line fingerprint, total, emailed state) is kept permanently on
`retail_invoice_consolidations` and in both Jobs' `service_order_events`.

## Order of operations (void FIRST)

```
prepared ──void──▶ voided ──relink──▶ relinked ──reviewed update of retained invoice──▶ completed
   │                  └──────────────┬────────┘
   └─ cancel (nothing written)       └─ separate ("Bill separately": the replaced Job gets a NEW invoice)
```

The order guarantees that **at no moment do both invoices bill the same charges**. The worst intermediate state
is "the replaced vehicle's charges are billed nowhere yet". That state is durable, shown on both Jobs, and has a
recovery path.

| Step | Writes | Fenced on |
|---|---|---|
| Claim (one SQL statement) | retained row `FOR UPDATE`; replaced Job `qb_status → consolidating` (compare-and-set from its reviewed status); consolidation row; pending member row; retained line fingerprint | both unpaid locally; neither shared; unique indexes (one unfinished combine per Job; request id) |
| 1. Void | QuickBooks void of the replaced invoice with the **reviewed** SyncToken (no retry with a fresher one) | fresh re-read of BOTH invoices: same SyncTokens, PSIDs, customer, untouched money, same lines. Any change → **cancel** (nothing written) |
| 2. Relink | replaced Job: `qb_invoice_id → NULL`, `qb_status → linked`; row → relinked (one statement) | replaced Job still `consolidating` with the voided invoice id |
| 3. Update | `syncRetailQBInvoice({ applyPending, expectedSyncToken })` on the retained invoice: the existing reviewed shared-invoice update, which re-checks money, lines, identity and customer under the Sync lock | combined total equals what was reviewed; retained SyncToken equals what was reviewed (or a fresh review on Retry) |

## Billing actions blocked while a combine is unfinished (server-enforced)

| Action | Retained invoice | Replaced invoice |
|---|---|---|
| Send / Resend | refused: pending member (`shared_pending`) | refused: `consolidating` (verify + Send compare-and-set); then `linked`/no invoice |
| Record Payment | refused: pending member (re-verified under the payment lock) | refused: `consolidating` ∈ `INVOICE_CHANGING_STATUSES`; verify blocks it |
| Ordinary Sync | refused: `shared_pending` | refused: Sync lock compare-and-set |
| Reviewed shared update | refused while the member still owns its invoice (preview blocker + Sync guard) | — |
| Link another Job | refused (link statement + discovery) | has its own invoice → refused |
| Keep separate (unlink) | — | refused: owned by the combine |
| Create | has an invoice | `consolidating` (has its invoice), then `linked` → refused |
| Work Board removal | refused (names the combine) | refused (names the combine) |

The UI also hides Send, Sync and Payment and shows the recovery panel on both Jobs.

## Failure and recovery (every write boundary)

| Where it stops | What Pitt Stop shows | Recovery |
|---|---|---|
| QuickBooks read fails before the void | "not finished", nothing written | **Retry** |
| Invoice changed / payment applied before the void (re-read differs, or QuickBooks rejects the stale SyncToken) | combine **cancelled**, both invoices unchanged | review again |
| Void response lost, and the void landed | read back → adopted as voided (never voided twice) | automatic |
| Void outcome unknown (timeout, read-back fails) | blocked, attention | **Retry** re-reads QuickBooks first. **Cancel** is refused for 2 minutes after a void attempt, and refused permanently once the invoice is voided |
| Crash between void and relink, or relink and update | durable status voided / relinked | **Retry — finish combining** |
| Retained update refused (payment applied, edited in QuickBooks, charges changed) | attention; the replaced vehicle is not billed yet | **Retry** after fixing, or **Bill that vehicle separately**. Only allowed while QuickBooks shows the retained invoice WITHOUT those charges; the vehicle then gets a NEW invoice (voided invoices are never re-adopted) |
| Retained update landed but its response/finalization was lost | attention; Bill separately refused | **Finish** with a fresh review (the panel loads it); the update reconciles as a no-op-equivalent rewrite, billed once |
| Someone tries the shared-invoice "Update invoice" instead | refused server-side while the combine is unfinished | finish from the Combine panel (reading either Job's invoice still reconciles a combine whose member was applied) |
| QuickBooks shows the replaced invoice at $0 **or** "Voided", but not both — at ANY point, whether or not Pitt Stop attempted a void (e.g. reduced to $0 by hand) — or shows it voided under a different number / customer | attention: "can't confirm it was voided"; **no void is recorded, Cancel is refused, nothing is auto-cancelled**, both invoices stay blocked | a person checks QuickBooks: void it there properly (Retry adopts the confirmed void and finishes) or restore its charges (Retry sees the change and cancels cleanly) |
| Either invoice was emailed (from Pitt Stop OR straight from QuickBooks, with or without a SyncToken change) after the combine was reviewed | `confirm_required` before the void (replaced or retained) or before the update (retained); nothing written; `email_ack_required` shows the checkbox on the panel | **Retry / Finish** with the acknowledgement; the server refuses without it, records `late_email_acknowledged_at/by` and an event on both Jobs |
| The replaced invoice was voided in QuickBooks by someone else (Pitt Stop never sent a void) | it IS void, so it is recorded (never cancelled), but `ack_required='external_void'`: a payment made before that void is now unapplied credit | the manager checks the customer in QuickBooks, ticks the confirmation and Finishes — or Bills separately |
| The retained invoice's update timed out / its outcome is unclear | attention; `update_attempted_at` set | **Retry** (reconciles a landed write); **Bill separately** is refused for 2 minutes after an unclear update so a late-landing write can't double-bill. A definitive pre-write refusal clears the window |
| QuickBooks reconnected to a different company, or the connection can't be read | attention / read failure; no QuickBooks call is made by any step (void, update, cancel, separate) | reconnect the original company (its realm id is on the combine row), then Retry |
| Another combine for the same customer is unfinished | refused at review; a concurrent start that loses at the database index gets "busy" with the reason; nothing written | finish / cancel / bill separately the open one first |

Double taps reuse the same request id (unique index) and get the same consolidation. Two different requests for
the same invoices race on the claim statement and unique indexes; exactly one wins. A worker lease (90 s)
serializes drivers; a crashed worker's lease simply expires.

**Kill switch.** Turning `retail_qb_combine_invoices_enabled` off stops NEW combines (discover / preview / start).
An unfinished combine can still be finished, cancelled or billed separately: those need only QuickBooks Create +
Sync, so the switch never strands a half-done combine (and rollback can drain them, see below).

### Guarantees: what the database enforces vs. what is argued

| Guarantee | How | Evidence |
|---|---|---|
| One unfinished combine per QuickBooks customer **per QuickBooks company**, in every unfinished state (prepared / voided / relinked — recovery included) | `ric_customer_active_uniq` UNIQUE on `(qb_realm_id, qb_customer_id) WHERE status IN (…)`. Finished rows (completed / cancelled / separated) never block | `invoice-consolidation-migration.test.ts`: applies 0063 itself, inserts straight into the table |
| One unfinished combine per Job on either side; one row per request id | `ric_replaced_active_uniq`, `ric_retained_active_uniq`, `ric_request_uniq` | same |
| A losing concurrent claim writes nothing (no `consolidating`, no member row) | the claim is ONE statement: a unique violation rolls back all of it | `invoice-consolidation.test.ts` "a concurrent start that claims first" (competitor row committed just before the claim) |
| A Job retained in one combine can't be replaced in another | follows from the customer index (both sides of a combine are that customer's) + the step-1 re-check | DB part tested; the true two-connection READ COMMITTED interleaving is **not reproducible** here (PGlite is single-connection, no local Postgres) — it is argued, not demonstrated |
| QuickBooks writes go to the company the combine was claimed in | `qb_realm_id` on the row; every step re-reads the connected realm first | tested (company switch / unreadable connection) |

Independent review 2026-10-23 (on the finished branch) — all fixed and covered by tests in the "independent review
(2026-10-23) fixes" block: acknowledgements are per invoice (`late_email_acknowledged_invoices`); Bill separately
waits for an unclear update to settle (`update_attempted_at`); the cancel / separate multi-step statements gate every
step on the replaced Job's state (no half commit) and Cancel reports the real outcome; a void response missing its
amounts is never "$0"; a void done outside Pitt Stop needs an explicit payment check before its vehicle is billed
on the retained invoice. Re-review: the late-email acknowledgement (`confirmSent`) and the external-void payment
check (`confirmExternalVoid`) are separate flags and separate checkboxes — neither satisfies the other; the
shared-invoice "Update invoice" (preview blocker + `updateSharedInvoice` refusal) can no longer finish an unfinished
combine behind its back, only the combine's own Finish can (`previewSharedInvoiceUpdate(…, { forCombine: true })`);
a cancel inside the void step that doesn't apply now reports attention instead of "nothing was combined".

### Residual risks (documented, not eliminated)

- **Concurrency.** The database guarantees above close the "keep C / void A while A is kept elsewhere" race the
  review found. A shared-invoice *link* racing a combine claim is caught by the claim's member-count fence or by the
  step-1 re-check (another pending vehicle / changed member count → cancelled before the void); never a double bill.
- **A void is recorded only when QuickBooks confirms it:** the "Voided" marker AND $0 total and balance, on the
  reviewed invoice id / number / customer. Any half state needs a person to reconcile; it is never recorded as a
  void and never auto-cancelled. Production #100897 shows QuickBooks carries both signals after a void.
- **Kill switch + QuickBooks off.** If QuickBooks Create or Sync is switched off while a combine is unfinished, it
  can't be finished or undone until they're back on (both invoices stay blocked meanwhile).

- **Payment applied in QuickBooks between the final re-read and the void.** The void carries the reviewed
  SyncToken. If applying the payment advanced the invoice's SyncToken, QuickBooks rejects the void and the combine
  cancels. **Verify in the sandbox before enabling.** If it did not, the void would unapply that payment, leaving
  it as unapplied credit for Kelvin's QuickBooks customer, to be applied to the retained invoice by hand. The
  window is milliseconds.
- **A timed-out void that lands later than 2 minutes after a Cancel.** The replaced Job's own verification (money
  state, $0 total) would then flag it for review.

## Reporting (each vehicle counted once)

- Production / CFO earned figures are per Job and unaffected.
- Marketing revenue counts a Job as invoiced if it owns an invoice OR is an **applied** member, so after
  completion each vehicle is counted once.
- Open AR comes from QuickBooks, where only the retained invoice has a balance (voided = $0).
- While a combine is between void and update, the replaced vehicle counts as earned-but-uninvoiced. That is
  correct: it is billed nowhere at that moment.

## Files

- `drizzle/migrations/manual/0063_retail_invoice_consolidations.sql` and `apps/workflow/schema.ts`
  (`retailInvoiceConsolidations`)
- `apps/quickbooks/invoice-consolidation.ts`: discovery, preview, start, the state machine, resume / cancel /
  separate, read model
- `apps/quickbooks/retail-invoice-write.ts`: `voidRetailInvoiceInQB` (compare-and-set void), `isVoidedInvoice`,
  `findRetailInvoiceByPsid` skips voided invoices
- Guards:
  - `invoice-locks.ts` (`consolidating`)
  - `retail-invoice-service.ts` (verify blocks `consolidating`; Sync refuses a member that still owns an invoice)
  - `shared-invoice.ts` (link / unlink / candidate / preview)
  - `apps/workflow/order-removal.ts`
- `apps/settings/db.ts`: `retail_qb_combine_invoices_enabled` (default OFF; requires shared invoices + Create + Sync)
  for new combines; `retailQbCombineRecoveryEnabled()` (Create + Sync) for finishing / undoing an unfinished one
- `app/api/workflow/orders/[id]/invoice/combine/route.ts`: manager/admin only, flag-gated. The invoice GET now
  also returns `combine` + `qbCombineEnabled`.
- `app/components/CombineInvoices.tsx` and `app/orders/[id]/InvoiceDraftPanel.tsx`

## Tests

`apps/quickbooks/invoice-consolidation.test.ts` has 59 tests on PGlite (real schema, indexes and CTE claims) with
the real pricing engine, Invoice Draft and Create/Sync/Send. Only QuickBooks is faked, with SyncToken
compare-and-set on update and void; send throws. They cover:

- discovery from either Job;
- review contents and default/swap;
- emailed guidance + acknowledgement;
- never-by-name;
- dealer exclusion;
- paid / partial / voided / edited / unsafe-line / already-shared refusals;
- success on completed Jobs: dates, status, services, history, void kept, membership, no email;
- no second invoice; reports counted once;
- stale review;
- a payment before the void (cancel) and after the void (attention → Bill separately → new invoice, not
  re-adopting the void);
- the retained invoice changing after the claim;
- a double tap; racing requests; a concurrent Send;
- lost / uncertain voids; a QuickBooks outage after the claim;
- an update that fails before writing; an update that landed but whose response was lost;
- completion from the shared screen; Cancel; lease expiry;
- all blocked actions while unfinished;
- review fixes: second combine for the same customer refused at review and at confirm (DB index loser → busy,
  nothing written); same customer id in another company not blocked; company switch / unreadable connection stops
  every QuickBooks step; retained invoice emailed straight from QuickBooks mid-combine → Finish refused without
  acknowledgement, then finished and audited with it; a start acknowledgement for the replaced invoice doesn't
  cover the retained one; $0-without-marker and marker-without-$0 never recorded as voided (reconcile → real void
  finishes, restored charges cancel).

`apps/quickbooks/invoice-consolidation-migration.test.ts` (4): 0063 applied twice with the apply script's splitter
equals the Drizzle schema (columns, indexes, checks); additive only; the realm-scoped unique index rejects a second
unfinished row in every unfinished state and allows finished rows / another company.

`app/components/CombineInvoices.test.ts` (3): after Retry, a pre-void stale stop (combine cancelled) refreshes the
panel immediately; only post-void stale / acknowledgement stops load a fresh review.

Each new test was checked to fail with its fix reverted (realm index, server-side acknowledgement, strict void
state, panel rule, realm check).

`app/api/workflow/orders/[id]/invoice/combine/route.test.ts` has 7 tests: employee/unauthenticated 403,
flag-off refuses new combines (503) but still allows resume / cancel / separate, QuickBooks off refuses recovery,
actor from session, review required, status mapping.

Added 2026-10-23: Kelvin's exact figures ($159.14 × 2 → $318.28, ONE $9.00 shop-supplies and ONE $9.28 card-fee line,
each Job's fees unchanged); a third vehicle WITHOUT an invoice joining the combined invoice before and after
completion; a third vehicle WITH its own invoice combined into the two-vehicle invoice (kept even if the other is
emailed, swap refused, first members untouched, 3 sections, Σ totals, reports once); payment / credit on #A blocks
both workflows; dealer exclusion; two multi-vehicle invoices refused; a link racing the claim (statement fence) and
after the claim (step-1 check); every write boundary for the 3-vehicle combine; the replaced invoice emailed without
a SyncToken change; the review fixes above; realistic QuickBooks void format (PSID removed).

Verification on 2026-10-23 (final): full suite 190 files, **2338 tests passed**; `tsc --noEmit` clean; eslint on
changed files = the same 3 pre-existing findings as production (`InvoiceDraftPanel.tsx`), 0 new; `next build
--webpack` exit 0.

Verification on 2026-10-22:

- full suite: 190 files, **2321 tests passed** (after the review fixes);
- `tsc --noEmit` clean;
- eslint on all 16 changed/new TS files vs. the same files at production `85d6190`: 3 findings both before and
  after, all pre-existing in `InvoiceDraftPanel.tsx` (`react-hooks/refs` ×2, `react-hooks/purity` ×1); **0 new**;
- `next build --webpack` exit 0.

**Not yet verified:**

- a real QuickBooks **sandbox** run: the sandbox connection's refresh token has expired (2026-10-23
  `QBReauthRequiredError` before any QuickBooks call), so the one-off sandbox check could not run; re-connecting
  the sandbox needs the owner's Intuit login. The void's post-state was instead confirmed on production #100897
  (read-only), and the live Kelvin combine is verified read-only afterwards;
- whether a payment application bumps the invoice SyncToken (see residual risks — the money state is re-read right
  before the void either way);
- a true two-connection race on the claim (only the database index outcome is tested);
- the UI in a browser.

## Deploy plan (each step needs explicit owner approval)

1. **Sandbox check first** (local, sandbox realm only; never production QuickBooks):
   - Create two invoices for one test customer and combine them.
   - Confirm in QuickBooks that the replaced invoice shows VOID with its number kept, `PrivateNote` starts with
     "Voided" AND `TotalAmt` / `Balance` are 0 (the code records a void only when both hold), and the retained
     invoice bills both.
   - Apply a payment to an invoice and confirm its SyncToken advances (see residual risks).
   - Email an invoice from QuickBooks and confirm `EmailStatus` becomes `EmailSent` (the server-side
     acknowledgement keys on it).
2. **Migration 0063 BEFORE code.** The invoice GET reads `retail_invoice_consolidations` for every Job, so code
   without the table would break the invoice screen. Confirm the target first (`tsx scripts/db-target.ts` →
   `ep-morning-base-adq5h6rq`), then apply with `scripts/apply-qb-migration.mjs` (additive and idempotent; one new
   table, nothing else touched). Verify:
   ```sql
   SELECT column_name FROM information_schema.columns
    WHERE table_name = 'retail_invoice_consolidations' AND column_name IN ('qb_realm_id', 'qb_customer_id');  -- 2 rows
   SELECT indexname FROM pg_indexes WHERE tablename = 'retail_invoice_consolidations' ORDER BY 1;
   -- ric_customer_active_uniq, ric_replaced_active_uniq, ric_replaced_order_idx, ric_request_uniq,
   -- ric_retained_active_uniq, ric_retained_order_idx, retail_invoice_consolidations_pkey
   SELECT indexdef FROM pg_indexes WHERE indexname = 'ric_customer_active_uniq';   -- (qb_realm_id, qb_customer_id) WHERE status IN (…)
   SELECT conname FROM pg_constraint WHERE conrelid = 'retail_invoice_consolidations'::regclass AND contype = 'c';  -- ric_not_self, ric_status_valid
   SELECT count(*) FROM retail_invoice_consolidations;   -- 0
   ```
   (Read-only check 2026-10-22: production `job_estimates.qb_status` is varchar(20) with no CHECK constraint, so
   the new `consolidating` value fits; the table does not exist yet.)
3. Cherry-pick this branch's commits into a worktree off current `origin/main`, then FF-push and deploy. Confirm
   READY and the commit via the Vercel API. The flag stays OFF, so behavior is identical except for the blocking
   guards, which only act on combine rows (none exist).
4. Read-only live checks: Kelvin's invoices render as before; `GET …/invoice/combine` returns `enabled:false`.
5. Owner enables `retail_qb_combine_invoices_enabled=true`. Kill switch = set it back to false: no new combine can
   start; any unfinished one can still be finished, cancelled or billed separately.

## Rollback (to `85d6190`, or ANY build without the combine guards)

This applies to every version that lacks the consolidation payment / send / sync guards — `85d6190` and anything
older. The previous production version **cannot safely handle an unfinished combine**: it doesn't know `consolidating`
(its Record Payment would not refuse such an invoice, and Send/Sync have no combine guards), and it would treat a
relinked Job as an ordinary pending shared member that "Keep separate" could unlink while its old invoice is
already void. So:

1. Set `retail_qb_combine_invoices_enabled = false` (no new combine can start; recovery keeps working).
2. Drain: for every row from
   ```sql
   SELECT id, status, retained_invoice_number, replaced_invoice_number, attention
     FROM retail_invoice_consolidations WHERE status IN ('prepared', 'voided', 'relinked');
   ```
   a manager opens either Job's invoice and Finishes, Cancels (only before the void) or Bills separately. An
   attention "can't confirm it was voided" needs QuickBooks reconciled first.
3. **Hard gate:** the same query must return **0 rows**, and
   `SELECT count(*) FROM job_estimates WHERE qb_status = 'consolidating'` must be **0**. Do not redeploy otherwise.
4. Redeploy `85d6190`; confirm READY + commit via the Vercel API. The table (and finished rows, which are the
   permanent audit of each voided invoice's identity) stays — old code never reads it. Do NOT drop it.

## Kelvin Cooper — reconciliation plan (proposal only; nothing executed)

Production state, read 2026-10-22 (DB reads only, `ep-morning-base-adq5h6rq`; production QuickBooks can't be
read locally):

| Vehicle | Job | Estimate | QB invoice | Status | Local total | Emailed (local) | Completed |
|---|---|---|---|---|---|---|---|
| 2018 Ford F-250 | `64033c35` SO-20261022-0004 | `d7c5dccc` | **#100922** (id 24513) | created, unpaid | $159.14 | no | 2026-10-22 20:02 UTC |
| 2022 BMW 330i | `7d5bcac8` SO-20261022-0007 | `6c1e32b8` | **#100924** (id 24515) | created, unpaid | $159.14 | no | 2026-10-22 19:54 UTC |

Neither Job is on a shared invoice; neither has a payment recorded locally. Kelvin's other Jobs are older and
unrelated; this plan leaves them untouched: three from Aug/Sep with no invoice, and one cancelled today.

Proposed, after deploy + sandbox check + flag ON, by a manager in the app:

1. Open either Job → View/Edit Invoice → **Combine unpaid invoices…** → tap the other invoice.
2. Confirm the review shows #100922 and #100924, $159.14 each, combined **$318.28**, and "Not emailed" on both. If
   QuickBooks reports one as emailed, the app makes it the one kept and asks for the acknowledgement. If the review
   refuses, for example because an invoice's lines no longer match its Job, stop and report; do not force it.
3. Expected default: keep **#100922** (dated first; lower id). Void **#100924**. The manager may swap.
4. Confirm. Expected result: #100922 = $318.28 for both vehicles; #100924 VOID $0; both Jobs show Combined;
   nothing emailed.
5. Then, separately and only if the owner wants: Send #100922 to Kelvin.

Production actions that need the owner's explicit approval:

- applying 0063;
- the deploy;
- enabling the flag;
- the combine itself, which voids #100924 in production QuickBooks;
- any send to Kelvin.
