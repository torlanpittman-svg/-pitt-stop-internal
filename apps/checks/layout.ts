/**
 * Check print LAYOUT — the SINGLE place physical measurements live. Nothing else in the codebase
 * hard-codes a check coordinate. Everything is in INCHES from the top-left of the individual check,
 * on US Letter (8.5" × 11"). The print page (app/checks/print) converts inches → CSS at 96dpi.
 *
 * PHYSICAL GEOMETRY (Blue Summit BSS blank stock, check-on-top):
 *   - The negotiable check occupies ONLY the top section of the sheet, ending at the FIRST PERFORATION.
 *     `CHECK_SECTION_HEIGHT_IN` is that height (top edge → first perforation). The two sections below are
 *     left blank (voucher/stub). This is SEPARATE from the sheet-thirds slot math.
 *   - The whole check must fit within CHECK_SECTION_HEIGHT_IN. The date/payee/amount live in the upper
 *     part (top-anchored); memo, signature line, and the MICR band are anchored to the BOTTOM of the
 *     section (fromBottom) so they always sit just inside the first perforation for any section height.
 *   - `sectionHeightIn` is overridable via the saved check_layout setting, so the exact measured value is
 *     set without a code change.
 *
 * Calibration model: `offsetX`/`offsetY` are a global nudge (inches) for fine X/Y alignment ONLY — never
 * to compensate for wrong dimensions. Positive x = right, positive y = down.
 */

export const PAGE_WIDTH_IN = 8.5
export const PAGE_HEIGHT_IN = 11
// Sheet-thirds slot height (physical perforation into three parts) — used only for middle/bottom slots.
export const CHECK_HEIGHT_IN = 11 / 3
// Height of the TOP negotiable check section (top edge → first perforation). PROVISIONAL default until the
// owner supplies the measured value (set via the check_layout setting's `sectionHeightIn`). Everything on
// the check is fit within this height.
export const CHECK_SECTION_HEIGHT_IN = 3.5

// ── MICR geometry — STANDARDS-BASED (ANSI X9.100-160 / X9.13). ────────────────────────────────────────
// These are the authoritative defaults; every value is overridable via the `micr_layout` setting so the
// exact landing is finalized by physical VOID test against the actual stock WITHOUT a code change and
// WITHOUT touching any non-MICR field.
export const MICR_PITCH_IN = 0.125                 // fixed 8 characters/inch
export const MICR_SIZE_PT = 10                     // E-13B meets ABA/ISO at 10pt @ 8 CPI
export const MICR_CLEAR_BAND_IN = 0.625            // bottom 5/8" clear band (must be free of any border)
export const MICR_BASELINE_FROM_BOTTOM_IN = 0.1875 // 3/16" — character baseline above the bottom (aligning) edge
export const MICR_RIGHT_MARGIN_IN = 0.25           // inset of MICR position 1 from the right paper edge
export const MICR_AMOUNT_FIELD_IN = 1.5            // positions 1-12 (Amount) left blank — the bank prints it

export interface MicrGeom {
  baselineFromBottomIn: number  // character baseline distance above the bottom (aligning) edge
  rightMarginIn: number         // inset of MICR position 1 from the right paper edge
  amountFieldIn: number         // blank Amount field width reserved at the far right (positions 1-12)
  pitchIn: number               // fixed character pitch (8 CPI = 0.125")
  sizePt: number                // E-13B point size (10pt)
}
export const DEFAULT_MICR_GEOM: MicrGeom = {
  baselineFromBottomIn: MICR_BASELINE_FROM_BOTTOM_IN, rightMarginIn: MICR_RIGHT_MARGIN_IN,
  amountFieldIn: MICR_AMOUNT_FIELD_IN, pitchIn: MICR_PITCH_IN, sizePt: MICR_SIZE_PT,
}
const posNum = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d)
export function micrGeom(override?: Partial<MicrGeom> | null): MicrGeom {
  if (!override) return DEFAULT_MICR_GEOM
  return {
    baselineFromBottomIn: posNum(override.baselineFromBottomIn, DEFAULT_MICR_GEOM.baselineFromBottomIn),
    rightMarginIn: posNum(override.rightMarginIn, DEFAULT_MICR_GEOM.rightMarginIn),
    amountFieldIn: posNum(override.amountFieldIn, DEFAULT_MICR_GEOM.amountFieldIn),
    pitchIn: posNum(override.pitchIn, DEFAULT_MICR_GEOM.pitchIn) || MICR_PITCH_IN,
    sizePt: posNum(override.sizePt, DEFAULT_MICR_GEOM.sizePt) || MICR_SIZE_PT,
  }
}

export interface MicrPlacement { baselineYIn: number; rightAnchorXIn: number; pitchIn: number; sizePt: number }
/**
 * Standards-based MICR band placement (inches from the check's top-left):
 *   - baselineYIn  = the CHARACTER BASELINE, `baselineFromBottomIn` above the bottom (aligning) edge, which
 *                    for the top check is the first perforation at `sectionHeightIn`.
 *   - rightAnchorXIn = x of the RIGHTMOST printed MICR character. ANSI positions are counted from the RIGHT
 *                    edge, and the Amount field (positions 1-12) is left blank for the bank, so the right
 *                    anchor is inset from the right paper edge by the right margin + the Amount field.
 * Fixed pitch (8 CPI) — the renderer advances every character by exactly `pitchIn`.
 */
export function micrPlacement(sectionHeightIn: number, pageWidthIn: number, g: MicrGeom = DEFAULT_MICR_GEOM): MicrPlacement {
  return {
    baselineYIn: sectionHeightIn - g.baselineFromBottomIn,
    rightAnchorXIn: pageWidthIn - g.rightMarginIn - g.amountFieldIn,
    pitchIn: g.pitchIn, sizePt: g.sizePt,
  }
}

export type CheckPosition = 'top' | 'middle' | 'bottom'

// `fromBottomIn`, when set, anchors the field's baseline that many inches ABOVE the section's bottom edge
// (so it tracks the first perforation regardless of section height). Otherwise `yIn` (from the top) is used.
export interface FieldPos { xIn: number; yIn?: number; fromBottomIn?: number; widthIn?: number; align?: 'left' | 'right'; sizePt?: number }

/**
 * Default field coordinates (inches) for Blue Summit BLANK top-position stock (we draw the whole face —
 * see template.ts). Upper fields are top-anchored; `memo` is bottom-anchored so it stays inside the first
 * perforation. checkNumber is printed top-right. MICR is separate (micr.ts).
 */
export const DEFAULT_FIELDS = {
  date:          { xIn: 5.70, yIn: 0.52, widthIn: 2.3, align: 'left'  as const, sizePt: 10 },
  payee:         { xIn: 1.65, yIn: 1.02, widthIn: 4.6, align: 'left'  as const, sizePt: 11 },
  amountBox:     { xIn: 6.55, yIn: 1.04, widthIn: 1.55,align: 'right' as const, sizePt: 12 }, // "$1,500.34" inside the box
  amountWords:   { xIn: 0.35, yIn: 1.48, widthIn: 6.9, align: 'left'  as const, sizePt: 11 }, // "One Thousand … and 34/100"
  memo:          { xIn: 0.95, fromBottomIn: 1.02, widthIn: 2.3, align: 'left'  as const, sizePt: 9 },
  checkNumber:   { xIn: 7.05, yIn: 0.24, widthIn: 1.2, align: 'right' as const, sizePt: 13 },
} satisfies Record<string, FieldPos>

export type CheckFieldKey = keyof typeof DEFAULT_FIELDS

export interface CheckLayout {
  position: CheckPosition
  offsetX: number
  offsetY: number
  sectionHeightIn: number
  fields: CheckFieldKey[]
  perField: Record<string, FieldPos>
  micr: MicrGeom            // standards-based MICR geometry (overridable via micr_layout for calibration)
}

export const DEFAULT_LAYOUT: CheckLayout = {
  position: 'top',
  offsetX: 0,
  offsetY: 0,
  sectionHeightIn: CHECK_SECTION_HEIGHT_IN,
  fields: ['date', 'payee', 'amountBox', 'amountWords', 'memo', 'checkNumber'],
  perField: DEFAULT_FIELDS,
  micr: DEFAULT_MICR_GEOM,
}

/** The y-origin (inches from page top) of a check slot (only 'top' is used for this stock). */
export function slotOriginY(position: CheckPosition): number {
  if (position === 'middle') return CHECK_HEIGHT_IN
  if (position === 'bottom') return CHECK_HEIGHT_IN * 2
  return 0
}

/** Resolve a field's y within the section (top- or bottom-anchored) then apply slot origin + offset. */
function fieldY(base: FieldPos, layout: CheckLayout): number {
  const within = base.fromBottomIn != null ? layout.sectionHeightIn - base.fromBottomIn : (base.yIn ?? 0)
  return within + slotOriginY(layout.position) + layout.offsetY
}

export interface ResolvedFieldPos { xIn: number; yIn: number; widthIn?: number; align?: 'left' | 'right'; sizePt?: number }

/** Absolute page position (inches from page top-left) for a field, applying anchor + slot origin + offset. */
export function resolveFieldPosition(layout: CheckLayout, key: CheckFieldKey): ResolvedFieldPos {
  const base = layout.perField[key] ?? DEFAULT_FIELDS[key]
  return { xIn: base.xIn + layout.offsetX, yIn: fieldY(base, layout), widthIn: base.widthIn, align: base.align, sizePt: base.sizePt }
}

/** Merge a partial override (from saved calibration settings) onto the defaults. Unknown keys ignored.
 *  `micr` accepts a partial MICR-geometry override (from the `micr_layout` setting) — MICR-only calibration
 *  that never touches the locked non-MICR fields. */
export function buildLayout(override?: (Omit<Partial<CheckLayout>, 'micr'> & { micr?: Partial<MicrGeom> | null }) | null): CheckLayout {
  if (!override) return DEFAULT_LAYOUT
  const sh = Number(override.sectionHeightIn)
  return {
    position: override.position ?? DEFAULT_LAYOUT.position,
    offsetX: Number.isFinite(override.offsetX as number) ? (override.offsetX as number) : 0,
    offsetY: Number.isFinite(override.offsetY as number) ? (override.offsetY as number) : 0,
    sectionHeightIn: Number.isFinite(sh) && sh > 1 ? sh : CHECK_SECTION_HEIGHT_IN,
    fields: override.fields?.length ? override.fields : DEFAULT_LAYOUT.fields,
    perField: { ...DEFAULT_FIELDS, ...(override.perField ?? {}) },
    micr: micrGeom(override.micr),
  }
}
