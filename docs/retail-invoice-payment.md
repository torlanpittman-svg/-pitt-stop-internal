# Retail invoice payment — Record Payment / Email Paid Invoice

Status (2026-10-20): built + sandbox-validated on branch `feat/retail-invoice-payment` (incl. automatic
Cash / Check card-charge removal).
**Not deployed. Migration 0059 not applied to production. Flags off.**

## Flow
1. **Create QuickBooks Invoice** (existing) → the invoice card shows **Send Invoice** and **Record Payment**.
2. **Send Invoice** (existing, unpaid) leaves Record Payment available until QuickBooks shows a $0.00 balance.
3. **Record Payment**: opening it verifies the invoice against the Invoice Draft and checks QuickBooks for
   existing payments (paid online → adopted, nothing written). Choose **Cash / Card Terminal / Check** →
   confirm the amount → **Save Payment**. No tips, no partial payments. **Cash / Check** show the amount with
   the card-payment charge removed (pricing engine projection — selecting changes nothing); **Card Terminal**
   keeps the current charge setting, including an intentional waiver. See "Cash / Check" below.
4. Server writes ONE QuickBooks `Payment` (Accounting API — records money already collected, never charges
   a card) linked to the invoice, with the mapped PaymentMethod + deposit account, then re-reads the invoice:
   **Paid** only when QuickBooks Balance = 0.
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
| Payment vs Sync / charge changes | `apps/quickbooks/invoice-locks.ts`: Sync's CAS requires `qb_payment_status ∉ {recording, paid, uncertain, review}`; the payment CAS requires `qb_status ∉ {creating, syncing}`; `setEstimateWaiver` (fee/tax override) is one conditional UPDATE under the same payment condition. Same row → Postgres orders them; neither can slip between the other's check and lock |
| Change committed just before the payment lock | Invoice + draft re-verified UNDER the lock (draft total, QBO total, settled pricing); any drift → lock released, nothing written |
| Stale worker finishing late | Every payment state write is fenced on (attempt id, lock time, `recording`); a worker that was taken over writes nothing |
| Stale "paid" snapshot (worker or reconciliation) | `markPaid` only replaces the exact payment state observed before the QuickBooks snapshot (status + attempt id + lock time). A newer review / attempt survives; the caller reports the CURRENT state; the `_recorded` / `_reconciled` event is written only when the transition happened. A fresh reconciliation still adopts payments recorded outside Pitt Stop. The email path's `review` flag only replaces `paid` with the same payment id |
| Invoice not current | Shared `verifyLinkedRetailInvoice` (identity, customer, QBO total = draft) + draft must be settled (no incomplete pricing / unaccepted agreed-vs-itemized difference) + confirmed amount = live balance |
| Partial payment already in QuickBooks | Refused — finish in QuickBooks |
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

## Open owner decisions (nothing guessed)
1. Verify the proposed production mappings (Cash 1 / Check 2 / Credit Card 3 → Undeposited Funds 52) against
   the production QuickBooks company before activation.
2. ~~Confirm receipt of the sandbox test email~~ — confirmed by the owner 2026-10-20 (paid, $0 balance).

## Separate follow-ups (not in this patch; no historical records modified)
- $0 production invoice #100893 (and any other flat Jobs invoiced since 2026-10-01) — owner review.
- Standalone estimate send (`apps/estimates/quickbooks.ts`) still itemizes a flat estimate before sending a
  QuickBooks Estimate — same pricing pattern as the fixed Create/Sync.

## Go-live checklist (needs explicit approval)
1. Apply `drizzle/migrations/manual/0059_retail_invoice_payment.sql` (additive, idempotent; now also adds
   `qb_paid_email_prior_delivery_at` and `qb_payment_card_fee_removed`).
2. Deploy. 3. Set `retail_payment_mappings` (confirmed values). 4. Set `retail_qb_payment_enabled=true`.
