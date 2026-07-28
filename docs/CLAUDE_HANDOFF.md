# Pitt Stop OS — Claude Session Handoff

> Created: 2026-07-27 · Updated: 2026-07-28
> Purpose: Complete context transfer for the next Claude session.
> Written after: QuickBooks forensic investigation + Dealer Check-In planning sessions.

> **PROGRESS UPDATE 2026-07-28 (Opus session):** Dealer Check-In **Phase 0 is COMPLETE** —
> real QuickBooks OAuth 2.0 is built and verified. `apps/quickbooks/` module (crypto,
> config, oauth, db, connection, client, errors), `qb_connections` table live in Neon,
> routes at `/api/auth/quickbooks/{connect,callback,status,test,disconnect}`, admin UI at
> `/admin/integrations/quickbooks`. Commits `6342cc5` (0a) and `fb65ebc` (0b).
> **ONE OWNER ACTION PENDING:** click "Connect QuickBooks" at
> `/admin/integrations/quickbooks` and authorize in the Intuit window (one-time). Until
> then no realmId/tokens exist and live QB reads/writes can't run.
> **Next milestone: Phase 1** — write `docs/Dealer Invoice Specification.md`.

---

## 1. Executive Summary

**Pitt Stop OS** is a custom shop management system for an auto detailing business.
It replaces manual paper logs, spreadsheets, and disconnected apps with a unified
digital workflow that spans vehicle intake → work tracking → invoicing → payment.

**QuickBooks Online is the accounting source of truth.** Pitt Stop is the operational
source of truth. The two systems stay in sync, but Pitt Stop never supersedes QB for
financial records.

**Primary objectives:**
1. Eliminate manual data entry — one scan creates the QB invoice and work order simultaneously.
2. Give technicians a live work board showing every vehicle and its status.
3. Give the owner full visibility into what's been done, invoiced, and paid.
4. Build a documented, fault-tolerant integration that survives AutoLeap interference
   and recovers gracefully from sync failures.

**Development stage:** Active — Module 1 (Vehicle Entry) and Module 3 (Workflow Engine)
are shipped and in production. Module 2 (Retail Estimator) is Milestone 1 complete.
Module 4 (Dealer Check-In) is fully planned and ready to implement.

---

## 2. Current Status

### Completed and Shipped

| Feature | Notes |
|---------|-------|
| Vehicle key-tag OCR pipeline | Photo → GPT-4.1 → year/make/model/color/stock; fault-tolerant character repair |
| Stock number extraction | Dedicated pipeline; normalization rules; raw OCR stored for AI learning |
| Invoice batch model | Groups multiple dealer vehicles onto one QB invoice per billing period |
| Mock QB provider | Functional mock for testing; `QBProvider` interface defined |
| Dealership table | Stock prefix → dealership mapping (K/U/S/T) |
| Vehicle Entry module | Full dealer key-tag OCR → QB sync → admin UI |
| VIN barcode check-in | Camera-first, BarcodeDetector API, GPT-4.1 OCR fallback, VIN repair pipeline |
| Work Board | Live 10s-polling board; filter tabs; vehicle cards; elapsed time |
| Check-In flow | Scan → NHTSA decode → confirm → service select → service order created |
| Order Detail page | Status transitions, employee assignment, append-only event log |
| Employee admin | Add/remove technicians |
| Service order lifecycle | arrived → in_progress ↔ paused → drying → qc_ready → ready → delivered \| cancelled |
| Dealer tag → Work Board redirect | After tag confirm, redirect to work board with new vehicle highlighted (green border glow + toast) |
| Duplicate active order check | `findActiveOrderByVehicleId` prevents double check-in |
| Retail Estimator (Milestone 1) | Full UI flow, DB persistence, photo capture, AI severity analysis |
| Estimator VIN support | VIN scan/entry in vehicle step; NHTSA decode; bodyClass stored |
| Data classification | production \| pilot \| test on entries + estimates; QB sync guard blocks non-production |
| AI Learning module | OCR prompt result storage; normalization rules; admin replay tool |
| Admin dashboard | Vehicle entry admin, OCR learning, pilot dashboard, AI learning pages |
| Hydration fix | Date.now() and toLocaleTimeString deferred to useEffect to prevent SSR mismatch |

### Partially Complete

| Feature | What's Done | What's Left |
|---------|------------|-------------|
| QB integration | `QBProvider` interface + mock; invoice-sync engine; batch DB model | Real OAuth flow; live API provider; token storage |
| Retail Estimator | Milestone 1 (photos + AI + review + save) | Milestone 2 (PDF export, customer-facing estimate, payment link) |
| Dealer Check-In | Full plan documented in `docs/dealer-check-in-plan.md` | All implementation phases — none started |
| `formatLineDescription` | Exists in `apps/vehicle-entry/invoice-sync.ts` | Format is WRONG (uses pipes); needs fix to match real QB format |

### Not Started

- QuickBooks OAuth 2.0 (real tokens, auto-refresh, encrypted storage)
- Live QB API provider (replacing mock)
- Dealer Check-In UI (scan → preview → "Looks Good" → QB write + work board)
- `dealer_scans` and `dealer_scan_events` tables
- QB connection admin UI (`/admin/integrations/quickbooks`)
- Offline QB write queue + retry
- New-vehicle pricing prompt ($125 vs. $200)
- Retail Estimator Milestone 2
- AutoLeap overwrite protection (detection + alerting)
- Multi-location support
- Customer-facing portal

---

## 3. Architecture Decisions

### Vehicle-Centric Workflow
Every transaction in Pitt Stop is anchored to a specific vehicle (by VIN when available,
by stock number otherwise). The `vehicles` table is the master record. Service orders,
invoice lines, and scan events all foreign-key to vehicles. This means one vehicle can
have a complete history across multiple visits.

### QuickBooks as Accounting Source of Truth
QB owns invoice numbers, customer IDs, syncTokens, and payment status. Pitt Stop never
generates invoice numbers — it reads them back from QB after creation. Before any QB
write, Pitt Stop reads the current live QB state (never trusts cached status) because
the AutoLeap incident proved QB state can change without notice.

### Pitt Stop OS as Workflow Engine
QB tracks money. Pitt Stop tracks work. The work board, status transitions, employee
assignments, and event logs live entirely in Pitt Stop's DB. QB is not aware of who
worked on a vehicle or how long it took — only that a line item exists on an invoice.

### Dealer Tag Scan Workflow
Designed for one-handed, zero-typing operation on a phone:
1. Open camera — barcode detected automatically (no button tap)
2. Single photo captures stock number OCR and color
3. NHTSA decode gives year/make/model from VIN
4. Preview screen shows everything — user verifies
5. "Looks Good" is the only required tap — creates QB line + work board entry simultaneously

### Work Board Workflow
The work board is the shop's live operational screen. Every vehicle in progress shows
as a card. Status is updated by technicians directly; the board polls every 10 seconds.
Status lifecycle:
```
arrived → in_progress ↔ paused → drying → qc_ready → ready → delivered
                                                              → cancelled (from any state)
```

### Database Design
- **ORM:** Drizzle ORM with PostgreSQL (Neon serverless)
- **Pattern:** Each app module (`vehicle-entry`, `workflow`, `estimator`, `ai-learning`)
  owns its schema file. `drizzle/schema.ts` aggregates them all.
- **Migrations:** Drizzle Kit; migration files in `drizzle/migrations/`
- **No soft-delete pattern** — cancelled/voided status replaces deletion

### OCR Strategy
Three-layer fallback for maximum resilience:
1. Native `BarcodeDetector` API (client-side, instant, no API cost) — for VIN barcodes
2. GPT-4.1 vision (server-side) — for VIN photo OCR and dealer tag field extraction
3. Manual text entry — last resort, always available

VIN repair pipeline: returns up to 3 OCR candidates → applies confusion-pair character
substitution (0/D, 1/I/L, 2/Z, 5/S, 6/G, 8/B, U/V) → check-digit validation →
NHTSA cross-check → returns best candidate with `confirmed: false` + warning note.
Never returns a hard 422 error on a bad VIN — always gives the employee something to verify.

### Duplicate Prevention
Two layers:
1. **At check-in:** `findActiveOrderByVehicleId` prevents creating a second service order
   for a vehicle already on the work board. Returns the existing order with `existed: true`.
2. **At dealer scan (planned):** Check stock number + VIN + recency (7-day window)
   before writing to QB.

### Dealer Invoice Strategy
- **Batch model:** Multiple vehicles per dealer per billing period on one QB invoice.
  Never one invoice per vehicle.
- **Open invoice:** QB status Draft or Open (not yet sent) → append new line to existing invoice.
- **Sent invoice:** QB email has been sent → treat as closed, create new invoice.
- **Live status read:** Always fetch invoice from QB immediately before writing.
  Never trust cached `pittStopStatus` alone (AutoLeap taught us this).

### QuickBooks Synchronization Strategy
- **Phase 0 (next):** Real OAuth 2.0 — PKCE flow, encrypted token storage, auto-refresh
- **Provider interface:** `QBProvider` (`apps/vehicle-entry/qb/types.ts`) — mock and live
  are drop-in swappable; callers never know which is active
- **Token refresh:** Transparent to callers; happens inside the provider before every call
- **401 handling:** Refresh + retry once; if refresh fails → mark connection expired → alert admin
- **Offline queue (planned):** If QB is unavailable, queue the write; create work board entry
  immediately; sync when connection restores

### AutoLeap Integration (Forensic Background)
AutoLeap is an external shop management system used for retail customer work. It was
discovered to be silently overwriting Pitt Stop's dealer invoice batches in QB by finding
invoices by `DocNumber` and updating them via the QB API. This caused 5 confirmed overwrites:
- Invoice 100802 (Sterling Subaru) — user resolved manually
- Invoice 100803 (Sterling Subaru) → Invoice 100806 created as replacement
- Invoice 100783 (Sterling Kia, $800) → overwritten with thomas mcfarling 2 / $1,360.65
- Invoice 100792 (Sterling Kia, $800) → overwritten with Lydon Gray / $348.27
- Invoice 100793 (Sterling Kia, $800) → overwritten with Kali Dunson / $200;
  attached $800 payment became orphaned → deleted Jul 21 → Invoice 100799 created

**AutoLeap support ticket was sent.** Resolution is pending.

**Outstanding QB items:**
- Invoice 100799 ($1,325 including VW Atlas Blue) is overdue from Sterling Kia — needs collection
- Recovery plans for overwrites 100783, 100792, 100793 not yet finalized with Sterling Kia

**No AutoLeap detection/protection is built yet.** Plan when support ticket resolves.

### Inventory Integration Plans
Not yet specified. Deferred until dealer check-in is complete.

---

## 4. Dealer Check-In Project

Full technical plan: `docs/dealer-check-in-plan.md`

### Goal
Scan a dealer tag → system reads VIN + stock number + color → shows preview →
user taps "Looks Good" → QB invoice line added + work board entry created.
No typing. No duplicate data entry.

### Learn from Historical QB Data (Do Not Hardcode)
The system derives invoice structure, customer names, formatting, and line item
conventions from real QB invoice history. Only rules explicitly stated by the owner
are hardcoded. Currently confirmed from forensic audit data:

**Customer names in QB:**
- Sterling Kia → `Sterling Kia`
- Sterling Subaru → `Sterling Subaru`
- Sterling Auto Group → `Sterling Auto Group`

**Line item format (confirmed from real invoices):**
```
Product/Service: Complete Detail
Description:     2021 Honda Civic Gray #K518991
Service Date:    MM/DD/YYYY
Qty: 1 | Rate: 200 | Account: Detail Sales | Taxable: No
```

**Current bug:** `formatLineDescription` in `apps/vehicle-entry/invoice-sync.ts` uses
`${vehicle} | ${color} | ${stock}` (pipes). Real QB format is `${year} ${make} ${model} ${color} #${stock}`.
Fix this in Phase 3 of the implementation.

**Stock prefix → dealership mapping (confirmed):**
| Prefix | QB Customer |
|--------|------------|
| K | Sterling Kia |
| U | Sterling Subaru |
| S | Sterling Auto Group |
| T | Sterling Auto Group (new vehicles) |

### Real QuickBooks OAuth (Not Mock)
OAuth 2.0 / PKCE with Intuit from day one. No temporary or hardcoded tokens.
- Tokens encrypted at rest with AES-256-GCM (`QB_ENCRYPTION_KEY` env var)
- Access token auto-refreshed before expiry (< 5 min remaining → refresh)
- Refresh token expiry (101 days) → alert admin, require re-auth
- Admin UI at `/admin/integrations/quickbooks`

### Dealer Invoice Append Logic
1. Query `invoice_batches` for an open batch for this dealership
2. If found: fetch live QB invoice → verify still open
3. If open in QB: append new line to existing invoice
4. If sent/paid/voided: mark batch closed, create new QB invoice + new batch row
5. If no batch found: create new QB invoice + new batch row

### Open vs. Sent Definition
| QB Status | Meaning | Action |
|-----------|---------|--------|
| Draft | Open | Append |
| Open (not sent) | Open | Append |
| Sent | Sent to dealer — locked | Create new |
| Paid | Closed | Create new |
| Voided | Closed | Create new |

**Sent invoices are never modified automatically.** Ever.

### Dealer Scan Confirmation Screen
Route: `/dealer-check-in/preview/[scanId]`

Shows:
- Dealership name (derived from stock prefix)
- VIN
- Year / Make / Model (NHTSA)
- Color (OCR; editable inline)
- Stock number (OCR; editable inline)
- Invoice line preview: `2024 Kia Telluride Gray #K473262 — $200`
- Active invoice number OR "New invoice will be created"
- Pricing prompt if triggered (see Pricing Rules)

**Nothing writes to QB or DB until "Looks Good" is tapped.**

### "Looks Good" Creates or Updates the Invoice
On tap:
1. Run duplicate check
2. Resolve open batch (or create new)
3. Show pricing prompt if triggered (user must answer before continuing)
4. Fetch live QB invoice + syncToken
5. Append line to QB invoice via API
6. Verify line present; update syncToken
7. Create `serviceOrders` row (status: arrived)
8. Write audit event
9. Navigate to work board with vehicle highlighted

### Duplicate Protection
Before writing to QB, check:
1. Same stock number in any open batch for this dealership → DUPLICATE
2. Same VIN in any active `serviceOrders` → DUPLICATE
3. Same stock number in `dealer_scans` in last 7 days → POSSIBLE DUPLICATE

On duplicate: show "This vehicle may already be checked in" with options:
`Open Existing` | `Check In Anyway` | `Cancel`

### Store QuickBooks IDs
Every QB interaction stores:
- `qb_line_id` — QB's internal line ID for the appended line
- `qb_invoice_number` — human-readable invoice number (e.g., 100778)
- `qb_sync_status` — `synced` | `queued` | `error`
- `qb_sync_token` — current syncToken on the batch invoice

### Create Work Board Entry After QB Update
After QB line is confirmed, immediately create:
```
vehicles: vin, year, make, model, color
serviceOrders: source='dealer', serviceType='dealer_detail', status='arrived'
               notes="Stock: K518991 | Invoice: 100778"
```

If QB is unavailable: create work board entry immediately; queue QB write; show banner.

### Pricing Rules
**Default: $200 per vehicle (dealer detail).**

**Exception — new Sterling Auto vehicles: $125**

Detection signals (neither is 100% reliable):
- Stock number begins with `T`
- White dealer tag (instead of standard yellow)

**If either signal fires:** Show a confirmation prompt before adding to invoice:
> "This appears to be a new Sterling Auto vehicle. Charge $125 instead of the standard $200?"
> `Yes — $125` | `No — $200`

Never auto-select $125. Always ask when either signal is detected.
When neither signal fires: use $200 silently, no prompt.

---

## 5. Business Rules

These are permanent rules established by the owner. Do not change without explicit instruction.

| Rule | Detail |
|------|--------|
| QB is accounting source of truth | Pitt Stop never overrides QB financial records |
| Never modify a sent invoice | Once an invoice is sent to a dealership, it is closed for editing |
| Always read live QB status before writing | Never trust cached status alone |
| Batch invoice model | Multiple vehicles per dealership per period on one invoice |
| Standard dealer detail rate | $200 per vehicle |
| New Sterling Auto vehicle rate | $125 per vehicle |
| New Sterling Auto signals | Stock prefix T AND/OR white dealer tag |
| Ambiguous new vehicle: always ask | Never auto-assign $125 — show prompt when either signal fires |
| Learn from real QB data | Invoice structure, formatting, customer names come from QB history |
| Only hardcode explicit owner rules | Never assume business logic from general detailing industry norms |
| Non-production entries never sync | Data classified as `pilot` or `test` is permanently blocked from QB sync |
| Employee assignment at work start | Check-in does not require identifying the employee; assignment happens at Start Work |
| Duplicate prevention required | Both at check-in (VIN) and at dealer scan (stock + VIN + recency) |
| VIN repair over rejection | A single misread character should never fail check-in; repair and flag instead |
| No typing required at check-in | Every check-in must be completable with zero keyboard input |
| Sent invoices: notify, don't modify | If a batch invoice has been sent, create a new one and surface the transition |

---

## 6. Outstanding Questions

| Question | Context | Decision Needed |
|----------|---------|----------------|
| AutoLeap overwrite protection design | 5 confirmed overwrites found; support ticket sent | When support ticket resolves — detection + alerting approach |
| Sterling Kia overwrite recovery | Invoices 100783, 100792, 100793 were overwritten | Owner to decide what to do with Sterling Kia for those periods |
| Invoice 100799 collection | $1,325 overdue from Sterling Kia | Owner action item |
| Services beyond "Complete Detail" | Only Complete Detail seen in QB data so far | Learn from QB as new service types appear |
| Additional dealerships | Only Sterling group currently | New dealers added via QB data; do not hardcode |
| Billing periods | Learn from QB invoice date patterns | Do not assume monthly |
| Employee auth | "Approved by" on dealer scans uses name picker today | Defer until proper auth is built |
| Offline queue storage | Where to persist QB writes that fail? | Design in Phase 12 of dealer check-in |
| AutoLeap — will they fix it? | Ticket sent 2026-07 | Follow up; if not fixed, build detection layer |
| Retail Estimator Milestone 2 scope | PDF export, customer-facing estimate, payment link | Not yet designed |
| Multi-location support | Schema has `locationId` on service orders | Design when second location opens |

---

## 7. Future Roadmap (Priority Order)

1. **Dealer Check-In System (next)** — Phase 0 through 14 per `docs/dealer-check-in-plan.md`
   - Phase 0: QB OAuth (prerequisite for everything else)
   - Phase 1: QB Invoice Specification doc
   - Phases 2–14: DB schema → format fix → scan UI → preview → QB write → work board

2. **AutoLeap Overwrite Protection** — Once support ticket resolves; build detection
   + alerting if AutoLeap changes a Pitt Stop invoice

3. **Sterling Kia Recovery** — Owner to decide on 100783/100792/100793 reconciliation

4. **Retail Estimator Milestone 2** — PDF export, customer-facing estimate, payment link

5. **QuickBooks Reporting Integration** — Pull AR aging, payment status, overdue alerts
   into Pitt Stop admin dashboard

6. **Customer Portal** — Vehicle drop-off confirmation, status updates, estimate approval

7. **Multi-Location** — Second shop support using existing `locationId` column

8. **Inventory Integration** — Detail products tracking; not yet specified

---

## 8. Files Changed

### Created During This Project (not yet committed)

| File | Purpose |
|------|---------|
| `docs/dealer-check-in-plan.md` | Full 14-phase implementation plan for Dealer Check-In System |
| `docs/CLAUDE_HANDOFF.md` | This file |
| `.browser-profiles/forensic_atlas.py` | Forensic script: 4-step QB audit search for VW Atlas invoice and Sterling Kia payment |
| `.browser-profiles/forensic_atlas_report.json` | Output: Atlas invoices found (100799, 100214, 1555); txnId 23112 audit history |
| `.browser-profiles/scan_sterling_kia.py` | Forensic script: scan txnId 23062-23112 for Sterling Kia overwrites (5s page wait) |
| `.browser-profiles/sterling_kia_scan.json` | Output: 7 Sterling Kia hits; 3 confirmed overwrites (100783, 100792, 100793) |

Note: `.browser-profiles/` directory contains all forensic investigation scripts and
reports. These are read-only investigation artifacts. **Do not delete them** — they are
the evidentiary record of the AutoLeap overwrite incidents.

### Committed to Git (Most Recent First)

| Commit | Files Changed | Summary |
|--------|--------------|---------|
| `88e70a1` | `OrderDetail.tsx`, `VehicleCard.tsx` | Fix hydration mismatch: defer Date.now() + toLocaleTimeString to useEffect |
| `ec91015` | `ConfirmForm.tsx`, `WorkBoardClient.tsx`, `VehicleCard.tsx`, `work-board/page.tsx`, `workflow/orders/route.ts`, `workflow/db.ts` | Dealer tag scanner redirects to Work Board with highlight + duplicate order check |
| `339b414` | `workflow/vin/route.ts`, `CheckInFlow.tsx` | Fault-tolerant VIN OCR: multi-candidate repair pipeline, confusion-pair substitution, NHTSA cross-check |
| `d9a0f4b` | `CheckInFlow.tsx` | Remove employee identification from check-in; assignment moves to Start Work |
| `8a9f921` | `CheckInFlow.tsx`, `workflow/vin/route.ts`, `next.config.ts` | Camera-first VIN check-in; BarcodeDetector; GPT OCR fallback; dev cross-origin fix |
| `43a6a7e` | 27 files | Vehicle Workflow Engine V1: work board, check-in, order detail, employee admin, service order schema, estimator AI v4 |
| `af0064f` | 33 files | Data classification, AI learning module, estimator VIN support, admin redesign |
| `e46028f` | ~15 files | Retail Estimator Milestone 1: full UI flow, DB, photo capture, AI severity |
| `11e2d6e` | docs | Retail Estimator PRD |
| Earlier | Various | OCR improvements, admin pages, DB migrations, initial commit |

---

## 9. Git Status

**Branch:** `main` (up to date with `origin/main`)

**Uncommitted files (untracked):**
```
.browser-profiles/          ← forensic investigation scripts + reports (read-only evidence)
docs/dealer-check-in-plan.md   ← implementation plan (ready to commit)
docs/CLAUDE_HANDOFF.md         ← this file (ready to commit)
```

**Nothing staged. No modified tracked files.**

The `.browser-profiles/` directory should remain untracked or be added to `.gitignore`
if it isn't already — it contains Playwright browser profiles (cookies/session data)
that must not be committed. The forensic `.json` reports and `.py` scripts inside it
are evidence artifacts; consider whether to commit them separately.

---

## 10. Resume Instructions

**For the next Claude session — read this before touching any code.**

### Where We Are
The Dealer Check-In System is fully planned. No code has been written yet for it.
The plan lives at `docs/dealer-check-in-plan.md`. Start there.

### Immediate Next Action
**Phase 0 is DONE.** Start **Phase 1: `docs/Dealer Invoice Specification.md`**.

Prerequisite gate: confirm the owner has connected QuickBooks (visit
`/admin/integrations/quickbooks` → status should read "Connected"; or `GET
/api/auth/quickbooks/status` returns `connected:true`). Once connected, you can do a
read-only live QB pull (customers, a few recent Sterling invoices) to finalize the
invoice spec — combine that with the forensic data already in `.browser-profiles/`.

After Phase 1, proceed to Phase 2 (dealer_scans + dealer_scan_events schema) and the
`formatLineDescription` fix in `apps/vehicle-entry/invoice-sync.ts` (currently
pipe-separated; real QB format is `YEAR MAKE MODEL COLOR #STOCK`).

**What Phase 0 delivered (do not rebuild):**
- `apps/quickbooks/` — crypto.ts (AES-256-GCM), config.ts, oauth.ts, db.ts,
  connection.ts (`getValidAccessToken` auto-refreshes), client.ts (`qbApiRequest`,
  `getCompanyInfo`), errors.ts, schema.ts (`qb_connections`)
- Routes: `/api/auth/quickbooks/{connect,callback,status,test,disconnect}`
- Admin: `/admin/integrations/quickbooks`
- `scripts/apply-qb-migration.mjs` — idempotent table creator (project uses
  drizzle-kit push, not the migration journal)
- To make a live QB call from later phases: `import { qbApiRequest, getCompanyInfo }
  from '@/apps/quickbooks/client'`. It handles tokens/refresh for you.

### Key Files to Read First
| File | Why |
|------|-----|
| `docs/dealer-check-in-plan.md` | Full implementation plan with all phases |
| `apps/vehicle-entry/qb/types.ts` | `QBProvider` interface to extend for live implementation |
| `apps/vehicle-entry/qb/index.ts` | Currently returns mock only — replace with live |
| `apps/vehicle-entry/invoice-sync.ts` | Invoice batch resolution logic; `formatLineDescription` needs fix |
| `apps/vehicle-entry/schema.ts` | `dealerships`, `invoiceBatches`, `vehicleEntries` tables |
| `apps/workflow/schema.ts` | `vehicles`, `serviceOrders` tables |
| `app/check-in/CheckInFlow.tsx` | Existing VIN scanner to reuse in dealer check-in |

### Safety Rules (Always In Effect)
These rules were set by the owner and must never be violated:
- Do not create, edit, void, delete, replace, or sync any real invoice without explicit approval.
- Do not disconnect or reconnect the QB integration without approval.
- Do not run destructive tests in the live company file.
- Preserve all screenshots, timestamps, invoice numbers, IDs, and audit log entries.
- Do not implement any control until the owner approves it.
- Do not restore or recreate any QB data until the owner approves the recovery plan.
- Start with read-only investigation. Do not make changes.
- Do not choose any numbering format or invoice structure without showing consequences first.

### What Not To Do
- Do not mock OAuth — implement real Intuit OAuth 2.0 from the start
- Do not create a new QB invoice per vehicle scan — append to the open batch invoice
- Do not modify sent invoices — create a new invoice instead
- Do not hardcode invoice structure — derive it from real QB data
- Do not hardcode customer names, rates, or formatting — owner provides explicit rules
- Do not auto-select $125 rate — always prompt when signals fire
- Do not commit `.browser-profiles/` browser profile data (cookies, session files)
- Do not fix the `formatLineDescription` bug without also running QB verification

### Business Context
**Owner:** Torlan Pittman (torlanpittman@gmail.com)
**Business:** Auto detailing shop
**Dealer clients:** Sterling Kia, Sterling Subaru, Sterling Auto Group (all Sterling group)
**Billing email for all Sterling:** billing@sterlingautogroup.net
**Standard detail rate:** $200; new Sterling Auto vehicles: $125

### Current QB Situation (Owner Must Handle)
- Invoice 100799 ($1,325, Sterling Kia, includes VW Atlas Blue) is **overdue** — needs collection
- AutoLeap support ticket was sent 2026-07 — awaiting response
- Overwrites 100783/100792/100793 need recovery decision from owner
- **No QB changes should be made without owner's explicit instruction**

### Forensic Investigation Files (Do Not Delete)
All evidence of the AutoLeap overwrite incidents is in `.browser-profiles/`:
- `sterling_kia_scan.json` — 3 confirmed Sterling Kia overwrites with full audit histories
- `forensic_atlas_report.json` — Atlas invoice search; confirms 100799 is the right invoice
- `recovery_details.json` — Invoice 100802 original line items
- All `.py` scripts — forensic investigation scripts (read-only, never destructive)

---

## Missing Items (Self-Review)

After reviewing the above, the following items are important and were not fully captured
in the sections above:

### QB API Endpoints Needed (not yet specified in plan)
The live QB provider must implement these Intuit endpoints:
- `GET /v3/company/{realmId}/invoice/{id}` — fetch invoice + syncToken
- `POST /v3/company/{realmId}/invoice` — create new invoice
- `POST /v3/company/{realmId}/invoice?operation=update` — update (append line)
- `GET /v3/company/{realmId}/customer` — fetch customer list to learn QB customer IDs
- `POST /oauth2/v1/tokens/bearer` — token exchange and refresh

Intuit sandbox available at `https://sandbox-quickbooks.api.intuit.com`.
Production at `https://quickbooks.api.intuit.com`.

### QB Customer IDs Not Yet Stored
The `dealerships` table does not yet have `qb_customer_id`. When Phase 0 (OAuth) is
complete, run a one-time read-only query to fetch all QB customers and populate this.
The `qb_customer_name` is what QB uses for display; the `qb_customer_id` is what the
API requires for `POST /invoice`.

### SyncToken Collision Risk
QB uses `syncToken` for optimistic locking. If two Pitt Stop sessions try to append to
the same invoice simultaneously, the second write will fail with a 409/conflict. Plan
for this: fetch fresh token immediately before write; retry once on conflict with fresh
fetch.

### Tax Configuration in QB
Sterling invoices show tax rows (6.25%, 0.50%, 1.50%) but at $0.00 because customer
is marked tax-exempt. When creating invoices via API, the tax exemption must be set
at the customer level in QB (not per-invoice). Confirm this with QB API docs before
Phase 7 implementation.

### `invoice_batches.pittStopStatus` Values
Current values from schema: `draft | active | finalized | closed | cancelled`.
The "active" status in our DB corresponds to QB "Open (not sent)". Map these explicitly
when implementing Phase 5 (invoice open/sent logic).

### White Tag Detection Not Yet Designed
The plan calls for detecting white dealer tags as a signal for new Sterling Auto vehicles,
but the OCR pipeline does not yet classify tag color. Either: (a) ask Vision AI to
identify tag color as part of the photo analysis step, or (b) present the $125 prompt
any time stock prefix is T (simpler, but may over-prompt). Owner has not specified
which approach. Resolve during Phase 9 implementation.

### Estimator AI v4 Classification Dimensions
The estimator's AI severity analysis uses three dimensions: `severity`, `laborImpact`,
`isTimeTrap`. This was implemented in commit `43a6a7e`. If Retail Estimator Milestone 2
is worked on, this classification is the foundation — do not regress it.

### `apps/registry.ts` Pattern
Each module registers itself in `apps/registry.ts`. When adding the dealer-check-in
module to the app registry, follow this pattern. Currently registered: `vehicle-entry`,
`workflow`, `estimator` (implied by manifest files in each app directory).

### Environment Variables Required for QB OAuth
These do not yet exist in `.env.local` or deployment environment:
```
QB_CLIENT_ID=
QB_CLIENT_SECRET=
QB_REDIRECT_URI=
QB_ENCRYPTION_KEY=          # 32-byte hex, never commit
QB_SANDBOX=false
QUICKBOOKS_REALM_ID=        # populated after first OAuth connect
```
The owner will need to create a QuickBooks Developer app at developer.intuit.com
to obtain `QB_CLIENT_ID` and `QB_CLIENT_SECRET` before Phase 0b can be tested.
