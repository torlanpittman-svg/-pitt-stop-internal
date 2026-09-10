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
}

export const DEFAULT_LAYOUT: CheckLayout = {
  position: 'top',
  offsetX: 0,
  offsetY: 0,
  sectionHeightIn: CHECK_SECTION_HEIGHT_IN,
  fields: ['date', 'payee', 'amountBox', 'amountWords', 'memo', 'checkNumber'],
  perField: DEFAULT_FIELDS,
}

/** MICR band geometry for a given section height — anchored to the BOTTOM of the top check section.
 *
 *  MICR VERTICAL CALIBRATION (2026-09-10): raised the band from a 0.70" to a 0.86" clearance above the
 *  first perforation. The prior 0.70" put the 12pt baseline ~0.53" above the perforation, which on Blue
 *  Summit BSS-92588-301 landed ON the preprinted blue bottom security border. Per ANSI X9.100-160 the
 *  MICR clear band (bottom 5/8") must be free of any border; this stock's border intrudes there, so the
 *  band is ridden just ABOVE it. 0.86" clearance ⇒ baseline ~0.69" above the perforation (digits ~0.69–
 *  0.81"), the highest the band can sit while keeping a clean gap below the LOCKED memo VALUE (its bottom
 *  ≈ 0.895" above the perforation ⇒ ~0.085" gap) and fully inside the 3.5" section. MICR-ONLY change; no
 *  other field moved. Pending owner physical VOID-print verification. See docs/CHECK_PRINTING_STATUS.md. */
export function micrPos(sectionHeightIn: number) {
  return { startXIn: 0.9, yIn: sectionHeightIn - 0.86, sizePt: 12 }
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

/** Merge a partial override (from saved calibration settings) onto the defaults. Unknown keys ignored. */
export function buildLayout(override?: Partial<CheckLayout> | null): CheckLayout {
  if (!override) return DEFAULT_LAYOUT
  const sh = Number(override.sectionHeightIn)
  return {
    position: override.position ?? DEFAULT_LAYOUT.position,
    offsetX: Number.isFinite(override.offsetX as number) ? (override.offsetX as number) : 0,
    offsetY: Number.isFinite(override.offsetY as number) ? (override.offsetY as number) : 0,
    sectionHeightIn: Number.isFinite(sh) && sh > 1 ? sh : CHECK_SECTION_HEIGHT_IN,
    fields: override.fields?.length ? override.fields : DEFAULT_LAYOUT.fields,
    perField: { ...DEFAULT_FIELDS, ...(override.perField ?? {}) },
  }
}
