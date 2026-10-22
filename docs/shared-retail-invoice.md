# Shared retail invoice (one QuickBooks invoice, several vehicles)

**Release preparation (2026-10-22):** built on `feat/shared-retail-invoice` (worktree `.ps-worktrees/shared-invoice`, off
production `origin/main` d27a0e2). Runtime rollout is verified separately through Vercel and the live flag. **Migration 0062 IS applied and
verified on production** (`ep-morning-base-adq5h6rq`; additive — `retail_invoice_members` + `job_estimates.qb_lines_fingerprint`),
before rollout; the flag defaults **OFF**. **Sandbox writer + PDF verified:** a 2-vehicle
shared invoice was created, updated, and deleted in the QuickBooks **sandbox** (invoice 211) — DescriptionOnly
vehicle-header lines are accepted, returned, and render on the invoice; **no email/send** was performed. See
"Deploy" below. Nothing here has touched production QuickBooks.

## What it does

A customer brings a second vehicle while the first one's invoice is still open (e.g. Kelvin Cooper). After a
manager saves the new **retail** Job in Quick Entry (intake unchanged), the app looks for that customer's open,
unpaid, app-created retail invoice and offers:

> **Kelvin Cooper has an open invoice.** Would you like to add this vehicle to that invoice?
> Invoice #1001 · 2019 Honda Accord · $412.00 open · Not emailed yet — **Keep separate** / **Add to invoice**

- **Add to invoice** only *links* the Job (state `pending`). Nothing is charged, written to QuickBooks, or
  emailed.
- Later a manager opens either Job's invoice → **Review & update invoice**: a per-vehicle breakdown (services,
  shop supplies, card charge, tax, vehicle total) + the combined total → **Update invoice** rewrites the SAME
  QuickBooks invoice. If it was already emailed, the manager must tick an acknowledgement. It is **never
  resent automatically**. Resend stays the separate, existing action.
- **Keep separate** (on the offer, or later on a still-pending Job) leaves/returns the vehicle to normal
  separate billing.
- No eligible invoice → nothing is shown. Lookup failure → the Job stays saved and a non-blocking notice says
  to retry from the Job's invoice ("Add to this customer's open invoice…" on the Invoice Draft).
- Employees: intake works exactly as before. The lookup, offer and all link/update actions are manager/admin
  only, enforced server-side (403).

## Model: anchor + members

| | Anchor Job | Member Job |
|---|---|---|
| QuickBooks invoice | owns it: `job_estimates.qb_invoice_id`, PSID tag, 0019 unique index (unchanged) | `qb_invoice_id` stays NULL |
| `job_estimates.qb_status` | its normal lifecycle | `'linked'`, so Create's compare-and-set refuses (never a 2nd invoice) |
| Row | — | `retail_invoice_members` (`pending` → `applied`, or `removed`) |
| Own Job / estimate / history / `completedAt` | unchanged | unchanged |

Combined invoice payload = each Job's own `buildRetailWorkPayload` segment (each asserts Σ = that Job's own
Invoice Draft total), arranged for the customer as: each vehicle's **service** lines under its QuickBooks
**DescriptionOnly** header `Vehicle N of M — 2019 Honda Accord · VIN …`, then — after every vehicle section —
**one combined shop-supplies line and one combined card-payment line**. Each combined fee line is the exact
**sum of the per-job fee cents** it aggregates: per-job caps, waivers and rounding have already been applied by
each Job's own Invoice Draft, so no fee is re-computed, re-based or re-rounded here (`combineSharedPayload` still
asserts Σ all priced lines === Σ each Job's draft total). Memo lists every vehicle; PrivateNote
`PSID:<anchor> | PSLINK:<members>`. One pricing engine, one Invoice Draft, canonical QB descriptions. A
single-Job invoice is byte-identical to before.

**Fee identity is semantic, never by display text.** Each built fee line carries an internal `fee`
(`shop_supplies` | `payment`) tag set by `buildRetailPayload`; the combiner groups fees by `fee` + item ref +
label and sums each group, so a *service* that happens to be named like a fee is never treated as one, and
fee lines with **incompatible** item refs/labels (e.g. a different configured card-fee label) are **never
silently merged** — each distinct group becomes its own combined line. Canonical order is shop supplies before
card payment, independent of which Job carried each first. The `fee` tag is **internal only**: it is dropped
before the QuickBooks wire (`buildLine`), before the line fingerprint (`linesFromPayload`), and before the
content hash (which projects each line to its wire fields), so a single-Job invoice's wire output **and** stored
content hash are unchanged.

**Backward compatibility (invoices written before the combined layout).** `combineSharedPayload(…, { layout:
'legacy' })` deterministically reconstructs the ORIGINAL per-vehicle layout (each Job's fee lines interleaved
after its services). Discovery (`assessCandidate`) accepts either exact layout. Preview retains the stored-fingerprint guard, with
legacy target recovery allowed only for a failed pending update. Sync also accepts either exact target layout — so an invoice
created under the old layout is still recognised as Pitt Stop's (and a reviewed update migrates it to the
combined layout), while any **other** line set still fails closed as a QuickBooks-side edit. The two accepted
layouts are exact, deterministic rebuilds; no broad normalization accepts arbitrary edits, so the tamper guards
are not weakened. No migration and no automatic real invoice edit — an existing invoice only changes the next
time a manager runs the reviewed Update (or an ordinary Sync) on it.

## Safeguards (each enforced server-side)

- **Retail only.** Dealer Jobs are skipped before any customer/QB lookup, refused by link, and never
  candidates. Dealer Check-In / dealer pricing / dealer QB untouched.
- **Confirmed customer only:** `resolveConfirmedRetailCustomer` uses directory email/phone or a *unique* QB
  email. Never a name, never creates a customer. Ambiguous → no offer.
- **Eligible invoice** = this customer's, PSID-tagged, app-created, total > 0, balance == total, no
  Payment/CreditMemo/other linked txn, not voided/deleted, not syncing/needs-review, and its live lines equal
  what Pitt Stop would rebuild (so unrelated QB lines are never overwritten).
- **Never auto-merges two invoices:** a Job that already has its own invoice is refused ("reconcile them in
  QuickBooks").
- **Re-checked fresh** at link (customer, invoice identity, balance/payments, QB SyncToken vs. the offer) and
  again at update (`expectedSyncToken` from the review, line fingerprint, member customer, each Job's charges
  gates).
- **Line fingerprint** (`job_estimates.qb_lines_fingerprint`): if the invoice's lines were edited in
  QuickBooks, update refuses (`lines_changed`) instead of overwriting. The fingerprint normalizes only our
  item + DescriptionOnly lines (SubTotal and anything else are dropped), so the shared write ALSO fails closed
  on any line type it can't rebuild — a Discount/Group/unknown line → `lines_changed`, never silently
  overwritten — and **reruns the full money state at write time** (`invoiceMoneyState`), rejecting a $0/voided
  total, a missing balance, or a Payment/Credit/Deposit linked even at an equal balance (not just `Balance < Total`).
- **Stale invoice can't go out:** Send / Resend and Record Payment are blocked while any member is `pending`
  (`shared_pending`). Send also **re-reads members under its own sending lock, before any email fill/send**, and
  refuses if a member linked between the precheck and the lock — closing the precheck→lock race (link already
  refuses while the anchor is `sending`). Cash/Check auto card-fee removal is disabled on shared invoices (the
  manager removes a Job's card charge in its draft, then updates).
- **Atomic + idempotent** (neon-http has no interactive transactions → single-statement data-modifying CTEs
  with `FOR UPDATE` on the anchor row): link writes membership + member `'linked'` + anchor fingerprint in one
  statement. `rim_member_active_uniq` stops double taps/races. A replayed link is `alreadyLinked`. Update reuses
  Sync's lock + CAS, and after a successful QuickBooks write it **holds that lock (`qb_status = 'syncing'`) until
  membership is finalized** (members moved `pending → applied`), then releases it last — so a concurrent unlink
  can never remove a member whose charges are already on the invoice.
- **Recovery after a DB failure that follows a successful QuickBooks write** (the reviewed update's QB call lands
  but local finalization fails → `qb_status = 'error'`, member still `pending`, charges already on the invoice).
  Four guards keep this from double-billing or stripping charges, and make it recoverable:
  - **Pre-write refusals keep the anchor in `error`.** A reviewed retry that is refused before any QuickBooks
    write (stale review, member unready/customer mismatch, needs-review) restores the anchor's PRIOR status
    (`est0.qbStatus`) rather than promoting it to `created`/`sent` — so an anchor already `error` from the
    ambiguous landing stays `error` and never looks settled.
  - **Unlink is allowed only from a positively settled `created`/`sent` anchor that is NOT "Needs review"** (its
    CTE also refuses `qb_sync_error ILIKE 'needs review%'`). So the pending member can't be unlinked while the
    invoice is `error` or under review, and can't then create a second invoice. (This also means "keep separate"
    is refused while the invoice needs review — resolve the invoice first.)
  - **An ordinary Sync (`applyPending = false`) refuses while any member is `pending`** (`shared_pending`): it
    rebuilds from anchor + APPLIED members only, so running it after an ambiguous landing would strip the
    pending member's already-written charges. Only the reviewed **Update invoice** (`applyPending = true`, under
    `expectedSyncToken`) may change a shared invoice while a member is pending.
  - **Re-running the reviewed Update reconciles:** QuickBooks already holds the target lines, so the fingerprint
    check passes, the write is idempotent, and the pending member is applied. The review screen allows this
    recovery only when the error-state invoice exactly matches the rebuilt combined lines and total; unrelated
    QuickBooks edits still block.
- **Applied members** can't be unlinked or Work-Board-removed (that's a QuickBooks correction; the remove
  sheet explains). A later price change on an applied member flags the **anchor** "sync needed".
- **Completion** never depends on any of this (no hooks in Finish Job).
- **Reporting counts each Job's own total once:** marketing attribution counts an applied member's own total
  (the anchor counts only its own, not the combined), CFO earned-uninvoiced excludes applied members,
  customer history shows the shared invoice number on members. Payments live on the one QB invoice, never
  duplicated.
- **Append-only audit** (`service_order_events`): `shared_invoice_linked` / `_member_added`,
  `_unlinked` / `_member_removed`, `_applied` (member), `_updated` (anchor, with per-vehicle breakdown),
  `_update_refused`.

## Files

- Schema: `apps/workflow/schema.ts` (`retailInvoiceMembers`, `jobEstimates.qbLinesFingerprint`);
  migration `drizzle/migrations/manual/0062_retail_shared_invoice.sql`.
- Fee identity: `apps/quickbooks/retail-invoice.ts` (`RetailFeeKind`, the `fee` tag on `RetailBuiltLine`, set in
  `buildRetailPayload`).
- Pure plan: `apps/quickbooks/shared-invoice-plan.ts` (`combineSharedPayload` with the `layout` option +
  `combinedLines` / `legacyLines`). DB reads: `apps/quickbooks/shared-invoice-db.ts`.
- Orchestration: `apps/quickbooks/shared-invoice.ts` (`findSharedInvoiceCandidates`, `linkToSharedInvoice`,
  `unlinkSharedInvoiceMember`, `loadSharedInvoiceState`, `previewSharedInvoiceUpdate`, `updateSharedInvoice`).
- Existing services extended (no parallel writer): `retail-invoice-service.ts` (Create refuses `linked`, Sync
  `applyPending` + `expectedSyncToken`, combined payload, Send/verify `shared_pending`),
  combined payload + legacy reconstruction accepted by discovery/Sync fingerprint checks; `retail-invoice-write.ts`
  (DescriptionOnly lines, `listRetailInvoicesForCustomer`, fingerprint),
  `retail-customer.ts`, `retail-payment-service.ts`, `apps/workflow/estimate-db.ts`, `order-removal.ts`.
- Route: `app/api/workflow/orders/[id]/invoice/shared/route.ts` (GET state / `?discover=1`; POST
  link | unlink | preview | update).
- UI: `app/components/SharedInvoice.tsx` (offer sheet, Invoice Draft section, review sheet), wired into
  `app/quick-entry/QuickEntryFlow.tsx` (done screen), `app/orders/[id]/InvoiceDraftPanel.tsx`,
  `app/orders/[id]/OrderDetail.tsx` (Completion Summary), `app/work-board/VehicleCard.tsx`.
  **"Review & update invoice"** remains available from either Job while the feature is on, including when no
  vehicle is pending. It uses the existing reviewed-update endpoint, which resolves the invoice owner and checks
  all payment, identity and stale-review guards. The review sheet explains the combined fee presentation.
- Flag: `retail_qb_shared_invoice_enabled` (env `RETAIL_QB_SHARED_INVOICE_ENABLED`), default **OFF**,
  effective only with `retail_qb_enabled` + `retail_qb_sync_enabled`. Existing shared state still displays
  when it's off; no new links/updates.

## Tests

`apps/quickbooks/shared-invoice.test.ts` (41, PGlite + real pricing/Invoice Draft/Create/Sync/Send, fake QB
whose send throws — incl. equal-balance/voided/no-balance money reruns, a discount line refused at the write,
an ordinary Sync refused while a member is pending, a DB-finalization-failure-after-QB-success recovery proving
no unlink / no 2nd invoice / no stripped charges then a reviewed retry reconciles, a reviewed retry refused
pre-write keeping the anchor in `error` with unlink still refused, a send-precheck→lock link race proving the
fake send is never reached, an unlink injected
the instant the post-QB persist resolves being refused because the lock is still held — via a test-only Drizzle
`.then` proxy, no production seam — and a **legacy-layout** invoice standing in for one created before the combined
presentation: discovery stays eligible, a foreign edit on top of it is still refused, and a reviewed update with
**no pending members** migrates it to the combined layout at the unchanged total), `shared-invoice-plan.test.ts`
(combined aggregation: exact per-job fee cents, three vehicles, waived fee with shop-supplies-before-card ordering,
a service named like a fee, incompatible item-ref/label groups never merged, legacy reconstruction + tamper
refusal, plus `overwriteUnsafeLineTypes`), `retail-invoice.test.ts` (fee-line `fee` tagging + a fee-named service
staying a service),
`retail-customer.test.ts` (+4 identity),
`app/api/workflow/orders/[id]/invoice/shared/route.test.ts` (6 role/flag gates),
`apps/marketing/report.integration.test.ts` (+1 counted-once), `apps/directory/customer-profile.test.ts`
(+1). Migration 0062 checked: applied (twice) to a pre-feature DB it yields exactly the Drizzle schema.

## Verified / still to verify

- **VERIFIED (sandbox):** QuickBooks accepts and returns the `DescriptionOnly` vehicle-header lines and renders
  them on the invoice — a 2-vehicle shared invoice was created, updated, and deleted in the sandbox (invoice
  211), **no send**. **VERIFIED (production):** migration 0062 applied and confirmed; flag OFF.
- Still to check before enabling: a browser walkthrough once the flag is turned on in a controlled window
  (local DB is production → writes blocked by the guard, and the flag is off).
- Discount lines added in QuickBooks aren't part of the line fingerprint, but the shared write now fails
  closed on any unsupported line type (Discount/Group/unknown → `lines_changed`), so such an invoice is
  refused rather than overwritten. Still sandbox-check how QuickBooks represents a discount on a returned
  invoice to confirm the DetailType matches what this guard keys on.

## Deploy (each step needs explicit owner approval)

1. Commit on `feat/shared-retail-invoice` → fast-forward onto `origin/main` per the usual worktree process.
2. Migration `0062` is **already applied and verified on production** (`ep-morning-base-adq5h6rq`, additive,
   idempotent) — it intentionally went first so the attribution/CFO/customer-history queries that reference
   `retail_invoice_members` keep working the moment code deploys. Nothing to apply here; just confirm it's present.
3. Deploy, then confirm via the Vercel API. Flag stays OFF → behavior identical to today.
4. Sandbox/controlled verification of a 2-vehicle invoice (no send), then the owner sets
   `retail_qb_shared_invoice_enabled = true` in `app_settings`. Kill switch: set it back to false.

## Independent release verification (2026-10-22)

- Full suite: 186 files, 2,262 tests passed after review fixes.
- Targeted shared-invoice suite: 57 passed.
- Exact post-write race test fails with the original early-unlock behavior restored, then passes with the fix.
- Review-screen recovery assertion reproduced the blocked retry and passes with exact-target recovery.
- Lint comparison: 29 existing findings, no new findings across 31 changed source/test files.
- Sandbox invoice 211: same-invoice update, two DescriptionOnly headers, exact total, and PDF visual check passed; temporary invoice deleted; no email.
- Production migration 0062 applied before code rollout; table and fingerprint column verified.
- No production QuickBooks write or email was performed during verification. Staff browser walkthrough remains owner verification after rollout.

## Related: Combine unpaid invoices

Two invoices that ALREADY exist (each Job invoiced on its own) are combined by a separate, reviewed operation
that voids one and makes its Job a member of the other — see `docs/combine-unpaid-invoices.md`. Link still never
merges two existing invoices.
