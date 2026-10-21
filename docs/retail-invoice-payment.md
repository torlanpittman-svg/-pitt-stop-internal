# Retail invoice payment — Record Payment / Email Paid Invoice

Status (verified 2026-10-21): full-payment Record Payment is LIVE — c20ee66 in production (Vercel
`dpl_Ds7wqWzh…` on bb2aa28), migration 0059 applied, `retail_qb_payment_enabled=true`, mappings Cash 1 / Check 2
/ Credit Card 3 → Undeposited Funds 52 (realm 123146329198289). No production payment had been recorded yet.
**Installments (partial payments, branch `feat/partial-payments`): built + tested, NOT deployed; needs migration
0061.** See "Installments" below.

## Flow
1. **Create QuickBooks Invoice** (existing) → the invoice card shows **Send Invoice** and **Record Payment**.
2. **Send Invoice** (existing, unpaid) leaves Record Payment available until QuickBooks shows a $0.00 balance.
3. **Record Payment**: opening it verifies the invoice against the Invoice Draft and checks QuickBooks for
   existing payments (paid online → adopted, nothing written). Choose **Cash / Card Terminal / Check** →
   enter the **Amount received** (defaults to the remaining balance; a smaller amount is a partial payment) →
   **Review** → **Save**. No tips / overpayments. **Cash / Check** paying an unpaid invoice in full show the amount with
   the card-payment charge removed (pricing engine projection — selecting changes nothing); **Card Terminal**
   keeps the current charge setting, including an intentional waiver. See "Cash / Check" below.
4. Server writes ONE QuickBooks `Payment` per installment (Accounting API — records money already collected,
   never charges a card) linked to the invoice, with the mapped PaymentMethod + deposit account, then re-reads the
   invoice: the installment is confirmed by ITS OWN payment applied to the invoice; **Paid** only when QuickBooks
   Balance = 0, otherwise **Partially paid** with the remaining balance. Later installments repeat 3–4.
5. **Email Paid Invoice** (explicit, never automatic) re-sends the SAME invoice through QuickBooks' invoice
   send. No Sales Receipt / new invoice / new sale. **Print Paid Invoice** opens QuickBooks' own PDF.

## Reliability
| Risk | Protection |
|---|---|
| Paid online / recorded directly in QuickBooks | Reconcile first; zero balance adopted (`online` / `other`) |
| Double-tap / concurrent | CAS lock `qb_payment_status → recording` (one winner) + client in-flight guard |
| Timeout / 5xx / lost response | `uncertain` (never shown Paid); reconcile by invoice LinkedTxn + `PSPAY:<estimateId>:<attempt>` tag; retry reuses the SAME attempt id as QBO `requestid` (QBO returns the original payment — verified in sandbox) |
| Unconfirmed attempt + retry with a different method / amount | The unresolved attempt (`uncertain`, or a stale `recording`) pins its request id, method and amount: any other method or amount is refused (`attempt_unresolved`) after reconciling, until QuickBooks shows it paid or a definite rejection resolves it. The lock CAS for a resume requires the same request id + method. The sheet locks the method buttons to `pendingMethod` |
| Interrupted request (`recording` stuck) | Lock older than 90 s treated as an unconfirmed attempt (same pinned identity) |
| Payment vs Sync / charge changes | `apps/quickbooks/invoice-locks.ts`: Sync's CAS requires `invoiceFreeOfPayments()` = `qb_payment_status ∉ {recording, recorded, paid, uncertain, review}` AND `qb_payment_balance_state ∉ {partial, paid}`; the payment CAS requires `qb_status ∉ {creating, syncing}`; `setEstimateWaiver` (fee/tax override) is one conditional UPDATE under the same payment condition. Same row → Postgres orders them; neither can slip between the other's check and lock |
| Change committed just before the payment lock | Invoice + draft re-verified UNDER the lock (draft total, QBO total, settled pricing); any drift → lock released, nothing written |
| Stale worker finishing late | Every payment state write is fenced on (attempt id, lock time, `recording`); a worker that was taken over writes nothing |
| Stale "paid" snapshot (worker or reconciliation) | `markPaid` only replaces the exact payment state observed before the QuickBooks snapshot (status + attempt id + lock time). A newer review / attempt survives; the caller reports the CURRENT state; the `_recorded` / `_reconciled` event is written only when the transition happened. A fresh reconciliation still adopts payments recorded outside Pitt Stop. The email path's `review` flag only replaces `paid` with the same payment id |
| Invoice not current | Shared `verifyLinkedRetailInvoice` (identity, customer, QBO total = draft) + draft must be settled (no incomplete pricing / unaccepted agreed-vs-itemized difference) + confirmed amount = live balance |
| Partial payment already in QuickBooks | Shown (payments vs credits kept apart); the remaining balance can be recorded — see Installments |
| Paid invoice edited | Sync and fee overrides refused while a payment is recorded / in flight / unconfirmed |
| Email failure | Separate `qb_paid_email_*` columns; payment untouched |
| Paid email outcome unknown (timeout / lost response / interrupted worker) | `uncertain`. A normal tap only CHECKS: confirmed when `DeliveryInfo.DeliveryTime` is strictly later than the delivery recorded at lock time (`qb_paid_email_prior_delivery_at`). Not seeing it yet is not proof of failure → nothing is sent; the UI offers **Check email status** (`checkOnly`, never sends) and an explicit **Send another copy** (`resend`, warns it may duplicate) |
| Recent unpaid-invoice email mistaken for the paid one | Baseline above (the old 5 s tolerance accepted a delivery up to 5 s BEFORE the send). Tolerance now only covers clock skew against our own start time. Same-second as the baseline → not proof. Unpaid Send is refused (early + in its lock) once a payment exists, and the paid-email lock waits while an unpaid send is in flight |
| Stale email worker | Email writes fenced on (`sending`, lock time); a superseded worker reports the current state and writes no failure |
| "Sent" wording | Means QuickBooks accepted/sent the email — never verified inbox delivery |
| Wrong QuickBooks company | Mappings pinned to `realmId`; mismatch → no method offered |

### Cash / Check: automatic card-charge removal (2026-10-20)
Owner decision: a cash or check customer does not pay the 3% Card Payment charge; Card Terminal keeps the
existing setting (incl. any intentional waiver). Totals come only from the pricing engine
(`projectEstimateTotalCents` in `apps/workflow/estimate-db.ts` — the same `projectEstimate` computation
`recomputeEstimate` stores); the UI never computes a 3% adjustment.
- **Preview** (sheet open): `methodAmounts` per method (Cash / Check = engine total with `waiveCardFee`),
  `cardFeeRemovalCents`. No writes.
- **Save** (Cash / Check with an un-waived charge), all under the payment lock:
  1. reconcile first — already paid in QuickBooks → adopted, charges untouched, no payment;
  2. confirmed amount must equal the engine's Cash/Check total (else `amount_changed` + the new amount);
  3. lock (`qb_payment_amount_cents` = that total, attempt id pinned), re-verify invoice + draft, re-read
     QuickBooks payments (paid → adopted, no fee change);
  4. remove the charge — `waive_card_fee=true` + `qb_payment_card_fee_removed=true` in ONE update fenced on
     this attempt's lock, then `recomputeEstimate`; audited as `invoice_override` (`via: record_payment`);
     stored total must equal the confirmed amount;
  5. sync the SAME invoice (`syncRetailQBInvoice({ paymentLock })` — the Sync lock is taken only while this
     exact attempt still holds the payment lock: `acquireRetailSyncLock(estId, owner)`), then verify QuickBooks
     TotalAmt = draft = confirmed amount;
  6. re-read payments, then pay that balance with the attempt id (QBO `requestid`).
- **Sync failed**: definite failure AND the invoice's SyncToken unchanged → the charge is restored (engine),
  `invoice_override` `restored` audited, payment `error`, nothing recorded. Anything else (timeout, network,
  5xx after the update was issued, or the invoice changed) → payment `uncertain`, pinned to the same method,
  amount and attempt id; a retry re-syncs (no-op if it landed), verifies, then pays once. A different method
  is refused (`attempt_unresolved`) — it can't route around the pinned attempt or re-add the charge.
- **Resume** (`qb_payment_card_fee_removed` on an unresolved attempt): pre-lock verification uses
  `verifyLinkedRetailInvoice({ allowDrift })` (identity, customer, pricing, review still enforced; total and
  "sync needed" are re-checked under the lock after the sync). Sync reports `ambiguous` only once the
  QuickBooks update request was actually issued.
- Already waived / no charge configured / Card Terminal → the original path (no sync, no change).
- Known limit: if the sync succeeded but the invoice then fails verification (another edit landed), the charge
  stays removed on both sides (consistent) and the payment is `error`; a manager can restore it in the Invoice
  Draft if the customer then pays by card. A Sync worker that crashes leaves `qb_status='syncing'` (pre-existing
  Sync behaviour) — Record Payment then reports the invoice busy.

### Flat Work Price → invoice (review fix, 2026-10-20)
Create and Sync used to convert a flat (`explicit_pretax`) Job to itemized before building the invoice. Since
05b9e84 that conversion no longer preserves the total (it keeps the agreed amount only as a reference), so a
Quick Entry flat Job with no per-service prices was invoiced at **$0** (production #100893, Doug Stickler,
2026-10-01, looks like this — owner to review; untouched), and one whose service prices differed was invoiced
at the line sum. Now a flat Job is never itemized by Create/Sync; `flatPricingIssue()` (read-only, before any
lock or QuickBooks call) allows exactly two shapes — no service priced (the existing single Labor line at the
agreed amount) or every service priced and summing to the agreed amount (per-service lines) — and refuses
anything else with the two amounts, sending the manager to the Estimate's existing reconcile flow. Record
Payment applies the same check. Not changed: standalone estimate send (`apps/estimates/quickbooks.ts`) still
itemizes a flat estimate before sending a QB Estimate — same pattern, follow-up.

Never touches `service_orders.status` / `completed_at`. Append-only events: `invoice_payment_attempt`,
`_recorded`, `_reconciled`, `_uncertain`, `_failed`, `_review`, `invoice_paid_email_sent|resent|failed|reconciled`.
Dealer jobs refused (Dealer Check-In / dealer QB unchanged).

## Owner setup before production (nothing is guessed)
Observed read-only in production QuickBooks (payments since 2026-09-01): counter payments are entered by hand
as **Credit Card (PaymentMethod 3)**, **Check (2)**, **Cash (1)**, all deposited to **Undeposited Funds (account 52)**;
online invoice payments arrive automatically as **QuickBooks Payments-Credit Card (7) / -Bank (8)**
(`TxnSource=EInvoice`). The proposed mapping below mirrors that — **the owner must confirm it**:

```json
{ "realmId": "123146329198289",
  "cash":          { "paymentMethodId": "1", "depositAccountId": "52" },
  "check":         { "paymentMethodId": "2", "depositAccountId": "52" },
  "card_terminal": { "paymentMethodId": "3", "depositAccountId": "52" } }
```
**Owner decisions confirmed (2026-10-20):**
- The Clover Mini is a **standalone** card terminal: Pitt Stop records money already collected and never
  charges a card (no QuickBooks records originate from the terminal).
- **Undeposited Funds** for Cash, Check and Card Terminal.
- Proposed production mappings Cash 1 / Check 2 / Credit Card 3 → Undeposited Funds 52 — **verify against
  the production company before activation** (not applied; production settings unchanged).
- **Cash / Check automatically remove the 3% card charge**; Card Terminal keeps the existing setting
  (including an intentional waiver). Implemented — see "Cash / Check" above.

Still to do at go-live: staff must STOP entering counter payments manually in QuickBooks for jobs recorded here.

5. (Also open) A flat Work Price with no per-service prices invoices as ONE generic Labor line ("Interior Detail, Exterior
   Wash") — the existing engine's fallback. If service-specific QuickBooks items are wanted, prices must be
   entered per service (no split is invented).
6. Review $0 invoice #100893 (and whether other flat jobs were invoiced wrong since 2026-10-01).

## Verification
**Review round 1 (2026-10-20)** — regression tests first, failing on the old code: `retail-flat-price.test.ts` (6, incl.
the $0 case), `retail-payment-service.test.ts` (+12: attempt pinning, delayed visibility, concurrent retries, stale
lock, Sync-first / payment-first / fee change / stale worker), `retail-sync-payment-guard.test.ts` (+1 real Sync
race). Sandbox invoices #1058–1063.

**Review round 2 (2026-10-20)** — regression tests first, each shown failing on the old code for the reported
reason, then passing:
- `retail-payment-service.test.ts`: old reconciliation snapshot vs newer review (was overwritten to `paid`);
  old worker paid confirmation vs newer review (was overwritten); delayed delivery metadata (a normal retry
  SENT AGAIN); accepted send with lost response, confirmation never appears (retries sent again); recent
  unpaid email (was marked `sent` with no paid email ever sent); stale email worker (its late failure
  overwrote `sent`); plus a control that email uncertainty never changes the payment.
- `retail-payment.test.ts`: `deliveredSince` baseline cases (prior unpaid email inside the old 5 s window).
- `retail-sync-payment-guard.test.ts`: unpaid Send refused for paid / recording / uncertain / review (4).
- Two round-1 stale-worker assertions tightened: the superseded worker now reports the newer state and audits
  no failure.

Results on the final code: **full suite 176 files / 2,021 tests passed**; `tsc --noEmit` clean; ESLint: 0
findings in the 24 touched files (repo-wide 240 pre-existing findings, unchanged); `next build --webpack` OK.

Sandbox (dev branch `ep-bold-surf-adhsy8f5` + sandbox realm 9341457607058056, verified by `scripts/db-target.ts`
and the harness guard; 0059 re-applied to DEV only for the new column; invoices #1064–1067):
- Normal flow: Create → Record Payment (Cash) → QuickBooks $0 → Email Paid Invoice sent once; repeat tap =
  already sent; unpaid Send after payment refused (`paid`).
- Recent unpaid email (DeliveryTime 13:57:59) + paid send that never reached QuickBooks: normal retry and
  Check returned `unconfirmed`, DeliveryTime unchanged (nothing sent); explicit Send another copy → sent,
  DeliveryTime advanced to 13:58:15.
- Paid send accepted by QuickBooks with the response lost: normal retry reconciled `sent` via DeliveryInfo;
  DeliveryTime unchanged after the retry and a repeat (no second send).
- Payment entered directly in QuickBooks: adopted as Paid ("Recorded in QuickBooks"), no second payment.
- Not reproducible against real QuickBooks deterministically (covered by unit tests only): the stale-snapshot
  and stale-worker interleavings.
- Email: sent only to `pitt-stop-sandbox-test@example.com` (RFC 2606, undeliverable). **Actual inbox delivery
  and email appearance remain UNVERIFIED** — needs an owner-authorized controlled inbox and send.
- Dev flags restored: `retail_qb_send_enabled=false`, `retail_qb_payment_enabled=false`.

**Round 3 — Cash / Check card-charge removal (2026-10-20)**
Tests added: `retail-payment-service.test.ts` (+18: preview changes nothing; Cash; Check; Card Terminal keeps
the charge; Card Terminal keeps an intentional waiver; already waived; Cash confirmed at the card amount →
refused; already paid → adopted, no removal; paid between checks and lock; definite sync rejection → charge
restored, clean retry; lost sync response after QuickBooks applied it → pinned, method switch refused, retry
pays once with the same attempt id; sync timeout before QuickBooks applied it; lost payment response after
sync; double submission → one removal / sync / payment; manual Sync / fee change / second attempt can't
interleave; superseded worker can't sync; amount changed after confirmation; completion date untouched),
`retail-sync-payment-guard.test.ts` (+1: only the attempt holding the payment lock may sync),
`apps/workflow/estimate-card-fee-projection.test.ts` (4, REAL engine: preview = stored total once waived, for
itemized / flat / already waived / dealer; the preview writes nothing). The harness's draft now follows the
real `waive_card_fee` column; existing tests run with no charge configured (one assertion updated).

Results: **full suite 177 files / 2,044 tests passed**; `tsc --noEmit` clean; ESLint: 0 findings in the files
changed this round (the 14 findings in `OrderDetail.tsx` / `InvoiceDraftPanel.tsx` are identical on the base
commit); `next build --webpack` OK.

Sandbox (dev branch `ep-bold-surf-adhsy8f5` verified by `scripts/db-target.ts`; sandbox realm
9341457607058056; 0059 re-applied to DEV only for `qb_payment_card_fee_removed`; fee config 3% supplies + 3%
Card Payment on work+supplies). Invoices are "PS SANDBOX TEST CardFee 10202152 …":
| Invoice | Scenario | Result |
|---|---|---|
| #1068 | Cash, $150 work | Preview Cash/Check $154.50, Card $159.14; nothing changed by preview; confirming $159.14 for Cash refused (`amount_changed`, $154.50); Save → same invoice synced (Card Payment line removed, TotalAmt 154.50), payment 198 $154.50, Balance 0 |
| #1069 | Check | $92.70 (card $95.48), payment 200 on PaymentMethod 2, Balance 0 |
| #1070 | Card Terminal | $95.48 incl. Card Payment $2.78, no sync, payment 202 |
| #1071 | Resume: charge removed locally, invoice update never reached QuickBooks | Preview pinned to Cash $82.40; Card Terminal refused (`attempt_unresolved`); retry synced (84.87 → 82.40) and paid once (204) |
| #1072 | Resume: update landed, response lost (synced under the attempt's lock) | Retry: sync no-op, paid once (206) |
| #1073 | Paid directly in QuickBooks before Save | Adopted (payment 208, "Recorded in QuickBooks"); charge NOT removed (TotalAmt 74.26 unchanged) |
| #1074 | Double submission | One `paid`, the other `recording`; one sync, one payment (210) |

Paid PDF #1068 (QuickBooks' own): Interior Detail 150.00, Shop supplies 4.50, no card line, PAYMENT 154.50,
BALANCE DUE $0.00, PAID stamp.

**Owner-authorized single test email:** #1068 → `torlanpittman@gmail.com`, requested 2026-10-20 21:56:26 UTC;
QuickBooks accepted it: `EmailSent`, DeliveryTime 2026-10-20T14:56:28-07:00, BillEmail torlanpittman@gmail.com,
TotalAmt 154.50 / Balance 0. One send only; no resend. **Owner confirmed 2026-10-20: email received; it
shows the invoice paid with a $0 balance.**
Dev flags restored to their prior values (`retail_qb_enabled=true`, `retail_qb_payment_enabled=false`,
`retail_qb_send_enabled=false`, mappings unchanged). Scratch credentials deleted.

## Installments — partial payments and later payments (2026-10-21, branch `feat/partial-payments`)
Business flow: Record $2,000 of a $2,411 invoice on the Clover terminal → **Partially paid · $2,000 received ·
$411 left**; later record $411 (any method) on the SAME invoice → **Paid** once QuickBooks shows $0.00.

- **One QuickBooks Payment per installment**, each with its own attempt id (QBO `requestid` + `PSPAY` tag). The
  invoice lines are never reduced, no replacement invoice, no local ledger: per-payment history (date, method,
  amount, money vs credit) is read from QuickBooks every time the sheet opens.
- **State split (migration 0061):** `qb_payment_status` = the LATEST ATTEMPT (adds `recorded` = installment
  confirmed, balance open). `qb_payment_balance_state` (unpaid|partial|paid) + total/balance/received/credit cents
  cache QuickBooks' AGGREGATE from the last read (summary card + invoice lock only). A later failed attempt
  (`error`) never makes a partially paid invoice editable or look unpaid.
- **Confirmation by attempt, never by balance:** an unconfirmed installment is confirmed only when QuickBooks
  shows the Payment carrying its attempt id applied to this invoice for the confirmed amount. Another payment of
  the same amount (online, in QuickBooks, or an earlier Pitt Stop installment) never confirms it.
- **Renewed confirmation:** the client sends `{ amountCents, balanceCents }`; if QuickBooks' balance differs from
  the one confirmed (checked before the lock AND re-read under it), nothing is written (`balance_changed`).
  Server validation: positive integer cents ≤ open balance (`invalid_amount` / `over_balance`).
- **Unresolved attempt blocks new installments** until confirmed or definitely rejected; retry only with the same
  id, method AND amount (the resume CAS now also pins the amount).
- **Credits vs cash:** a credit memo spent inside a Payment, and any reduction no Payment explains, are reported as
  "Credits & adjustments", never as money received.
- **Card-payment charge (unchanged for full payments):** Cash/Check paying an UNPAID invoice in full = the existing
  automatic removal + sync. Any partial amount, and every later installment, leaves the invoice and its charge
  exactly as confirmed (no proportional math). Cash/Check for more than the charge-removed full amount on an
  unpaid invoice is refused, so cash is never accidentally charged the card fee.
- **Locked after the first installment:** Sync and charge overrides are refused once any payment/credit is
  applied (as for paid invoices) — corrections to a partially paid invoice are made in QuickBooks.
- Email Paid Invoice / Print Paid Invoice unchanged (paid only). A partially paid invoice offers **Print invoice
  (shows payments)** (QuickBooks' own PDF); nothing is ever emailed automatically.
- Older clients (`confirmedAmountCents` only) keep the full-payment contract.

### Review fixes (adversarial review, 2026-10-21)
- **Lost response + re-confirm = no duplicate.** The phone sends a `confirmationId` (UUID, one per method + amount,
  reused by every retry until confirmed). The attempt id is that key (or `<key>-r<hex>` after a definite failure,
  since QuickBooks may replay a requestid's response); a retried Save first looks for a QuickBooks Payment tagged
  with the key and returns it as recorded — even when the balance it saw is now lower.
- **Estimate edits after a partial payment no longer strand the balance.** Once money is applied the invoice is
  frozen, so later installments are verified for identity + customer only and recorded against QuickBooks' invoice
  as it stands; a zero balance is adopted before any draft check. (Pitt Stop's estimate may then differ from
  QuickBooks — corrections to a partially paid invoice are made in QuickBooks.)
- **Never confirmed by a zero balance:** if our Payment was created but isn't applied while other payments zeroed
  the invoice → `review` (possible double payment / unapplied payment).
- **Full vs partial intent:** the phone sends `intent`; "in full" whose server-side amount moved, or "partial" that
  would now remove the card charge → `amount_changed`, nothing recorded.
- **Paid, then reopened in QuickBooks** (payment deleted/refunded) → `review`, never shown as Paid.
- The payment write is fenced right before the QuickBooks call (a worker whose lock was taken over writes nothing).
- Sync refuses (needs review) when the LIVE QuickBooks invoice already has money applied that Pitt Stop hasn't read.
  Code-read + typecheck only — the Sync test harness can't reach that point without a payload stub.
- Known, not changed: `review` has no in-app clear (resolved in QuickBooks, then by an admin); the cached aggregate
  can be refreshed out of order by two concurrent readers (display/lock cache only — Sync now also checks live).

### Codex independent review round (2026-10-21)
- **Dangling attempt vs. an outside payment.** An unconfirmed attempt is no longer erased when a *different*
  payment/credit closes the balance: `verifyAndReconcile` keeps the attempt as `uncertain` and caches the paid
  aggregate separately (status split), never emitting a Paid receipt for it. Resuming such an attempt when the
  invoice was paid elsewhere → `review` (possible duplicate). The post-ambiguous-error path no longer confirms
  from a zero balance without the attempt's own applied payment.
- **Stale invoice/payment snapshot.** `summarizeInvoicePayments` now reports `coherent`; a brand-new installment
  is refused (`invoice_busy`, "QuickBooks is still catching up") when a Payment is visible but the invoice
  Balance/LinkedTxn lag. A retry of a KNOWN confirmation (matched by its tag) is unaffected.
- **Mixed-invoice credit allocation.** When one Payment spreads a credit across several invoices, the cash-vs-credit
  split for this invoice is indeterminable → the read is refused (`invalid_balance`), never a guessed 50/50 split.
  A single-invoice payment with a credit memo still splits cleanly.
- **Comma grouping.** `parseAmountInput` validates thousands grouping before stripping commas: `2,000.00` ok,
  `20,00` / `,000` / `1,2345` rejected (previously `20,00` was read as `$2,000`).
- **Phone recovery (`nextEntry`, exported + unit-tested; no DOM test env here).** "Check QuickBooks" / lost-response
  recovery now KEEP the typed amount + method; a fresh open clears them; a pinned attempt always overrides.
  `balance_changed` loads a fresh server preview (full amounts per method) instead of hand-building them. Added
  dialog focus + Escape, amount-field autofocus, and 44px close/"Full"-chip touch targets.

### Codex review round 2 (2026-10-21)
- **A missing/unexplained balance drop is never guessed as credit.** `summarizeInvoicePayments` reconciles by
  evidence: a Payment the invoice lists but we couldn't read → `ok:false` (incomplete read); a drop larger than
  the read Payments explain is credit ONLY if the invoice links a credit memo, else `ok:false`; a Payment visible
  but not yet absorbed by the balance → not coherent, never credit; a visible Payment the balance already reflects
  (not yet in LinkedTxn) counts as **received**, not credit.
- **UI cached figures are labelled, not claimed as live.** The partial/paid cards show the aggregate "as of
  &lt;checked-at&gt;" (new `checkedAt` on the payment state), and when the latest refresh didn't complete the card
  says the last-confirmed figures are shown and to re-open Record Payment to refresh.
- **Credit recognition restricted to `CreditMemo`** (round-2 follow-up): any other non-Payment invoice link
  (Estimate, TimeActivity, …) is not evidence of a credit; a listed Payment that isn't readable or doesn't
  positively allocate to this invoice is an incomplete read → refused.

**Verification status for the Codex rounds (2026-10-21):** an independent phone test passed (record $2,000 then
$411, amount+method preserved on a network failure, same-confirmationId retry, distinct later installment, no
overflow). A full suite of 183 files / 2,186 tests + `tsc` passed **before** the round-2 summarize/UI edits above —
that is prior-round evidence, **not** a post-change result. The suite/tsc/lint/build must be re-run by Codex on the
current code; no green claim is made here for the round-2 changes.

## Open owner decisions (nothing guessed)
1. Verify the proposed production mappings (Cash 1 / Check 2 / Credit Card 3 → Undeposited Funds 52) against
   the production QuickBooks company before activation.
2. ~~Confirm receipt of the sandbox test email~~ — confirmed by the owner 2026-10-20 (paid, $0 balance).
3. **Card-payment charge on mixed-method installments** (before releasing installments): today a partial payment
   keeps the full card charge on the invoice even if part (or the rest) is later paid by Cash/Check. Options:
   keep as is; or allow a manager to remove the charge BEFORE the first installment (existing override); or a
   defined rule for removing it later. No proportional/debit rule is implemented.
4. Whether a partially paid invoice may be Synced from Pitt Stop when services change (currently refused —
   correct it in QuickBooks), and whether staff need an emailed balance statement (currently print only).

## Separate follow-ups (not in this patch; no historical records modified)
- $0 production invoice #100893 (and any other flat Jobs invoiced since 2026-10-01) — owner review.
- Standalone estimate send (`apps/estimates/quickbooks.ts`) still itemizes a flat estimate before sending a
  QuickBooks Estimate — same pricing pattern as the fixed Create/Sync.

## Go-live checklist — installments (needs explicit approval)
1. Apply `drizzle/migrations/manual/0061_retail_payment_installments.sql` to production (additive, nullable,
   idempotent) BEFORE the deploy. 2. FF-deploy the scoped commit. 3. Verify via the Vercel API + a read-only
   preview. Rollback = previous deployment (the 0061 columns are ignored by older code); kill-switch
   `retail_qb_payment_enabled=false`.

## Go-live checklist — original full payment (done 2026-10-20)
1. Apply `drizzle/migrations/manual/0059_retail_invoice_payment.sql` (additive, idempotent; now also adds
   `qb_paid_email_prior_delivery_at` and `qb_payment_card_fee_removed`).
2. Deploy. 3. Set `retail_payment_mappings` (confirmed values). 4. Set `retail_qb_payment_enabled=true`.


## Final independent release verification — 2026-10-21

Codex independently verified the final source after all three correction rounds with the same Claude session `d70aa1f7-f2f0-4ae3-ad5a-d96c6c7e3b52`. Full suite: **183 files, 2,193 tests passed**; TypeScript check passed; ESLint passed for the payment helper/service, InvoicePaymentSection, and invoice-draft; production webpack build passed. Source hashes were compared against the tested clean snapshot. Three additional independent service regressions passed (lost-response duplicate, unresolved attempt plus external payoff, lagging invoice balance blocking another installment).

A local 390×844 browser test of the actual payment component passed: $2,000 followed by $411, retained method/amount after network failure, stable confirmation key on retry and new key for next installment, cached-balance timestamp and failed-refresh warning, Paid at zero, and no horizontal overflow. All payment responses were fictional/local mocks. No real accounting writes, sends, production migration, push, or deployment occurred.

Release candidate includes e877be2 **plus the follow-up correction commit**; do not release e877be2 alone. Remote main was rechecked at bb2aa2830a7d78331fb21054d03715a9e4c08086. Migration 0061 remains unapplied. Before release, reverify deployment/DB target and obtain owner approval for applying the migration and deploying. QuickBooks reported subscription RESTRICTED; real payment-write capability remains unverified. Unexplained/incomplete credit evidence fails closed; unusual credit allocation and post-payment invoice corrections may require QuickBooks.
