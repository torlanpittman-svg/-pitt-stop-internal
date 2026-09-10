/**
 * Shared check-rendering: turn a check's values + the layout config into a flat list of positioned
 * fields (inches). ONE builder feeds all three consumers — the browser print page (HTML), the PDF
 * generator for the print bridge, and the enqueued job payload snapshot — so a check looks identical
 * however it is printed, and layout lives only in layout.ts.
 */
import { resolveFieldPosition, buildLayout, PAGE_WIDTH_IN, PAGE_HEIGHT_IN, type CheckLayout, type CheckFieldKey } from './layout'
import { amountToWords, formatAmount } from './amount-words'
import type { CheckView } from './types'
import type { CheckTemplate } from './template'

export interface RenderedField { key: string; value: string; xIn: number; yIn: number; widthIn: number; align: 'left' | 'right'; sizePt: number }
export interface CheckPrintPayload { pageWidthIn: number; pageHeightIn: number; fields: RenderedField[]; template?: CheckTemplate | null }

function usDate(iso: string): string {
  const [y, m, d] = (iso ?? '').slice(0, 10).split('-')
  return y && m && d ? `${m}/${d}/${y}` : iso
}

/** The printable string per field key, from a check view. */
export function checkValues(view: Pick<CheckView, 'checkDate' | 'payeeName' | 'amountCents' | 'memo' | 'checkNumber'>): Record<string, string> {
  return {
    date: usDate(view.checkDate),
    payee: view.payeeName,
    amountBox: formatAmount(view.amountCents),
    amountWords: amountToWords(view.amountCents),
    memo: view.memo ?? '',
    checkNumber: String(view.checkNumber),
  }
}

/** Sample values for TEST PRINT / calibration (clearly non-negotiable). */
export function testValues(): Record<string, string> {
  return { date: usDate(new Date().toISOString()), payee: 'TEST — DO NOT CASH', amountBox: formatAmount(123456), amountWords: amountToWords(123456), memo: 'Alignment test', checkNumber: 'TEST' }
}

/** Positioned fields for a value map under a layout. */
export function buildFields(values: Record<string, string>, layout: CheckLayout): RenderedField[] {
  return layout.fields.map((key: CheckFieldKey) => {
    const p = resolveFieldPosition(layout, key)
    return { key, value: values[key] ?? '', xIn: p.xIn, yIn: p.yIn, widthIn: p.widthIn ?? 2, align: p.align ?? 'left', sizePt: p.sizePt ?? 10 }
  })
}

/** Full print payload (page size + fields + optional blank-stock template) — the enqueue snapshot. */
export function buildCheckPayload(view: CheckView, layout: CheckLayout, template?: CheckTemplate | null): CheckPrintPayload {
  return { pageWidthIn: PAGE_WIDTH_IN, pageHeightIn: PAGE_HEIGHT_IN, fields: buildFields(checkValues(view), layout), template: template ?? null }
}

export { buildLayout, PAGE_WIDTH_IN, PAGE_HEIGHT_IN }
