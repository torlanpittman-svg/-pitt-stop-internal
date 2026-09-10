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
- **MICR vertical position** — `micrPos` clearance **`0.86`** ⇒ 12pt **baseline ~0.69" above the perforation**
  (digits ~0.69–0.81"). ✅ Owner physically verified 2026-09-10 that the VOID print clears the Blue Summit
  blue bottom security border. Do NOT change without owner re-approval.

## MICR vertical calibration — history (RESOLVED 2026-09-10)

An earlier physical VOID test showed the MICR line printing **too LOW** — on the blue bottom security
border of the Blue Summit stock (12pt baseline ~0.53" above the perforation, `micrPos` clearance `0.70`).

Fix (commit `71a4317`): raised the band MICR-ONLY to `micrPos` clearance **`0.86`** ⇒ baseline **~0.69"
above the perforation**. Rationale: ANSI X9.100‑160 requires the bottom‑5/8" MICR clear band be free of
any border; this stock's blue border intrudes there, so the band rides just above it. 0.69" is the maximum
MICR‑only raise — the ceiling is the LOCKED memo VALUE (bottom ~0.895" above the perforation), leaving a
~0.085" gap. One VOID/non‑negotiable test was queued → claimed once → printed once (no retry/dupe), and the
owner **physically confirmed the band now clears the blue border** ⇒ APPROVED & LOCKED (above). No other
field moved. No QuickBooks, no check row, no #20000 consumed, no real MICR data.

## Real negotiable printing — still FAIL-CLOSED

Independent of the above, the negotiable-check gate still has outstanding items:
- ✅ MICR **positioning** verified (VOID print, 2026-09-10).
- ⬜ MICR magnetic toner installed in the Brother.
- ⬜ Licensed E-13B font installed + embedded (`MICR_FONT_PATH`).
- ⬜ Secure routing/account in server-only env (`MICR_ROUTING` / `MICR_ACCOUNT`).
- ⬜ MICR field/order/spec verified against American Momentum (or an authoritative AMB sample).
- ⬜ `micr_enabled` turned on.
- ⬜ Explicit owner authorization of the first controlled live check.
