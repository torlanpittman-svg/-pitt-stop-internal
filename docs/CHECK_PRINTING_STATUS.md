# Check Printing — Physical Calibration Status

Stock: **replacement MICR-compliant stock** (genuinely blank, 3-part perforated, TOP position, no
preprinted MICR, with a clear bottom 5/8" MICR band). Supersedes the earlier Blue Summit BSS-92588-301,
whose bottom security border fell in/near the MICR clear band.
Path: Pitt Stop OS → cloud print queue → Windows shop-laptop bridge → Brother HL-L2420DW.

## Current status (2026-09-16)

- **Replacement stock physical VOID test PASSED.** A single non-negotiable VOID test check was printed on
  the replacement stock through the production pipeline (queue → Windows bridge `LAPTOP-RF8IO1H2` →
  SumatraPDF `noscale`/100% → Brother HL-L2420DW). No QuickBooks record, no check-ledger row, no
  check-number consumption.
- **MICR VERTICAL position is APPROVED & LOCKED** (owner physically verified on the replacement stock):
  - first perforation correctly at ≈ **3.5"** from the top;
  - MICR baseline ≈ **3/16" (0.1875") above the perforation** — i.e. **3.3125" from the page top**;
  - the MICR placeholder sits **completely inside the blank white MICR clear band**;
  - it does **not** touch or overlap the blue security border;
  - **no MICR vertical adjustment is required; no additional vertical calibration print is needed.**
- **MICR HORIZONTAL position is NOT yet approved.** The approval above is vertical only. The inspection
  photo's ruler/crop obscured the full left/right edges, and the test used placeholder text rather than the
  final licensed E-13B string. Horizontal field placement must still be verified (see reopened section).
- **Negotiable MICR remains DISABLED** (`micr_enabled` off, no secrets, fail-closed) and **live check
  recording remains DISABLED** (`checks_live_enabled` off). Check sequence still starts at **#20000
  (unconsumed)**.

## ✅ APPROVED & LOCKED — do not change

The OVERALL non‑MICR check geometry is approved and locked. Do NOT modify:

- 3.5" top-section height
- Letter page size (8.5×11)
- Sumatra `noscale` / 100% (actual-size) printing
- Global `offsetX = 0`, `offsetY = 0`
- Company block, date, payee, numeric amount, written amount, bank name, memo, signature line, check #
- All other **non‑MICR** geometry
- Brother print path

**MICR VERTICAL band position (NEW — LOCKED 2026-09-16):**
- baseline **3.3125" from the page top** = **3/16" (0.1875") above the 3.5" bottom edge of the top check**;
- implemented as the standards default `MICR_BASELINE_FROM_BOTTOM_IN = 0.1875` (layout.ts), resolvable via
  the isolated `micr_layout` setting. Physically verified inside the replacement stock's clear band.

## ❌ REOPENED / NOT APPROVED — MICR HORIZONTAL positioning only (2026-09-16)

The MICR **VERTICAL** position is now locked (above). Only the **HORIZONTAL** field positions remain
unverified. Horizontal placement is standards-based (ANSI X9.100‑160 / X9.13):
- fields positioned **from the RIGHT edge**, fixed **8 characters/inch (0.125" pitch)**, E‑13B at **10pt**:
  Amount (bank‑printed, blank) positions 1–12; On‑Us (account); Transit (9‑digit routing between ⑆);
  Auxiliary On‑Us (business check serial) at position ~45+ (≤1/8" from the left edge).
- Current defaults: `rightMarginIn = 0.25`, `amountFieldIn = 1.5` (right anchor = 6.75" from the left edge).
- Must be verified with an **overhead photo showing the full left AND right edges** and, ultimately, the
  **final licensed E‑13B string** (not placeholder text) — left/right clearance from the stock's clear-band
  edges must be confirmed.

Only the isolated MICR coordinates may be adjusted, via the `micr_layout` setting (see below). This never
touches any locked non‑MICR field.

Constraints while reopened: **No QuickBooks transaction. No real check. No #20000 consumed. No negotiable
MICR data. Negotiable printing stays fail‑closed.**

## Isolated MICR calibration write path (`micr_layout`)

MICR coordinates are changed ONLY through the manager/admin-gated endpoint
`/api/admin/checks/micr-layout` (`apps/checks/micr-config.ts`). It:
- writes ONLY the `micr_layout` setting; the five allowed fields are `baselineFromBottomIn`,
  `rightMarginIn`, `amountFieldIn`, `pitchIn`, `sizePt`;
- **rejects** any non‑MICR geometry key (`offsetX`/`offsetY`/`sectionHeightIn`/`position`/`fields`/
  `perField`) and the `micr_enabled` flag;
- range-validates every value (no silent coercion);
- **requires an explicit reason** and records who / when / old / new append-only in `micr_layout_audit`
  (migration `0037_micr_layout_audit.sql`);
- **never** enables MICR, creates a check or QuickBooks transaction, or consumes / advances a check number.
  Negotiable printing stays fail‑closed.

## Real negotiable printing — still FAIL-CLOSED

Independent of the above, the negotiable-check gate still has outstanding items:
- ✅ MICR **vertical** positioning — LOCKED (physically verified on replacement stock, 2026-09-16).
- ⬜ MICR **horizontal** positioning — verify full left/right clearance with the final licensed E‑13B string.
- ⬜ MICR magnetic toner installed in the Brother (TN‑series MICR toner for the HL‑L2420DW).
- ⬜ Licensed E-13B font installed + embedded (`MICR_FONT_PATH` file path or `MICR_FONT_B64`).
- ⬜ Secure routing/account in server-only env (`MICR_ROUTING` / `MICR_ACCOUNT`).
- ⬜ MICR field/order/spec verified against American Momentum (or an authoritative AMB sample).
- ⬜ `micr_enabled` turned on.
- ⬜ `checks_live_enabled` turned on + explicit owner authorization of the first controlled live check.
