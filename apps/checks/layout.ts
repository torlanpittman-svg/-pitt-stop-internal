/**
 * Check print LAYOUT — the SINGLE place physical measurements live. Nothing else in the codebase
 * hard-codes a check coordinate. Everything is in INCHES from the top-left of the individual check,
 * on US Letter (8.5" × 11"). The print page (app/checks/print) converts inches → CSS at 96dpi.
 *
 * Calibration model:
 *   - `position` selects which check on a 3-up business-check sheet we print into (top/middle/bottom).
 *     Each slot is CHECK_HEIGHT_IN tall; the slot's y-origin is added automatically.
 *   - `offsetX`/`offsetY` are a GLOBAL nudge (inches) applied to every field, tuned once against the
 *     real stock via TEST PRINT. Positive x = right, positive y = down.
 *   - Per-field coordinates below are sensible defaults for a standard business voucher check and are
 *     EXPECTED to be adjusted after the first plain-paper alignment test.
 *
 * IMPORTANT: These defaults do NOT print any bank routing/account (MICR) — see FIELD list. MICR is only
 * added if the owner confirms the stock is blank (unusual), and never with fabricated bank data.
 */

export const PAGE_WIDTH_IN = 8.5
export const PAGE_HEIGHT_IN = 11
export const CHECK_HEIGHT_IN = 3.5 // one check slot on a standard 3-up business check sheet

export type CheckPosition = 'top' | 'middle' | 'bottom'

export interface FieldPos { xIn: number; yIn: number; widthIn?: number; align?: 'left' | 'right'; sizePt?: number }

/** Default field coordinates relative to the check's own top-left corner (inches). */
export const DEFAULT_FIELDS = {
  date:          { xIn: 6.55, yIn: 0.42, widthIn: 1.6, align: 'left'  as const, sizePt: 10 },
  payee:         { xIn: 1.05, yIn: 1.02, widthIn: 4.9, align: 'left'  as const, sizePt: 11 },
  amountBox:     { xIn: 6.75, yIn: 0.98, widthIn: 1.4, align: 'right' as const, sizePt: 11 }, // "$1,500.34"
  amountWords:   { xIn: 0.30, yIn: 1.46, widthIn: 7.4, align: 'left'  as const, sizePt: 10 }, // "One Thousand … and 34/100"
  memo:          { xIn: 0.65, yIn: 2.62, widthIn: 3.2, align: 'left'  as const, sizePt: 9  },
  checkNumber:   { xIn: 7.05, yIn: 0.12, widthIn: 1.2, align: 'right' as const, sizePt: 11 }, // usually PRE-PRINTED; off by default
} satisfies Record<string, FieldPos>

export type CheckFieldKey = keyof typeof DEFAULT_FIELDS

export interface CheckLayout {
  position: CheckPosition
  offsetX: number
  offsetY: number
  /** Which fields to actually render. `checkNumber` is OFF by default (pre-printed on most stock). */
  fields: CheckFieldKey[]
  perField: Record<string, FieldPos>
}

export const DEFAULT_LAYOUT: CheckLayout = {
  position: 'top',
  offsetX: 0,
  offsetY: 0,
  fields: ['date', 'payee', 'amountBox', 'amountWords', 'memo'],
  perField: DEFAULT_FIELDS,
}

/** The y-origin (inches from page top) of a check slot. */
export function slotOriginY(position: CheckPosition): number {
  if (position === 'middle') return CHECK_HEIGHT_IN
  if (position === 'bottom') return CHECK_HEIGHT_IN * 2
  return 0
}

/** Absolute page position (inches from page top-left) for a field, applying slot origin + global offset. */
export function resolveFieldPosition(layout: CheckLayout, key: CheckFieldKey): FieldPos {
  const base = layout.perField[key] ?? DEFAULT_FIELDS[key]
  return {
    ...base,
    xIn: base.xIn + layout.offsetX,
    yIn: base.yIn + slotOriginY(layout.position) + layout.offsetY,
  }
}

/** Merge a partial override (from saved calibration settings) onto the defaults. Unknown keys ignored. */
export function buildLayout(override?: Partial<CheckLayout> | null): CheckLayout {
  if (!override) return DEFAULT_LAYOUT
  return {
    position: override.position ?? DEFAULT_LAYOUT.position,
    offsetX: Number.isFinite(override.offsetX as number) ? (override.offsetX as number) : 0,
    offsetY: Number.isFinite(override.offsetY as number) ? (override.offsetY as number) : 0,
    fields: override.fields?.length ? override.fields : DEFAULT_LAYOUT.fields,
    perField: { ...DEFAULT_FIELDS, ...(override.perField ?? {}) },
  }
}
