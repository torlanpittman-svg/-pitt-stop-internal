/**
 * Estimate item editor drafts — what the user typed vs. what the server has, turned into the exact
 * edits to send. Pure, so the Save/Retry behaviour is unit-tested without a browser.
 *
 * Save sends only what changed, in order. Because each confirmed edit refreshes the server view,
 * planning again after a partial failure sends only what is still different — Retry never repeats
 * an edit that already saved.
 */
import type { EstimateEdit, PartView, ServiceView } from './save-feedback'

export const dollars = (c: number) => (c / 100).toFixed(2)
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** '' → null (untouched); otherwise integer cents, or NaN when it isn't a usable amount. */
export function parseMoney(s: string): number | null {
  const t = s.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!t) return null
  if (!/^\d*\.?\d*$/.test(t) || t === '.') return NaN
  return Math.round(parseFloat(t) * 100)
}

export interface ServiceDraft { title: string; price: string; detail: string }
export const serviceDraftFrom = (s: ServiceView): ServiceDraft =>
  ({ title: s.title, price: s.priceCents != null ? dollars(s.priceCents) : '', detail: s.detail ?? '' })

export type Plan = { ok: true; edits: EstimateEdit[] } | { ok: false; error: string }

/**
 * Name → rename_service (keeps catalog identity, QuickBooks item, description, price, qty, tax).
 * Price → set_service_price (only on an itemized estimate; a blank price is left unpriced, never $0).
 * Area → set_detail (may be cleared).
 */
export function planServiceSave(s: ServiceView, d: ServiceDraft, flat: boolean): Plan {
  const title = clean(d.title)
  if (!title) return { ok: false, error: 'Enter a name for this item.' }
  const edits: EstimateEdit[] = []
  if (title !== clean(s.title)) edits.push({ action: 'rename_service', serviceId: s.id, title })
  if (!flat) {
    const cents = parseMoney(d.price)
    if (Number.isNaN(cents)) return { ok: false, error: 'Enter the price as a dollar amount, like 125 or 125.50.' }
    if (cents == null && s.priceCents != null) return { ok: false, error: 'Enter a price. A saved price can be changed but not cleared.' }
    if (cents != null && cents !== s.priceCents) edits.push({ action: 'set_service_price', serviceId: s.id, cents })
  }
  if (clean(d.detail) !== clean(s.detail)) edits.push({ action: 'set_detail', serviceId: s.id, detail: clean(d.detail) })
  return { ok: true, edits }
}

export interface PartDraft { description: string; sell: string; quantity: string; cost: string; fitment: string; partNumber: string; supplier: string }
export const partDraftFrom = (p: PartView): PartDraft => ({
  description: p.description, sell: p.sellPriceCents != null ? dollars(p.sellPriceCents) : '', quantity: String(p.quantity),
  cost: p.unitCostCents != null ? dollars(p.unitCostCents) : '', fitment: p.fitment ?? '', partNumber: p.partNumber ?? '', supplier: p.supplier ?? '',
})

/** One update_part with only the changed fields (or no edit when nothing changed). */
export function planPartSave(p: PartView, d: PartDraft): Plan {
  const description = clean(d.description)
  if (!description) return { ok: false, error: 'Describe the part.' }
  const qty = Number(d.quantity.trim())
  if (!d.quantity.trim() || !Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'Enter a quantity greater than 0.' }
  const sell = p.supply === 'shop' ? parseMoney(d.sell) : null
  const cost = parseMoney(d.cost)
  if (Number.isNaN(sell) || Number.isNaN(cost)) return { ok: false, error: 'Enter prices as dollar amounts, like 125 or 125.50.' }
  const patch: Record<string, unknown> = {}
  if (description !== clean(p.description)) patch.description = description
  if (qty !== p.quantity) patch.quantity = d.quantity.trim()
  if (p.supply === 'shop' && sell !== p.sellPriceCents) patch.sellPriceCents = sell
  if (cost !== p.unitCostCents) patch.unitCostCents = cost
  if (clean(d.fitment) !== clean(p.fitment)) patch.fitment = clean(d.fitment)
  if (clean(d.partNumber) !== clean(p.partNumber)) patch.partNumber = clean(d.partNumber)
  if (clean(d.supplier) !== clean(p.supplier)) patch.supplier = clean(d.supplier)
  return { ok: true, edits: Object.keys(patch).length ? [{ action: 'update_part', partId: p.id, patch }] : [] }
}

/** A draft with an invalid value still counts as unsaved work. */
export const isDirty = (plan: Plan) => !plan.ok || plan.edits.length > 0
