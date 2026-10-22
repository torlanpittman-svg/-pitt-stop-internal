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

## Treatment of the replaced invoice: VOID, not delete

The QuickBooks Online Invoice API's void operation is `POST /v3/company/<realm>/invoice?operation=void` with
body `{ Id, SyncToken }`. According to Intuit's Invoice API reference:

- the transaction **stays** in QuickBooks with its number;
- its amounts are set to 0 and "Voided" is prepended to `PrivateNote`;
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
| Finished from the shared-invoice screen instead | — | reading either Job's invoice records the combine as completed |

Double taps reuse the same request id (unique index) and get the same consolidation. Two different requests for
the same invoices race on the claim statement and unique indexes; exactly one wins. A worker lease (90 s)
serializes drivers; a crashed worker's lease simply expires.

### Residual risks (documented, not eliminated)

- **Concurrency backstop.** One unfinished combine per QuickBooks customer (`ric_customer_active_uniq`). Without
  it, two concurrent starts (keep A / void B, and keep C / void A) could both claim under READ COMMITTED, because
  the claim's NOT EXISTS checks don't see a concurrent claim. The step-1 re-check also refuses to void an invoice
  that anchors a shared member or is retained by another combine. A shared-invoice *link* racing a combine claim
  can still slip a pending member onto the retained invoice. It only stops the update with an "another vehicle is
  pending" attention (that member can be kept separate), and it is never a double bill.
- **Adopting a void requires QuickBooks' own "Voided" marker.** An invoice zeroed out by hand is not treated as
  voided; the combine cancels instead.

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
- `app/api/workflow/orders/[id]/invoice/combine/route.ts`: manager/admin only, flag-gated. The invoice GET now
  also returns `combine` + `qbCombineEnabled`.
- `app/components/CombineInvoices.tsx` and `app/orders/[id]/InvoiceDraftPanel.tsx`

## Tests

`apps/quickbooks/invoice-consolidation.test.ts` has 28 tests on PGlite (real schema, indexes and CTE claims) with
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
- all blocked actions while unfinished.

`app/api/workflow/orders/[id]/invoice/combine/route.test.ts` has 5 tests: employee/unauthenticated 403,
flag-off 503, actor from session, review required, status mapping.

Verification on 2026-10-22:

- full suite: 188 files, **2302 tests passed**;
- `tsc --noEmit` clean;
- eslint clean on all changed files (the 3 errors in `InvoiceDraftPanel.tsx` are pre-existing on `origin/main`);
- `next build --webpack` exit 0.

**Not yet verified:**

- a real QuickBooks **sandbox** void through this code path;
- whether a payment application bumps the invoice SyncToken (see residual risks);
- the UI in a browser.

## Deploy plan (each step needs explicit owner approval)

1. **Sandbox check first** (local, sandbox realm only):
   - Create two invoices for one test customer and combine them.
   - Confirm in QuickBooks that the replaced invoice shows VOID with its number kept and the retained invoice
     bills both.
   - Apply a payment to an invoice and confirm its SyncToken advances.
2. **Migration 0063 BEFORE code.** The invoice GET reads `retail_invoice_consolidations` for every Job, so code
   without the table would break the invoice screen. Apply with `scripts/apply-qb-migration.mjs`; the statements
   are additive and idempotent. Verify the table, the five indexes and the two checks.
3. Cherry-pick this branch's commit into a worktree off current `origin/main`, then FF-push and deploy. Confirm
   READY and the commit via the Vercel API. The flag stays OFF, so behavior is identical except for the
   blocking guards, which only act on combine rows (none exist).
4. Read-only live checks:
   - Kelvin's invoices render as before;
   - `GET …/invoice/combine` returns `enabled:false`.
5. Owner enables `retail_qb_combine_invoices_enabled=true` (kill-switch: set it back to false; an unfinished
   combine still shows its status, but recovery needs the flag on).
6. Rollback: redeploy `85d6190`. **Hard precondition:** turn the flag off first (no new combine can start), then
   `SELECT count(*) FROM retail_invoice_consolidations WHERE status IN ('prepared', 'voided', 'relinked')` must be
   **0** — finish, cancel or bill separately any unfinished combine. Old code does NOT know `consolidating` (its
   Record Payment would not refuse such an invoice) and has none of the combine guards. The table itself is unused
   by old code and can stay.

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
