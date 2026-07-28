# Dealer Check-In System — Implementation Plan

> Last updated: 2026-07-27
> Status: APPROVED ARCHITECTURE — awaiting implementation start

---

## Executive Summary

One scan of a dealer tag creates a QuickBooks invoice line (appended to the
dealership's current open invoice) and a Work Board entry in "Waiting" status.
No duplicate typing. QuickBooks is the live source of truth via real OAuth.

---

## Model and Constraints

- **QB is source of truth.** Pitt Stop reads from QB, does not shadow it.
- **Real OAuth only.** No mocks, no hardcoded tokens. OAuth 2.0 from day one.
- **Learn before hardcoding.** Invoice structure, formatting, and customer names
  come from historical QB data. Only rules explicitly stated by the owner are hardcoded.
- **One phase = one commit.** Nothing moves to the next phase until the current one
  is committed and passing.
- **Safety rules remain in effect** for any forensic or live QB investigation:
  no creates, edits, voids, or deletes without explicit approval.

---

## What Already Exists (Do Not Rebuild)

| Component | Location | Reuse |
|-----------|----------|-------|
| VIN barcode scanner | `app/check-in/CheckInFlow.tsx` | Reuse scanner + NHTSA decode logic |
| Key-tag OCR pipeline | `apps/vehicle-entry/ai/index.ts` | Reuse for stock number extraction |
| Stock number extractor | `apps/vehicle-entry/ai/stock-number.ts` | Reuse as-is |
| QB provider interface | `apps/vehicle-entry/qb/types.ts` | Extend, do not replace |
| QB mock provider | `apps/vehicle-entry/qb/mock.ts` | Keep for unit tests only |
| Dealerships table | `apps/vehicle-entry/schema.ts` | Add columns, do not drop |
| Invoice batches table | `apps/vehicle-entry/schema.ts` | Keep — batch model is correct |
| Invoice sync engine | `apps/vehicle-entry/invoice-sync.ts` | Extend for dealer check-in path |
| Work Board | `app/work-board/` + `apps/workflow/` | Reuse `vehicles` + `serviceOrders` |
| Normalization engine | `apps/ai-learning/normalizations.ts` | Keep for stock number cleaning |

---

## Phase 0 — QuickBooks OAuth Setup

**This is a prerequisite for all QB API work. Must be fully implemented before Phase 7.**

### OAuth 2.0 Flow (Intuit's supported method)

1. User (admin) navigates to `/admin/integrations/quickbooks`
2. Clicks "Connect to QuickBooks"
3. App redirects to Intuit authorization URL with:
   - `client_id` (from env)
   - `redirect_uri` → `/api/auth/quickbooks/callback`
   - `scope` → `com.intuit.quickbooks.accounting`
   - `response_type=code`
   - PKCE `code_challenge`
4. User authorizes in Intuit's UI
5. Intuit redirects back to our callback with `code` + `realmId`
6. Callback exchanges code for `access_token` + `refresh_token` + expiry times
7. Tokens stored in DB (see schema below)
8. Admin redirected back to `/admin/integrations/quickbooks` — status shows "Connected"

### Token Lifecycle

| Token | Lifetime | Action on Expiry |
|-------|----------|-----------------|
| `access_token` | 1 hour | Auto-refresh using `refresh_token` |
| `refresh_token` | 101 days | Alert admin; require re-auth |

Token refresh happens transparently inside the QB provider — callers never see it.
Every QB API call: check if `access_token` expires within 5 minutes → refresh first.

### Token Storage Schema

```sql
-- New table: qb_connections
id                  UUID PRIMARY KEY DEFAULT gen_random_uuid()
created_at          TIMESTAMP WITH TIME ZONE DEFAULT now()
updated_at          TIMESTAMP WITH TIME ZONE DEFAULT now()

realm_id            VARCHAR(100) NOT NULL    -- Intuit company ID
access_token        TEXT NOT NULL            -- encrypted at rest
refresh_token       TEXT NOT NULL            -- encrypted at rest
access_token_expires_at   TIMESTAMP WITH TIME ZONE NOT NULL
refresh_token_expires_at  TIMESTAMP WITH TIME ZONE NOT NULL

connected_by        VARCHAR(200)             -- email of admin who connected
status              VARCHAR(30) DEFAULT 'active'  -- 'active' | 'expired' | 'revoked'
last_used_at        TIMESTAMP WITH TIME ZONE
last_error          TEXT
```

Tokens are encrypted using `AES-256-GCM` with key from `QB_ENCRYPTION_KEY` env var.
**QB_ENCRYPTION_KEY must never be committed or logged.**

### Environment Variables Required

```
QB_CLIENT_ID=
QB_CLIENT_SECRET=
QB_REDIRECT_URI=https://[your-domain]/api/auth/quickbooks/callback
QB_ENCRYPTION_KEY=           # 32-byte random hex, never committed
QB_SANDBOX=false             # true only for local dev
QUICKBOOKS_REALM_ID=         # populated automatically after first OAuth
```

### QB Provider: Live Implementation

Replace the mock with a real client that:
1. Loads the active `qb_connections` row
2. Decrypts `access_token`
3. If expiring < 5 minutes: calls Intuit token refresh endpoint, updates DB
4. Makes the API call
5. On 401: refresh + retry once
6. On refresh failure: mark connection `status = 'expired'`, throw `QBAuthError`

The `QBProvider` interface (`apps/vehicle-entry/qb/types.ts`) is unchanged —
the live implementation is a drop-in for the mock.

### Admin UI

`/admin/integrations/quickbooks` shows:
- Connection status (connected / disconnected / expired)
- Connected by / connected since
- Token expiry countdown
- "Reconnect" button (triggers OAuth flow)
- Last API call timestamp + any last error

---

## Phase 1 — QuickBooks Invoice Specification

**Output:** `docs/Dealer Invoice Specification.md`

**Source:** Forensic audit data already collected + live QB read (no writes).

### Confirmed from real QB data (forensic audit 2026-07)

#### Customer Names
| Dealership | QB Customer Name | Email |
|------------|-----------------|-------|
| Sterling Kia | `Sterling Kia` | billing@sterlingautogroup.net |
| Sterling Subaru | `Sterling Subaru` | billing@sterlingautogroup.net |
| Sterling Auto Group | `Sterling Auto Group` | billing@sterlingautogroup.net |

#### Invoice Header Settings
- **Terms:** Due on receipt
- **Customer is Taxable:** No
- **Tax rows:** Present but at $0.00 (6.25%, 0.50%, 1.50%)
- **Custom Fields:** `Num` = invoice number; `Pmt Meth Ref No.` = invoice number

#### Line Item Format (per vehicle)
```
PRODUCT/SERVICE: Complete Detail
DESCRIPTION:     [YEAR] [MAKE] [MODEL] [COLOR] #[STOCK_NUMBER]
SERVICE DATE:    MM/DD/YYYY (date work was performed)
QTY:             1
RATE:            [200 or 125 — see Pricing section]
ACCOUNT:         Detail Sales
TAXABLE:         No
```

**Real examples from QB:**
- `2021 Honda Civic Gray #K518991`
- `2024 Kia Telluride Gray #K473262`
- `2026 Subaru Forester River Rock #UP003483`
- `VW Atlas Blue` *(stock not captured — edge case)*

> **Format bug to fix:** Current `formatLineDescription` in `invoice-sync.ts`
> uses `${vehicle} | ${color} | ${stock}`. Real QB format is
> `${year} ${make} ${model} ${color} #${stock}`. Fix in Phase 3.

#### Invoice Model: Batch
One invoice per dealership per billing period. Multiple vehicles per invoice.
Confirmed by real data: Invoice 100778 (6 vehicles, $1,200), Invoice 100799 (5 vehicles, $1,325).

#### Stock Prefix → Dealership (confirmed)
| Prefix | Dealership | QB Customer Name |
|--------|-----------|-----------------|
| `K` | Sterling Kia | `Sterling Kia` |
| `U` | Sterling Subaru | `Sterling Subaru` |
| `S` | Sterling Auto Group | `Sterling Auto Group` |
| `T` | Sterling Auto Group | `Sterling Auto Group` *(new vehicles)* |

S and T are two stock series; both map to the same QB customer.

---

## Phase 2 — Dealer Tag Structure

A Sterling dealer tag contains:
1. **VIN barcode** (Code 39 or Code 128) — 17-character VIN
2. **Handwritten or printed fields:** Year / Make / Model / Color / Stock Number
3. **Tag color:** Yellow = standard used/trade-in; White = new Sterling Auto vehicle

**VIN → vehicle via NHTSA:**
- Year, Make, Model, Body Class from NHTSA free decode API
- Color: OCR only (not in VIN)
- Stock number: OCR only (not in VIN)

**Confidence thresholds:**
| Source | Expected confidence | Action if low |
|--------|-------------------|---------------|
| VIN from barcode | 100% (checksum) | N/A |
| VIN from OCR | use existing repair pipeline | Show confidence %, let user confirm |
| Stock number from OCR | use existing pipeline | Flag field if < 80%; user must confirm |
| Color from OCR | medium | Fall back to manual color picker |

---

## Phase 3 — OCR Pipeline

No rebuild needed. Reuse existing pipeline.

**Scan sequence (dealer check-in):**
1. Live barcode detection → VIN captured automatically, no user tap
2. Single photo capture of the same tag → OCR for stock number + color
3. NHTSA decode of VIN → year/make/model (preferred over OCR when VIN present)
4. All data passed to `/api/dealer-check-in/scan` → `dealer_scans` row created

---

## Phase 4 — Dealership Matching

**Algorithm:**
1. Extract leading letter(s) from stock number (e.g., `K` from `K518991`, `UP` → `U`)
2. Look up single-character prefix in `dealerships` table
3. If match: use that dealership
4. If no match or no stock number: show manual dealership picker

Prefix `T` needs to be seeded in `dealerships` alongside `S` for Sterling Auto Group.

---

## Phase 5 — Invoice Open/Sent Logic

**This is the core business rule for when to append vs. create new.**

### Invoice Status in QuickBooks

QB invoice statuses relevant to this flow:
| QB Status | Pitt Stop Meaning | Action |
|-----------|------------------|--------|
| Draft | Open — vehicles still being added | Append new line |
| Open (not sent) | Open — vehicles still being added | Append new line |
| Sent | Sent to dealership — do not modify | Create new invoice |
| Paid | Closed | Create new invoice |
| Voided | Closed | Create new invoice |

**"Open invoice" = QB status is Draft OR Open AND email has NOT been sent.**

Pitt Stop reads invoice status from QB at scan time (live read, not cached status).

### Open Invoice Resolution (at scan time)

1. Query `invoice_batches` for this dealership with `pittStopStatus = 'active'`
2. If found: fetch that QB invoice → check live QB status
   - If still open in QB: append to it
   - If sent/paid/voided in QB: mark our batch `closed`, proceed to create new
3. If not found: create a new QB invoice + new `invoice_batches` row

### Why Live QB Read (Not Cached Status)

The AutoLeap incidents proved that QB state can change under us without notice.
Always fetch fresh from QB before writing.

---

## Phase 6 — Pricing Rules

### Standard Rate
**$200 per vehicle.** All dealer detail services default to this rate.

### Sterling Auto New Vehicle Rate
**$125** — applied when the vehicle is a brand-new unit from Sterling Auto Group.

**Detection signals (neither is 100% reliable):**
1. Stock number begins with `T` (Sterling Auto new-car series)
2. White dealer tag instead of standard yellow (captured from tag photo)

**Rule: if either signal is present → show a confirmation prompt.**

> "This appears to be a new Sterling Auto vehicle.
> Charge $125 instead of the standard $200?"
>
> `Yes — $125` | `No — $200`

Do not auto-select $125. Always ask when either signal fires.
When neither signal fires: use $200 silently, no prompt.

### Rate Storage
Rate is stored per line in the QB invoice (as entered) and in `dealer_scans.rate`.
No rate table needed for now.

---

## Phase 7 — Preview Screen

**Route:** `/dealer-check-in/preview/[scanId]`

Displayed fields:
- Dealership name
- VIN
- Year / Make / Model (NHTSA)
- Color (OCR; editable inline)
- Stock Number (OCR; editable inline)
- Invoice line preview: `2024 Kia Telluride Gray #K473262 — $200`
- Active invoice number (if open one exists) OR "New invoice will be created"
- Pricing prompt (if T-prefix or white tag detected — see Phase 6)

Buttons:
- `Looks Good` (primary, full-width, green, bottom of screen)
- `Edit Details` (secondary)

**Nothing writes to QB or DB until "Looks Good" is tapped.**

---

## Phase 8 — Edit Screen

**Route:** `/dealer-check-in/edit/[scanId]`

Editable fields:
- VIN (validates 17-char + check digit)
- Dealership (picker)
- Stock Number (text)
- Year / Make / Model (text)
- Color (color picker)
- Rate override ($200 / $125 / custom)

After save: returns to Preview with updated data.

---

## Phase 9 — Create QuickBooks Invoice Line

**Triggered by:** "Looks Good" tap.

**Steps (in order, atomic):**
1. Re-read scan record + any edits from Preview/Edit
2. Run duplicate check (Phase 10)
3. Resolve active batch for dealership:
   - Query `invoice_batches` for open batch
   - If found: fetch live QB invoice to confirm still open
   - If sent/closed in QB: create new QB invoice + new batch row
   - If no batch found: create new QB invoice + new batch row
4. Present pricing prompt if triggered (Phase 6) — block until user answers
5. Fetch current QB invoice + syncToken
6. Append line to QB invoice via live QB API
7. Re-fetch QB invoice to verify line present + get new syncToken
8. Update `invoice_batches.qb_sync_token`
9. Update `dealer_scans` with `qb_line_id`, `qb_invoice_number`, `qb_sync_status = 'synced'`
10. Create `serviceOrders` row in `arrived` status
11. Write `dealer_scan_events` row: `approved`
12. Navigate to work board with new vehicle highlighted

**If QB API unavailable:** Queue operation. Create work board entry immediately.
Show banner: "Invoice queued — QB will sync when connection is restored."

**Line written to QB:**
```
Product/Service: Complete Detail
Description:     [YEAR] [MAKE] [MODEL] [COLOR] #[STOCK]
Service Date:    [today]
Qty: 1 | Rate: [200 or 125] | Account: Detail Sales | Taxable: No
```

---

## Phase 10 — Duplicate Protection

Checks run before Step 4 of Phase 9:
1. Same stock number in any open batch for this dealership → DUPLICATE
2. Same VIN in any `serviceOrders` with status not in (`delivered`, `cancelled`) → DUPLICATE
3. Same stock number in `dealer_scans` created in last 7 days → POSSIBLE DUPLICATE

On duplicate:
- Block creation
- Show: "This vehicle may already be checked in."
- Show: existing invoice number, work board status, creation time
- Options: `Open Existing` | `Check In Anyway` | `Cancel`

---

## Phase 11 — Work Board Entry

Created in Step 10 of Phase 9, after QB line is confirmed.

```
vehicles row:
  vin, year, make, model, color

serviceOrders row:
  vehicleId   = [new vehicles row]
  source      = 'dealer'
  serviceType = 'dealer_detail'
  status      = 'arrived'
  notes       = "Stock: K518991 | Invoice: 100778"
```

Work board shows: dealership badge, stock number, invoice number, "Waiting" status.

---

## Phase 12 — Database Schema Changes

### New table: `qb_connections`
*(Defined in Phase 0 above)*

### New columns on `dealerships`
```sql
qb_customer_id       VARCHAR(200)   -- QB internal customer ID
qb_customer_name     VARCHAR(200)   -- exact name in QB
billing_email        VARCHAR(200)
tax_exempt           BOOLEAN DEFAULT true
rate_default         INTEGER DEFAULT 200
```

### New columns on `invoice_batches`
```sql
qb_sync_token        VARCHAR(100)   -- current QB syncToken
qb_invoice_status    VARCHAR(30)    -- last known QB status: 'open' | 'sent' | 'paid' | 'voided'
qb_invoice_status_checked_at TIMESTAMP WITH TIME ZONE
```

### New table: `dealer_scans`
```sql
id                UUID PRIMARY KEY DEFAULT gen_random_uuid()
created_at        TIMESTAMP WITH TIME ZONE DEFAULT now()
dealership_id     UUID REFERENCES dealerships(id)

-- Raw scan
raw_barcode       VARCHAR(100)
vin               VARCHAR(17)
vin_source        VARCHAR(20)    -- 'barcode' | 'ocr' | 'manual'
vin_confidence    INTEGER

-- OCR
stock_number      VARCHAR(100)
stock_source      VARCHAR(20)    -- 'ocr' | 'manual'
stock_confidence  INTEGER

year   VARCHAR(4)
make   VARCHAR(100)
model  VARCHAR(100)
color  VARCHAR(100)

-- Tag signals
tag_color         VARCHAR(20)   -- 'yellow' | 'white' | 'unknown'
pricing_prompt_shown  BOOLEAN DEFAULT false
rate              INTEGER       -- 200 or 125 or override

-- NHTSA
nhtsa_year  VARCHAR(4)
nhtsa_make  VARCHAR(100)
nhtsa_model VARCHAR(100)

photo_url  TEXT
crop_url   TEXT

-- Outcome
status          VARCHAR(30)   -- 'pending' | 'approved' | 'duplicate_skipped' | 'error'
approved_at     TIMESTAMP WITH TIME ZONE
approved_by     VARCHAR(200)

-- QB
invoice_batch_id   UUID REFERENCES invoice_batches(id)
qb_line_id         VARCHAR(100)
qb_invoice_number  VARCHAR(100)
qb_sync_status     VARCHAR(30)   -- 'synced' | 'queued' | 'error'
qb_sync_error      TEXT
qb_synced_at       TIMESTAMP WITH TIME ZONE

-- Work board
service_order_id  UUID REFERENCES service_orders(id)
```

### New table: `dealer_scan_events`
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
scan_id     UUID REFERENCES dealer_scans(id)
created_at  TIMESTAMP WITH TIME ZONE DEFAULT now()
event_type  VARCHAR(50)
-- 'scanned' | 'corrected' | 'pricing_prompted' | 'approved'
-- 'qb_synced' | 'qb_queued' | 'duplicate_detected' | 'work_board_created' | 'error'
actor       VARCHAR(200)
old_value   JSONB
new_value   JSONB
note        TEXT
```

### Fix `formatLineDescription` in `invoice-sync.ts`
```typescript
// Before (wrong):
`${vehicle} | ${color} | ${stock}`

// After (matches real QB data):
`${year} ${make} ${model} ${color} #${stock}`
```

---

## Phase 13 — Error Handling

| Failure | Response |
|---------|----------|
| Barcode not detected | Fall back to photo + stock number OCR |
| NHTSA unavailable | Show raw VIN; user fills year/make/model |
| Stock OCR low confidence | Pre-select field in Preview; user must confirm |
| QB auth expired | Show banner "QuickBooks disconnected"; redirect admin to reconnect; block scan |
| QB API unavailable | Queue operation; create work board immediately; show banner |
| QB line write fails | Retry 3×; mark `qb_sync_status = 'error'`; log event |
| Invoice sent/closed | Create new invoice; log transition event |
| Duplicate detected | Block; show existing; offer override |

---

## Phase 14 — Audit Log

Every state change writes a `dealer_scan_events` row. Key events:
- `scanned` — barcode/OCR complete, scan record created
- `corrected` — user edited any field
- `pricing_prompted` — $125/$200 prompt shown + user choice recorded
- `approved` — "Looks Good" tapped
- `invoice_status_checked` — live QB status read before write
- `invoice_created` — new QB invoice created (with QB invoice number)
- `qb_synced` — line confirmed in QB
- `qb_queued` — offline queue
- `work_board_created` — serviceOrder created
- `error` — any failure

---

## Phase 15 — UI Screens

| Screen | Route |
|--------|-------|
| QB integration admin | `/admin/integrations/quickbooks` |
| Dealer scan | `/dealer-check-in` |
| Preview | `/dealer-check-in/preview/[scanId]` |
| Edit | `/dealer-check-in/edit/[scanId]` |
| Duplicate warning | Inline modal on Preview |
| New-vehicle pricing prompt | Inline modal on Preview |
| Success | Work board (with vehicle highlighted) |

**Design rules:**
- Black background, consistent with existing check-in and work board
- Tap targets ≥ 56px height
- Primary action at bottom, full-width
- Headings 28px+, body 18px+, labels 13px
- Disable button rather than show validation errors

---

## Implementation Order

Each row = one commit, fully working, before the next begins.

| # | Phase | Deliverable | Commit message |
|---|-------|-------------|----------------|
| 0a | OAuth schema | `qb_connections` migration + encryption utility | `feat(db): QB OAuth token storage` |
| 0b | OAuth flow | `/admin/integrations/quickbooks` + `/api/auth/quickbooks/*` routes | `feat: QuickBooks OAuth 2.0 integration` |
| 0c | Live QB provider | Replace mock with real API client + auto-refresh | `feat: live QuickBooks API provider` |
| 1 | QB spec doc | `docs/Dealer Invoice Specification.md` from real data | `docs: dealer invoice specification` |
| 2 | DB schema | Migrations for `dealer_scans`, `dealer_scan_events`, dealership columns, batch columns | `feat(db): dealer check-in schema` |
| 3 | Format fix | Correct `formatLineDescription` to match real QB data | `fix: dealer invoice line description format` |
| 4 | Dealer seeding | Seed QB customer names + billing email + stock prefixes | `feat(db): seed dealer QB customer data` |
| 5 | Scan route + API | `/dealer-check-in` camera page + `/api/dealer-check-in/scan` POST | `feat: dealer check-in scan entry point` |
| 6 | Preview + Edit | Preview/Edit screens; scan record created on approval | `feat: dealer check-in preview and edit screens` |
| 7 | Invoice logic | Open vs. sent detection; append or create new | `feat: dealer check-in invoice open/sent logic` |
| 8 | QB write | Append line to QB invoice via live API | `feat: dealer check-in QB invoice write` |
| 9 | Pricing prompt | $125 prompt for new Sterling Auto vehicles | `feat: dealer check-in new-vehicle pricing prompt` |
| 10 | Duplicate check | Stock + VIN + recency duplicate detection | `feat: dealer check-in duplicate protection` |
| 11 | Work board | Create `serviceOrders` row on approval | `feat: dealer check-in work board integration` |
| 12 | Offline queue | QB write queue + retry job | `feat: dealer check-in offline QB queue` |
| 13 | Audit log | `dealer_scan_events` written at every state change | `feat: dealer check-in audit log` |
| 14 | Admin scan view | Dashboard: pending syncs, scan history, QB status | `feat: dealer check-in admin dashboard` |

---

## Decisions Still Deferred (Do Not Hardcode)

| Topic | Current answer | How it will be decided |
|-------|---------------|----------------------|
| Service types beyond "Complete Detail" | Not yet known | Learn from QB history; add when first encountered |
| Additional dealerships | Sterling only for now | Derived from QB customer list; do not hardcode |
| Billing periods | Learn from QB invoice dates | Do not assume monthly |
| Rate changes | $200/$125 only for now | Owner provides explicit rule before hardcoding |
| Employee auth on "approved by" | Defer | Name picker same as current work board until auth is built |

---

**Plan is updated. Awaiting your go-ahead to begin Phase 0a (QB OAuth schema).**
