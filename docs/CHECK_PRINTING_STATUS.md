# Check Printing — Physical Calibration Status

Stock: **Blue Summit BSS-92588-301** (genuinely blank, 3-part perforated, TOP position, no preprinted MICR).
Path: Pitt Stop OS → cloud print queue → Windows shop-laptop bridge → Brother HL-L2420DW.

## ✅ APPROVED & LOCKED — do not change

The OVERALL non‑MICR check geometry is approved and locked. Do NOT modify:

- 3.5" top-section height
- Letter page size
- Sumatra `noscale` / 100% (actual-size) printing
- Global `offsetX = 0`, `offsetY = 0`
- Company block, date, payee, numeric amount, written amount, bank name, memo, signature line, check #
- All other **non‑MICR** geometry
- Brother print path

## ❌ REOPENED / NOT APPROVED — MICR positioning only (2026-09-10)

**Both the MICR VERTICAL baseline/band position AND the MICR HORIZONTAL field positions are NOT locked.**

Physical evidence: the latest VOID test showed the MICR placeholder printing essentially **on top of the
blue bottom security border** of the Blue Summit stock. A prior ad‑hoc value (`micrPos` clearance `0.86`,
12pt baseline ~0.69" above the perforation) was mistakenly marked approved; that is **withdrawn**. Do NOT
preserve the old MICR Y — there is physical evidence it is wrong.

MICR positioning must be derived from **authoritative MICR requirements** (ANSI X9.100‑160 / X9.13), not an
ad‑hoc value:
- **Vertical:** MICR **clear band = bottom 5/8" (0.625")** of the check (must be free of any border). MICR
  **print band = 3/16"–7/16" (0.1875"–0.4375")** from the bottom (aligning) edge; **baseline = 3/16"
  (0.1875") from the bottom edge**. For our top check the bottom edge is the 3.5" perforation ⇒ baseline
  ≈ **3.3125" from the check top** (0.1875" above the perforation).
- **Horizontal:** fields are positioned **from the RIGHT edge**, fixed **8 characters/inch (0.125" pitch)**,
  E‑13B at **10pt**: Amount (bank‑printed, blank) positions 1–12; On‑Us (account); Transit (9‑digit routing
  between ⑆); Auxiliary On‑Us (business check serial number) at position ~45+ (≤1/8" from the left edge).

Implementation is **standards‑based by default and configurable** (via the `micr_layout` setting) so the
exact landing is finalized by physical VOID test against the actual Blue Summit stock — WITHOUT touching any
non‑MICR field. ⚠️ Open physical question the VOID test must answer: does the Blue Summit blue border sit
INSIDE the mandatory bottom‑5/8" clear band? If so, this stock cannot carry a standards‑compliant MICR line
and different check stock (with a proper clear band) is required.

Constraints while reopened: **No QuickBooks transaction. No real check. No #20000 consumed. No negotiable
MICR data. Negotiable printing stays fail‑closed.**

## Real negotiable printing — still FAIL-CLOSED

Independent of the above, the negotiable-check gate still has outstanding items:
- ⬜ MICR **positioning** (horizontal + vertical) — standards-based implementation in progress; must be
  finalized by a physical VOID test against the Blue Summit stock (see reopened section above).
- ⬜ MICR magnetic toner installed in the Brother.
- ⬜ Licensed E-13B font installed + embedded (`MICR_FONT_PATH`).
- ⬜ Secure routing/account in server-only env (`MICR_ROUTING` / `MICR_ACCOUNT`).
- ⬜ MICR field/order/spec verified against American Momentum (or an authoritative AMB sample).
- ⬜ `micr_enabled` turned on.
- ⬜ Explicit owner authorization of the first controlled live check.
