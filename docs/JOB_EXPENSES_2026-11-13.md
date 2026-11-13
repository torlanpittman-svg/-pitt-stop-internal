# Job expenses, one purchase identity, and the reconcile view (2026-11-13)

What this release adds: attach a receipt (photo, PDF, or pasted email text) to a **customer job** from the job
screen, see each job's recorded expenses, and review how receipts line up with the bank, jobs, expected bills
and the sales-inventory ledger. Migration **0078**. No QuickBooks call, no invoice change, no money movement.

Release state, verification evidence and the Tesla acceptance record are in §8–§9.

---

## 1. Expense source of truth

**One purchase = one `business_receipts` row.** That row is the expense. Everything else is a *view* of it:

| View of the purchase | Where it lives | How it is linked to the receipt |
|---|---|---|
| Original receipt / vendor invoice | `business_receipts` (+ private Blob: photo, PDF, or pasted text) | it *is* the row |
| Customer job (or overhead) | `expense_allocations` (new, 0078) | `receipt_id` → row; `service_order_id` → job |
| Sales-inventory vehicle | `business_receipts.inventory_vehicle_id` (unchanged) | column on the row |
| Bank / card transaction | `fin_receipt_matches` (existing) | `receipt_id` PK → `txn_id`; **human-confirmed only** |
| QuickBooks record | `business_receipts.qb_sync_status / qb_entity_ref` | **reserved, never written** — see §5 |

An allocation is a **pointer, never a second expense**. No business total reads `expense_allocations`:
`monthlyExpenseReport` and the CFO receipt coverage still sum `business_receipts`. Attaching, splitting, moving
or removing a job link cannot change total business expenses (tested: `job-expenses.integration.test.ts`).

### Allocation rules (`apps/expenses/allocations.ts`, `apps/expenses/job-expenses.ts`)

- `amount_cents NULL` = the **whole purchase**. Its value *follows* the receipt total, so correcting the receipt
  corrects the job cost. Shipping and tax are inside `total_cents` and are counted once.
- `amount_cents > 0` = an explicit **split** amount. Splits across jobs and/or **overhead** may never exceed the
  receipt total; the unassigned remainder stays visible ("$X of $Y not assigned yet").
- One active allocation per (purchase, job); one active overhead allocation; at most one active whole-purchase
  allocation — enforced by partial unique indexes, so a double-tap or retry cannot attach twice.
- The driver has no interactive transaction, so after an insert the purchase is re-summed and a concurrent
  over-allocation is backed out. Anything that still ends up over is listed as a discrepancy (§6).
- **Correction / reassignment:** the old row is marked `removed` (`removed_by/at/reason`, `replaced_by` → the new
  row) and a new row is inserted. Rows are never deleted. Every link, change and removal is appended to the
  receipt's `audit_log` (`allocated`, `allocation_changed`, `allocation_removed`).
- **Job total** = sum of active allocations whose receipt is `filed`/`approved`. A receipt still in review is
  listed as "needs review — not in total".
- **Parts.** A job part line's typed internal cost and a receipt for that part are the same purchase. Part costs
  with no receipt tied to them are shown *separately* and are **not added** to the job total. Tie a receipt to
  the part ("Fix or move" → pick the part) to reconcile them (`expense_allocations.job_part_id`).

### What did *not* change

- **Customer selling price.** A job expense needs none and creates no part line and no invoice line — "not
  priced yet" stays not priced; it is never stored as $0/free. The Job screen's "Add a part" still requires a
  customer price (owner decision 2026-11-03); recording our cost before pricing is now done through Expenses.
- Sales-inventory vehicle expenses (`apps/auto-sales`, `vehicle_financial_events`) are untouched.

---

## 2. Workflow

- **Job screen → Expenses → "Add expense / receipt"** (every role) opens `/expenses?job=<id>` with the job,
  customer and vehicle preselected and the business step skipped: pick what it was → how it was paid → check
  vendor/date/total → save. Managers also see the list (vendor, description, date, amount, payment account,
  receipt link, bank/QuickBooks status), the job total, **Link a receipt that is already filed** (no upload, no
  re-entry), and **Fix or move** (amount, part, different job, remove — each with a reason).
- **General Receipts** (`/expenses`): the confirm step has "Customer job" search by customer name, vehicle, VIN
  or job number. The manager review card (`/expenses/review`) has the same picker plus split / overhead.
- **Intake:** photos (as before), **PDF** (magic bytes `%PDF-`, stored as-is, served as `application/pdf`), and
  **pasted text** (stored verbatim as `text/plain`). The parts screenshot importer still accepts images only.
- **Extraction** (prompt `exp_v3`): adds shipping, order number and stores invoice number + description. The
  payment card is still matched deterministically from a printed last-4 only — never guessed.
- **Questionable dates** (`apps/expenses/checks.ts`): a date more than 60 days old or in the future is flagged. If
  the same month/day in this year or last year would be a normal recent date, the warning says the year may have
  been misread and offers that date (the Tesla scan read 2026 as 2020). The employee must fix or confirm it; an
  unconfirmed one files as `needs_review` with reason `questionable_date`.
- **Amounts check:** subtotal + tax + shipping ≠ total is flagged.

Permissions (server-side): any signed-in session may capture a receipt and attach the receipt *they* are filing to
a job. Seeing amounts, linking an existing receipt, splitting, moving and removing are manager/admin. Receipt
files remain manager/admin only.

---

## 3. Duplicate rules — flag, never merge

`duplicateEvidence` (`apps/expenses/checks.ts`):

- **likely:** same vendor + invoice number, **or** same order number, **or** same vendor + date + total
- **possible:** same vendor + total within 3 days
- an equal total alone is never evidence

At capture, the existing same-uploader hint now also fires on invoice/order number. The reconcile view runs the
comparison across all receipts and additionally flags (a) a receipt tagged to a sales-inventory car whose amount is
also on that car's own ledger, and (b) a job part cost equal to a receipt attached to the same job. Nothing is
merged or rejected automatically.

---

## 4. Accounting distinctions

| Distinction | Treatment |
|---|---|
| Expected recurring bill vs actual payment | `fin_obligations` are forecasts (they feed Safe-to-Spend). The reconcile view matches each confirmed bill to a bank payment inside its own period (vendor name + amount; payroll/loan bills by bank class). A match means the payment **is** that bill — never added together. Derived on read; no link is stored. |
| Card purchase vs card payment | The purchase is the expense. Bank classes `card_payment`, `transfer`, `owner_draw`, `payroll`, `debt_payment` are cash movements (`is_expense=false`). **Changed:** they (and pending transactions) are no longer offered as receipt-match candidates and cannot be confirmed (`apps/finance/txn-class.ts`). |
| Transfers, loan principal/interest, owner draws | Unchanged bank classification; not operating expense; excluded from "purchases with no receipt". Principal vs interest is not split anywhere in this app. |
| Bulk supplies vs per-car cost | A bulk purchase is one receipt (one expense). It may be split across jobs/overhead; splits reconcile to the receipt total, so allocating supplies cannot create expense. No standard per-car supply rate exists — unallocated supplies stay overhead. |
| Operating results vs cash flow | Operating results (income, COGS, expenses, net) come **only** from QuickBooks reports on the CFO page. Cash comes **only** from Plaid balances + obligations. Receipts feed neither; they have their own coverage panel. |
| Filed vs posted to QuickBooks | `filed` = operationally captured. `qb_sync_status` is `export_ready`, never `synced` — nothing posts receipts to QuickBooks. The job list shows "QuickBooks: not posted". |
| Profit | Not shown. The job section states that labor, chemicals, shop supplies and overhead are not included. |

---

## 5. How the money sources actually connect (traced 2026-11-13)

| Source | Table | Populated by | Consumed by | Linked to |
|---|---|---|---|---|
| Receipts | `business_receipts` | capture UI | receipt coverage panel, reconcile view, job Expenses | jobs (new), inventory vehicle, bank (manual) |
| Job part costs | `job_parts.unit_cost_cents` | part forms / screenshot import | job screen only | receipts (new, optional) |
| Vehicle costs | `vehicle_financial_events` | auto-sales scan / manual | cost-per-car, monthly auto-sales report | **nothing** — separate scan pipeline, own totals |
| Bank / card | `fin_transactions` | Plaid, daily 09:00 UTC cron + "Sync now" | obligation discovery, receipt matching, Safe-to-Spend inputs | receipts via `fin_receipt_matches` (manual) |
| QuickBooks | `fin_sync_runs.summary`, `fin_accounts`, `fin_ar_invoices`, `fin_qb_purchases` (0079) | read-only sync | CFO P&L / balances / A/R; expense entries for matching (§11) | expense entries are **read**, never written (only Checks write a QB Purchase) |
| Recurring bills | `fin_obligations` | discovery (proposed) + owner confirm | Safe-to-Spend, bill calendar | no stored paid-by link |
| Checks | `checks` (+ QB Purchase) | Write-a-Check | check history | not read by finance/receipts |

Known overlaps (one purchase visible in two places, **never summed together** because no combined total exists):
receipt ↔ vehicle ledger; receipt ↔ QuickBooks P&L (if a bookkeeper enters it); check ↔ bank transaction ↔ receipt.

Not wired (code or columns exist, nothing uses them): `vehicle_financial_events.fin_transaction_id`,
`accounting_treatment`, `business_receipts.qb_*`, `checks` → finance, any obligation → payment link.

---

## 6. Reconcile view

`/expenses/reconcile` (manager PIN: receipt-side queues) and `/admin/finance/reconcile` (admin password: plus bank
and bill detail). Read-only; windows of 30/60/90 days. `apps/expenses/reconcile.ts`.

| Queue | Items |
|---|---|
| Bank and card purchases with no receipt (admin) | posted `expense` / `inventory` / `check` transactions with no confirmed receipt match |
| Receipts not matched to a bank or card payment | filed receipts with no confirmed/dismissed match |
| Likely job purchases with no job | Detail & Service parts / outside labor, or a note naming a job, with no allocation |
| Potential duplicates | §3 |
| Expected bills with no payment seen (admin) | confirmed bills with no matching payment in their period |
| Purchases with an incomplete split | partial, over-allocated, or allocated with no total |

Every item carries one of: **not yet observable** (e.g. bought after the last day the bank feed covers — the
feed cannot say whether it has posted), **can't be checked from
here** (cash, personal money, an unconnected source, an irregular bill), **to review**, **records disagree**
(over-allocation). The header shows each source's freshness and coverage, including that QuickBooks expense
records are not available.

Confirming a bank match still happens on the CFO page (`confirmReceiptMatch`).

---

## 7. Changes to existing totals

- **No existing total changed.** Receipt coverage, CFO figures, Safe-to-Spend, auto-sales reports: same inputs.
- **Behavior change:** receipt-match *suggestions* on the CFO page no longer include card payments, transfers,
  payroll, loan payments, owner draws or pending transactions, and confirming one is refused. Existing confirmed
  matches are untouched (production had 0 rows in `fin_receipt_matches` at release).
- New attention reason `questionable_date` can keep a receipt in "Needs attention".

---

## 8. Limitations (not solved here)

- **QuickBooks:** no receipt is posted to or matched against a QuickBooks expense. Not verifiable from this app.
- **Bank matching is manual** and per whole receipt; one receipt ↔ one transaction.
- **Expected-bill matching is best-effort** (name + amount), derived on read, not stored. Safe-to-Spend is unchanged
  and still has no paid-by link.
- **Vehicle ledger** remains a separate system; overlaps are flagged, not prevented.
- **Checks** are not linked to receipts or the bank feed.
- **PDF / pasted-text reading** uses the same model as photos (PDF as a file input). It could not be exercised
  locally (no model key in local env); if a read fails the document is still saved and the facts are typed.
- **Profit per job** is not computed; labor, chemicals and overhead are not captured per job.
- Inventory-vehicle links are still a single column (no split across inventory cars).
- A split is not blocked when the receipt total is later *lowered* below it — it is listed as a discrepancy.

---

## 9. Release

Order matters: the code names the new columns in its INSERTs, so **apply 0078 before deploying**.

1. `tsx scripts/db-target.ts` — confirm production (`ep-morning-base-adq5h6rq`).
2. Apply `drizzle/migrations/manual/0078_expense_allocations.sql` as the owner role
   (`DATABASE_URL=<DATABASE_URL_OWNER> node scripts/apply-qb-migration.mjs drizzle/migrations/manual/0078_expense_allocations.sql`).
   Additive and idempotent; default privileges grant `pitt_stop_app` DML on the new table.
3. Fast-forward push the release commit to `origin/main`; verify the deployed commit through the Vercel API.
4. Link the Tesla receipt (§10) and verify.

Rollback: redeploy the previous commit. The new table and columns are inert to old code; nothing needs to be
dropped. Allocations can be soft-removed.

## 10. Acceptance record — Tesla seat cushion, Huong Do

Verified in production **before** the change (read-only, 2026-11-13):

- Receipt `5b5d606c-04f7-4d16-a6e9-77f2b626627b`: `filed`, Tesla Inc., 2026-11-13 (corrected from a scanned
  2020-11-13), subtotal $71.00, tax $0.00, total **$80.21**, card ••0320 on AMB *2649, business funding, JPEG
  stored privately, `qb_sync_status = export_ready`, 6 audit entries.
- Job `dd38262d-18a8-4195-8cb5-92cbf515d1f8` = SO-20261113-0001, Huong Do, 2026 Tesla Model Y,
  VIN 7SAYGDED2TA431723. No `job_parts` rows. One job photo (`tesla-invoice.jpg`).
- No row in `fin_receipt_matches`. The bank feed covered transactions through 2026-11-12 only, so the bank side of
  an 11/13 purchase was **not yet observable in the available feed**. That is not evidence it had not posted —
  the feed simply could not show it either way.

Post-release (2026-11-13): linked by allocation `2021b97e-d1ae-4996-a503-940d6d9ef133` (whole purchase). The job shows
exactly $80.21; November receipt totals were $857.32 / 14 receipts before and after. No bank or QuickBooks match
was made because neither record was observable.

---

## 11. Cross-source matching and "counted once" (migration 0079)

Added after the first release. Full source: `apps/finance/{purchase-links,purchase-match,purchase-ledger,reconcile-links,qb-purchases}.ts`.

**Persisted matches — `purchase_links`.** A person's decision that two records are the same purchase
(`confirmed`) or are not (`dismissed`). Undo sets `cleared`; rows are never deleted; every decision is appended to
`fin_events`. Nothing is auto-matched. A confirmed match is exclusive (partial unique indexes).

| Match | Evidence used for the suggestion |
|---|---|
| Receipt ↔ bank payment (`fin_receipt_matches`, existing) | exact amount, ≤5 days, name |
| Receipt ↔ QuickBooks entry | amount + date + payee, or the invoice/order number inside the QuickBooks memo |
| Receipt ↔ inventory-vehicle cost line | same inventory vehicle + amount + ≤7 days |
| Written check ↔ bank payment | check number in the bank description + amount (up to 60 days to clear) |
| Written check ↔ receipt | amount + payee, receipt paid by check |
| Bank payment ↔ QuickBooks entry | exact amount + ≤5 days + name (strong only) |
| Expected bill ↔ actual payment | vendor name (or payroll/loan bank class) + amount inside the bill's range, within its period |

A written check and the QuickBooks entry it created are the same record by id (`checks.qbo_txn_id`) — no match needed.
Two equally good candidates are shown as "more than one candidate", never chosen.

**QuickBooks is read, never written.** `fin_qb_purchases` mirrors Purchases and Bills from the last 120 days,
filled by the existing daily QuickBooks sync from the production company only. This release adds no QuickBooks
write of any kind. Entries QuickBooks stops returning are marked `missing_since`, not deleted.

**Counted once.** `/admin/finance/reconcile` groups receipts, bank/card purchases, written checks, QuickBooks
entries and inventory-vehicle cost lines by confirmed matches; each group is one purchase, valued at what left the
bank (else QuickBooks, check, receipt, vehicle line). It also shows the naive sum, how much confirmed matches keep
from double counting, and how many purchases are still single-source. **Unmatched duplicates still count twice
there** — the page says so. It is a working figure, not the books.

**Not purchases.** Credit-card payments, transfers, payroll, loan payments and owner draws are listed separately
with their totals and never enter the purchase total. Loan principal and interest are not split.

**Expected bills.** A confirmed payment marks the bill paid for that period. The forecast total and the confirmed
paid total are shown side by side and never added. Safe-to-Spend is unchanged and does not read these links yet.

**Job allocations** remain a separate layer: they never enter any of the totals above.

**"Check the reading"** (manager, review card): re-reads the stored photo/PDF/text and shows read-vs-saved. Saves nothing.

### Still limited
- QuickBooks matching needs the mirror to be filled by a sync run in production; see the release notes for whether
  that had happened at release time.
- Matching is manual, one pair at a time. No bulk confirm.
- Safe-to-Spend, the CFO headline and the auto-sales reports do not consume `purchase_links`.
- The existing lists keep their own totals; only the counted-once view deduplicates.
- Preview safety: `docs/PREVIEW_SAFETY.md`.
