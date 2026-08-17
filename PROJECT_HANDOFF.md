# Pitt Stop OS — Project Handoff

> Durable architecture + current-state reference so future sessions do not depend on
> conversation context. Reconstructed from code/git on 2026-08-17. Keep this file updated
> when architecture changes; do not put transient task chatter here.

## 1. Stack & layout

- **Next.js 16** (App Router, React 19), **Drizzle ORM** on **Neon Postgres**, Vercel deploy.
- **Domain modules** live in `apps/<module>/` — each owns a `schema.ts` (aggregated by
  `drizzle/schema.ts`) plus its own db/service/logic files. UI + API routes live in `app/`.
- Key modules: `apps/workflow` (Jobs/orders — the core), `apps/quick-entry` (intake +
  customer contact), `apps/quickbooks` (retail + shared QB), `apps/dealer-checkin`,
  `apps/vehicle-entry`, `apps/estimator`, `apps/settings`, `apps/directory`.
- Platform helpers: `@/platform/db` (getDb), `@/platform/logger`.
- Tests: vitest (`npm test`). Migrations: `drizzle/migrations` + `npm run db:push`.

## 2. Authoritative data model (do not build parallels)

- **`service_orders`** (`apps/workflow/schema.ts`) — the Job. Status lifecycle:
  `arrived → in_progress ↔ paused → drying → qc_ready → ready → delivered | cancelled`.
  `completedAt` = true completion (stamped when → `ready`), counted once. `completedBy`,
  `completionChecklist` also stamped then. **Correcting a Job later must never re-stamp
  `completedAt`** (production-date safety).
- **`service_order_events`** — append-only audit trail. Never update/delete. Emit events via
  `logEvent()` in `apps/workflow/db.ts`.
- **`job_estimates`** (one per order, unique) — the authoritative estimate/pricing + retail
  QB linkage. `priceMode`: `itemized | explicit_pretax | out_the_door`. Retail QB fields:
  `qbInvoiceId`, `qbInvoiceNumber`, `qbSyncToken`, `qbStatus` (`none|creating|created|sent|error`),
  `qbContentHash`, `qbSyncedAt`, `qbSentAt`, `qbSyncError`, `qbLastRequestId`. A **partial
  UNIQUE index on `qb_invoice_id`** (`drizzle/migrations/manual/0019_retail_qb_linkage.sql`:
  `job_estimates_qb_invoice_uniq`) is the DB-level idempotency backstop.
- **`job_services` / `job_line_items`** — itemized work + generated fee lines
  (`generated=true`, runtime `feeCode` ∈ `shop_supplies | payment_charge` — note the schema
  comment's `card_fee` is stale). Fee lines are owned by the fee engine, reconciled in place —
  never hand-edit/duplicate.
- **`quick_entry_jobs`** — holds retail **customer contact**: `customerName`, `customerEmail`,
  `customerPhone`. Linked to the order via `serviceOrderId`. This is the source of truth for
  customer email/phone (latest row by `createdAt`).
- **`qb_connections`** — one row per realm+environment, AES-256-GCM encrypted OAuth tokens.
  Currently active: **production** realm `123146329198289` and a sandbox realm.

## 3. Pricing / fees / invoice draft (authoritative)

- Fee engine: `apps/workflow/fees.ts`. Retail default charges: **Shop Supplies** (3% cap $20)
  + **Payment/Card charge** (3%, basis `work_plus_supplies`). **Dealer Jobs get NO retail Shop
  Supplies, payment charge, or retail tax** — `isDealerOrder(order)` gates this everywhere.
- **Invoice Draft** = `apps/workflow/invoice-draft.ts` `buildInvoiceDraft()`. A READ MODEL over
  the authoritative estimate — no second calculation. Supports flat (`explicit_pretax`) and
  itemized pricing; `serviceBreakdown` for itemized. Exposes `qb` link state. This is THE
  invoice source of truth; reuse it, never fork it.
- API: `GET /api/workflow/orders/[id]/invoice` (manager/admin) returns
  `{ draft, qbEnabled, qbSendEnabled }`. Overrides: `.../invoice/override`.

## 4. Retail QuickBooks (Create + Send) — already built, flags OFF

Files: `apps/quickbooks/retail-invoice-service.ts` (orchestration),
`retail-invoice-write.ts` (QB write primitives), `retail-invoice.ts` (pure payload/recipient
logic), `retail-format.ts` (canonical descriptions + PSID), `retail-item-map.ts`,
`retail-customer.ts`.

- **Create** (`createRetailQBInvoice`) — manager/admin. Idempotency: (1) local `qbInvoiceId`
  guard, (2) compare-and-set `qbStatus='creating'` lock (one winner), (3) **PSID adoption**
  (scans customer invoices for `PSID:<estimateId>` in PrivateNote), (4) DB unique index.
  Builds QB invoice ONLY from Invoice Draft; enforces `Σlines === draft.totalCents` pre- and
  post-write. One QB line per real service using the mapped QB Product/Service (catalog
  `qb_item_ref`, else generic "Labor"), Description = canonical `service_catalog.qb_description`
  (never AI-generated). Vehicle → CustomerMemo. PSID → PrivateNote only. Customer BillEmail
  populated when a valid PS email exists.
  API: `POST /api/workflow/orders/[id]/invoice/create-qb`, gated by `retail_qb_enabled`.
- **Send** (`sendRetailQBInvoice`) — **ADMIN ONLY**. Emails the EXISTING linked invoice via
  QBO `POST /invoice/{id}/send?sendTo=`. `resolveRetailSend()` is a read-only pre-send check
  (invoice exists, TotalAmt still == draft total, recipient resolution). `decideSendRecipient`:
  BillEmail primary → blank filled from PS email → present-but-different = `email_conflict`
  (never overwrite) → neither = `email_required`. Failure preserves the created invoice +
  records `qbSyncError`, allows retry. API: `POST .../invoice/send-qb`
  (`{confirm:false}`=preview, `{confirm:true}`=send), gated by `retail_qb_send_enabled`.
- **"QuickBooks sync needed"**: retail QB UPDATE is NOT built. After edits to a QB-linked Job,
  `flagQbSyncNeededIfInvoiced()` writes `qbSyncError = "QuickBooks sync needed — <reason>"`
  (surfaced in Invoice Draft). Called from customer/estimate/services/vehicle edit routes.

## 5. Dealer QuickBooks — ISOLATED, do not touch

Dealer invoicing lives in Dealer Check-In (`apps/dealer-checkin`, `apps/vehicle-entry`,
`apps/quickbooks/invoice-write.ts`). Dealer QB state lives on dealer scans — NOT on
`job_estimates.qb_*`. "Complete Detail" is the dealer invoicing trigger. Retail and dealer
must stay isolated. Do not alter Dealer Check-In behavior.

## 6. Finish Job flow (current, pre-feature)

- `app/orders/[id]/OrderDetail.tsx`. **Finish Job** (green primary, all active statuses) →
  `handleAction({newStatus:'ready'})` → if `completionEnabled` opens **CompletionModal** →
  `completeJob()` → `POST .../transition {newStatus:'ready', completion}`.
- Server `transition/route.ts`: `validateCompletion()` (every listed service acknowledged +
  general checks + QC if required) → `transitionOrder()` stamps `completedAt`/`completedBy`/
  checklist. **On success the client redirects straight to `/work-board`.** There is currently
  NO completion/invoice screen and NO offer to send.
- Completion is independent of QB/email — it never calls them today.

## 7. Roles / permissions

- `employees.role` ∈ `employee | manager | admin`. Actor resolved from cookie via
  `getActor()` (`apps/workflow/identity.ts`). Employees see a simplified board + Finish Job;
  full lifecycle + Invoice Draft are manager/admin. Retail QB **Create = manager/admin**,
  **Send = admin only** (enforced at routes).

## 8. Feature flags (settings registry `apps/settings/db.ts`, DB `app_settings` → env → default)

Verified in production DB on 2026-08-17:
- `completion_invoice_enabled = true` — **ON** (Phase A Completion Summary; enabled after the
  live mobile walkthrough passed; see §11).
- `retail_qb_enabled = false` (retail QB CREATE) — must stay OFF until Phase B.
- `retail_qb_send_enabled = false` (retail QB SEND/email) — must stay OFF until Phase D.
- `payment_charge_enabled = true`, `shop_supplies_enabled = true`
- `COMPLETION_FLOW_ENABLED`, `ESTIMATE_LAYER_ENABLED`, `IDENTITY_ENABLED` are env-based.

## 9. Messaging infrastructure — CURRENT STATE

- **Email:** the ONLY email channel is **QuickBooks native email** (QBO send endpoint). There
  is no standalone Pitt Stop email sender (no SendGrid/Resend/SES/nodemailer).
- **SMS/Text:** **NONE.** No Twilio/other SMS provider, no phone number, no env, no code.
  Any text/SMS capability is net-new infrastructure requiring an owner decision.

## 10. Working rules (business/architecture invariants)

1. Reuse authoritative systems — no parallel pricing/Job-detail/VIN/invoice systems.
2. Retail vs dealer QB stay isolated; dealer Jobs never get retail fees/tax.
3. Invoice Draft reads the authoritative estimate.
4. Completing a Job must never depend on QB/email/text succeeding.
5. Idempotency: retries/double-taps must not create duplicate QB invoices or duplicate sends.
6. Correcting a completed Job must not change its original `completedAt`/production date.
7. VIN corrections reuse the existing VIN decoder + existing vehicle row.
8. Retail QB Create/Send flags stay OFF until explicitly enabled; verify, don't assume.
9. Never send real invoices/emails/texts in testing without explicit approval.
10. `service_catalog.qb_description` = approved canonical retail descriptions; never invent.
    Mini Detail canonical = "Hand wash exterior, wheels, tires, wheel well, windows, mirrors.
    Vacuum and wipe down."

## 11. Finish Job → Review Invoice → Send — phased rollout

Approved phased plan. **Finish Job → Completion Summary → Review Invoice → (later)
Create/Sync/Send.** SMS/text is deferred to its own phase (no infra today, §9). Each phase
ships separately and behind its own flag; completion must NEVER depend on billing.

**Phase A — SHIPPED & live-verified (2026-08-17). `completion_invoice_enabled = true` (ON).**
- After Finish Job commits (Job Ready, counted once in Daily Production), manager/admin on a
  retail Job see a READ-ONLY Completion Summary instead of the immediate Work Board redirect:
  finished banner, customer/vehicle, authoritative Total (Invoice Draft read model), contact
  (email/phone with Add → existing customer edit path, no duplicate customer), invoice state,
  Review Invoice (opens existing Invoice Draft), Done.
- Employees and dealer Jobs keep the straight redirect (no summary). NO QuickBooks write, NO
  Send, NO Sync. Reuses `GET /invoice`, `GET /contact`, `POST /customer`.
- Files: `apps/settings/db.ts` (flag + reader), `app/api/identity/route.ts` +
  `app/components/IdentityBar.tsx` (expose flag), `app/orders/[id]/OrderDetail.tsx`
  (`CompletionSummary` + `ContactRow`). Commit `c6abd88` (code) — flag enabled directly in prod.
- Live walkthrough at 390×844 passed 31/31 UI + 29/29 DB checks: total match, contact Add
  (no dup customer), Review Invoice has no Create/Send controls, employee/dealer bypass,
  and failure-safety (aborting the invoice/contact reads still leaves the Job completed with
  Done available).

**Phase B (next, NOT started):** enable/reuse retail QB **Create** from the summary
(`retail_qb_enabled`). **Phase C:** safe retail QB **Update/Sync** for stale linked invoices.
**Phase D:** retail **Email Send** (manager+admin) via `retail_qb_send_enabled`. **Phase E:**
SMS/text (verify QB exposes a reliable customer-facing shareable link first). Do not combine
phases; retail QB Create/Send stay OFF until their phase.
