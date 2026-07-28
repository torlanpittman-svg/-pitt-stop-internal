# Dealer Invoice Specification

> Phase 1 of the Dealer Check-In System.
> Source of truth: **QuickBooks Online**. This document records the *learned*
> structure of a Sterling dealer invoice so the check-in flow can reproduce it
> exactly. Values come from historical Sterling invoices (forensic audit, Jul 2026)
> and a live QuickBooks read — not from assumptions.

> Environment note (2026-07-28): the pipeline is being built and validated against
> the QuickBooks **sandbox** company. Customer IDs below are production values to be
> re-verified at go-live; sandbox IDs (58/59/60) are used during development. The
> *structure* is identical across environments.

---

## 1. Dealer Customers

| Dealership | QB DisplayName (exact) | Stock prefixes | Billing email |
|------------|------------------------|----------------|---------------|
| Sterling Kia | `Sterling Kia` | `K` | billing@sterlingautogroup.net |
| Sterling Subaru | `Sterling Subaru` | `U` | billing@sterlingautogroup.net |
| Sterling Auto Group | `Sterling Auto Group` | `S`, `T` | billing@sterlingautogroup.net |

- All three Sterling entities share one billing email.
- `S` and `T` are two stock series for the same QB customer (Sterling Auto Group).
- The QB customer ID is stored on `dealerships.qb_customer_id` per prefix row —
  looked up live via `ensureCustomer`, never hardcoded.

**Prefix → dealer resolution:** first letter of the stock number
(`extractStockPrefix`), matched against `dealerships.stock_prefix`.

---

## 2. Invoice Header

| Field | Value |
|-------|-------|
| Customer | one of the three Sterling customers above |
| Terms | Due on receipt |
| Customer taxable | No (tax-exempt) |
| Tax rows | present at $0.00 (6.25% / 0.50% / 1.50%) — never charged |
| Currency | USD |
| Custom field `Num` | invoice number |
| Custom field `Pmt Meth Ref No.` | invoice number |
| DocNumber | assigned by QuickBooks (6-digit, sequential) — **Pitt Stop never sets it** |

---

## 3. Line Item (one per vehicle)

```
Product/Service : Complete Detail
Description     : {YEAR} {MAKE} {MODEL} {COLOR} #{STOCK}
Service Date    : date the work was performed
Qty            : 1
Rate           : 200  (or 125 — see §4)
Amount         : Rate × Qty
Account        : Detail Sales
Taxable        : No
```

### Description format (confirmed)

`{YEAR} {MAKE} {MODEL} {COLOR} #{STOCK}`

Real examples from Sterling invoices:
- `2021 Honda Civic Gray #K518991`
- `2024 Kia Telluride Gray #K473262`
- `2026 Subaru Forester River Rock #UP003483`
- `2026 Kia Carnival Ceramic #K563327`

Edge case: a line may carry no stock (`VW Atlas Blue`) when the tag lacked one —
the `#{STOCK}` segment is omitted, not left blank. This is implemented in
`formatLineDescription` (`apps/vehicle-entry/invoice-sync.ts`), which now emits the
`#`-prefixed format and drops empty segments.

---

## 4. Pricing

| Situation | Rate | Behavior |
|-----------|------|----------|
| Standard dealer detail | **$200** | Applied silently. |
| New Sterling Auto vehicle | **$125** | Prompt required (see below). |

`dealerships.rate_default` = 200 for all dealers.

**New Sterling Auto vehicle** signals (neither reliable alone):
1. Stock number begins with `T`, and/or
2. White dealer tag (vs. standard yellow).

If **either** signal is present, the check-in preview must prompt:

> "This appears to be a new Sterling Auto vehicle. Charge $125 instead of the
> standard $200?"  ·  `Yes — $125` / `No — $200`

Never auto-select $125. When neither signal fires, use $200 with no prompt.

---

## 5. Invoice Model — Batch (append vs. new)

One invoice per dealership per billing period; multiple vehicles per invoice.
Confirmed: Invoice 100778 (Sterling Kia, 6 vehicles, $1,200), Invoice 100799
(Sterling Kia, 5 vehicles, $1,325).

**At check-in, resolve the target invoice by a LIVE QB read** (never cached status):

| QB invoice state | Meaning | Action |
|------------------|---------|--------|
| Draft / open, `EmailStatus ≠ EmailSent` | still collecting vehicles | **append** new line |
| `EmailStatus = EmailSent` | sent to dealership | **create new** invoice |
| Paid / closed / voided | closed | **create new** invoice |

`findAppendableInvoice(customerId)` (`apps/quickbooks/invoices.ts`) returns the
most-recent open, not-yet-sent invoice, or `null` when a new one must be created.

**Rationale:** the AutoLeap incident proved QB state can change without notice, so
we always read fresh before writing and never modify a sent invoice.

---

## 6. Field Sources

| Field | Source |
|-------|--------|
| Year / Make / Model | NHTSA decode of VIN (preferred) → OCR fallback |
| Color | OCR of tag → manual picker fallback |
| Stock number | dedicated OCR pipeline → manual fallback |
| Service date | check-in date |
| Rate | $200 default; $125 via prompt (§4) |
| Customer | dealer resolved from stock prefix (§1) |
| Account / Product-Service | fixed: Detail Sales / Complete Detail |

---

## 7. Open Items for Go-Live (production)

- Re-verify production QB customer IDs for the three Sterling customers and
  re-run `POST /api/quickbooks/setup-dealers` against the live company.
- Confirm the exact `Item` (Product/Service) name "Complete Detail" and income
  account "Detail Sales" exist in the live company (create/map if the names differ).
- Confirm tax code / exemption is set at the customer level in the live company.
- Production requires Intuit **Production keys** + an **https** redirect URI
  (Vercel domain) + app profile URLs (host, launch, disconnect, privacy, EULA).
