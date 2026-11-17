# CFO page — trust pass (2026-11-17)

Branch `fix/cfo-trust` (off `origin/main` 38f4400). **Local only — not pushed, not deployed.** No migration.
No QuickBooks write, no production data change. Everything new is read-only.

## What the page is now

`/admin/finance` opens on five questions; all previous detail is still there, folded into expandable sections.

| Question | Built from | Module |
|---|---|---|
| Can we cover upcoming bills? | Safe-to-Spend engine (unchanged formula) − checks written but not cashed | `apps/finance/safe-to-spend.ts`, `cash-checks.ts` |
| Are we making money? | QuickBooks P&L as synced, beside UNRECONCILED spending (never netted into a loss headline) | `apps/finance/provisional.ts` |
| What is driving our costs? | Operating bank feed, grouped into costs vs cash that is not a cost | `apps/finance/dashboard.ts` |
| Are we earning enough per car? | Production log work value per car (dealer / retail). Cost per car is withheld — the operating account mixes car-lot spending and omits rent | `apps/workflow/production.ts` (`productionSummary`) |
| What needs my attention now? | One ranked list with a link per item | `dashboard.ts` (`buildAttention`) |

## Provisional spending — the rule

- The **bank feed is the base**: each posted purchase is one item.
- A **receipt explains** a bank purchase and never adds to it. A receipt is added on its own only when the bank
  cannot show the purchase (cash, a connection that is down, or too recent to have posted).
- A purchase **stops being provisional** when QuickBooks has it: a person confirmed the match
  (`purchase_links`), or QuickBooks shows the same MERCHANT on the same paying account, for the same amount, in
  the same few days (never stored as a match). Account + amount + date without a merchant, or with competing
  candidates, is only a **possible match**: it stays in the total and is shown for review. A paper check (no
  payee at the bank) is accepted only when it is the single candidate on both sides.
- Transfers, payroll, card payments, owner draws and loan payments are never spending here; loan / financing /
  IRS back-tax payments the bank files under ordinary expenses are excluded too and listed apart.
- The figure is called **unreconciled spending**, not a loss: what a paper check or an uncategorised bank
  line bought is not known.
- A receipt whose bank payment is unclear is **not counted** and is listed for review.
- Receipt ↔ bank pairing needs the same amount, vendor, payment account and ≤ 5 days. An equal amount alone
  never pairs anything. Returns: a net-of-returns receipt pairs with the net bank payment.

## Bugs fixed

1. **A bank connection that failed once was never retried.** Sync selected only `status='active'` Plaid items;
   a failure sets `status='error'`. The Extraco (*5600) item hit a transient outage on 2026-09-26 and has been
   skipped since, while runs logged `ok` and the page said "data fresh". Now: errored items are retried every
   run, a failed bank makes the run `partial`, and the page names each connection's state.
2. **Bill discovery wrote a new row every run** (the dedupe key was never saved): ~3,660 duplicate proposals.
   Now keyed; unkeyed rows are adopted (an "ignored" copy wins, so a decision sticks); owner-confirmed amounts
   are no longer overwritten by discovery. The page collapses existing duplicates on read (nothing deleted).
3. **Safe-to-Spend was shown as a number even when it could not be trusted**; it now says "can't say" when the
   operating balance is missing, stale or its bank is failing, and lists what could move the number.
4. **Checks written but not cashed were not held back** from Safe-to-Spend. They are now one extra line.

## Owner access

`/admin/*` is owner-only behind `ADMIN_PASSWORD` (HTTP Basic). A staff PIN session — including a manager —
never opens it; that is intended (`proxy.ts`, pinned by `proxy.admin.test.ts`). To sign in: open
`/admin/finance`, leave the username blank or type anything, enter the admin password (Vercel → Project →
Settings → Environment Variables → `ADMIN_PASSWORD`, Production).

## Needs the owner (not done here)

- Deploy this branch (no migration).
- After deploy: "Sync now" to retry Extraco; if it still fails, reconnect it under Accounts & connections.
- Decide the bills the page asks about (marketing agency, AutoLeap, water service): ignore = ended.
- Optional clean-up of the duplicate proposal rows (a delete of machine-generated `proposed` rows).
- The bookkeeper is ~6 weeks behind on card/ACH purchases for the operating account.
