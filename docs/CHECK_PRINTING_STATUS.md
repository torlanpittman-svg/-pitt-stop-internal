# Check Printing — Physical Calibration Status

Stock: **Blue Summit BSS-92588-301** (genuinely blank, 3-part perforated, TOP position, no preprinted MICR).
Path: Pitt Stop OS → cloud print queue → Windows shop-laptop bridge → Brother HL-L2420DW.

## ✅ APPROVED & LOCKED — do not change

Proven by physical VOID test. Do NOT modify:

- 3.5" top-section height
- Internal vertical geometry (company/bank blocks, payee, amount box, memo, signature, date, check #)
- Horizontal geometry
- `offsetX = 0`, `offsetY = 0`
- Letter page size
- Sumatra `noscale` / 100% (actual-size) printing
- Brother print path

## ❌ NOT YET APPROVED — reopened 2026-09-10

**MICR vertical position only.**

The latest physical VOID test showed the MICR placeholder line
(`NON-NEGOTIABLE TEST - MICR LINE PRINTS HERE`) prints **too LOW** — essentially on top of the blue
security border at the bottom of the negotiable check section on the Blue Summit stock.

Do **not** treat MICR positioning as verified. Only the MICR band is reopened; the rest of the layout
stays locked.

Exact code location: `apps/checks/layout.ts` → `micrPos()` (`yIn: sectionHeightIn - 0.70`). The band must
move **UP** (increase the clearance subtracted from the section bottom). No other field changes.

### Next steps when we return to check printing

1. Verify proper U.S. MICR clear-band / baseline positioning requirements.
2. Move **only** the MICR band upward.
3. Generate a VOID preview.
4. Print **one** VOID test.
5. Physically verify against the Blue Summit stock.

Constraints for this work: **No QuickBooks transaction. No real check. No negotiable MICR data.**

## Real negotiable printing — still FAIL-CLOSED

Independent of the above, the 6-item gate before the first real negotiable check remains outstanding:
MICR magnetic toner, licensed E-13B font, secure routing/account env, MICR field/order/spec verified
against American Momentum, MICR positioning verified (blocked by the item above), and explicit owner
authorization of the first controlled live check.
