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

An earlier physical VOID test showed the MICR placeholder line printing **too LOW** — on the blue bottom
security border of the Blue Summit stock (12pt baseline was ~0.53" above the perforation, `micrPos`
clearance `0.70`).

**Calibration applied 2026-09-10 (commit `71a4317`), AWAITING owner physical verification:** raised the
band to `micrPos` clearance **`0.86`** ⇒ 12pt **baseline ~0.69" above the perforation** (digits ~0.69–
0.81"). Rationale: ANSI X9.100‑160 requires the bottom‑5/8" MICR clear band be free of any border; this
stock's blue border intrudes there, so the band rides just above it. **0.69" is the maximum MICR‑only
raise** — the ceiling is the LOCKED memo VALUE (bottom ~0.895" above the perforation), leaving a ~0.085"
gap. One VOID/non‑negotiable test was queued → claimed once → printed once (no retry/dupe); no check row,
no QuickBooks, no #20000, no real MICR data.

Owner must **physically inspect that VOID print** against the Blue Summit stock:
- If the band now clears the blue border → MICR vertical position can be marked APPROVED.
- If it still contacts the border → the border extends higher than ~0.6" above the perforation, and the
  only further fix requires owner approval to also raise the (currently LOCKED) memo/signature block.

Only the MICR band was reopened; the rest of the layout stays locked (page size, offsets, 3.5" section,
all non‑MICR field positions unchanged). Exact code location: `apps/checks/layout.ts` → `micrPos()`.

Constraints for this work: **No QuickBooks transaction. No real check. No negotiable MICR data.**

## Real negotiable printing — still FAIL-CLOSED

Independent of the above, the 6-item gate before the first real negotiable check remains outstanding:
MICR magnetic toner, licensed E-13B font, secure routing/account env, MICR field/order/spec verified
against American Momentum, MICR positioning verified (blocked by the item above), and explicit owner
authorization of the first controlled live check.
