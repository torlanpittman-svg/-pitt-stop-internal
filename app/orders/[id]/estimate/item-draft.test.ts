/**
 * Estimate item editor: Save sends only what changed, Retry after a partial failure sends only what
 * is still different, and invalid input is caught before anything is sent.
 */
import { describe, it, expect } from 'vitest'
import { parseMoney, planServiceSave, serviceDraftFrom, planPartSave, partDraftFrom, isDirty, rebaseDraft } from './item-draft'
import { interpretSave, type PartView, type ServiceView, type EstimateViewData } from './save-feedback'

const svc = (o: Partial<ServiceView> = {}): ServiceView => ({
  id: 's1', title: 'Seat Shampoo', priceCents: 4500, suggestedCents: null, catalogId: 'c1', catalogName: 'Seat Shampoo',
  description: 'Shampoo cleaning of the specified vehicle seats.', detail: 'passenger seat', matchState: 'matched', ...o,
})
const part = (o: Partial<PartView> = {}): PartView => ({
  id: 'p1', serviceId: null, description: 'Mirror assembly', fitment: '2020 Toyota Camry', partNumber: null, supplier: null,
  quantity: 1, unitCostCents: 9000, sellPriceCents: 12500, lineCents: 12500, supply: 'shop', laborStatus: 'needs_review',
  laborServiceId: null, laborNote: null, invoiceText: 'Mirror assembly', ...o,
})

describe('parseMoney', () => {
  it('reads dollars, keeps blank as untouched, and rejects junk', () => {
    expect(parseMoney('125')).toBe(12500)
    expect(parseMoney('$1,250.5')).toBe(125050)
    expect(parseMoney('0')).toBe(0)
    expect(parseMoney('  ')).toBeNull()
    expect(parseMoney('12a')).toBeNaN()
    expect(parseMoney('.')).toBeNaN()
  })
})

describe('planServiceSave', () => {
  it('an untouched draft sends nothing and is not dirty', () => {
    const s = svc()
    const plan = planServiceSave(s, serviceDraftFrom(s), false)
    expect(plan).toEqual({ ok: true, edits: [] })
    expect(isDirty(plan)).toBe(false)
  })

  it('sends rename, price, then area — in that order, only for changed fields', () => {
    const s = svc()
    const plan = planServiceSave(s, { title: '  Shampoo  seats ', price: '55', detail: 'both front seats' }, false)
    expect(plan).toEqual({ ok: true, edits: [
      { action: 'rename_service', serviceId: 's1', title: 'Shampoo seats' },
      { action: 'set_service_price', serviceId: 's1', cents: 5500 },
      { action: 'set_detail', serviceId: 's1', detail: 'both front seats' },
    ] })
  })

  it('retry after the rename saved sends only the remaining edits', () => {
    const draft = { title: 'Shampoo seats', price: '55', detail: 'passenger seat' }
    const afterRename = svc({ title: 'Shampoo seats' })
    expect(planServiceSave(afterRename, draft, false)).toEqual({ ok: true, edits: [{ action: 'set_service_price', serviceId: 's1', cents: 5500 }] })
  })

  it('rename never sends catalog, description, or QuickBooks fields — identity stays on the server', () => {
    const plan = planServiceSave(svc(), { ...serviceDraftFrom(svc()), title: 'Back seat shampoo' }, false)
    expect(plan.ok && plan.edits).toEqual([{ action: 'rename_service', serviceId: 's1', title: 'Back seat shampoo' }])
  })

  it('an unpriced line left blank stays unpriced (never $0); typing 0 is an explicit $0', () => {
    const s = svc({ priceCents: null })
    expect(planServiceSave(s, serviceDraftFrom(s), false)).toEqual({ ok: true, edits: [] })
    expect(planServiceSave(s, { ...serviceDraftFrom(s), price: '0' }, false)).toEqual({ ok: true, edits: [{ action: 'set_service_price', serviceId: 's1', cents: 0 }] })
  })

  it('a flat estimate never sends a line price', () => {
    const s = svc({ priceCents: null })
    expect(planServiceSave(s, { ...serviceDraftFrom(s), price: '99' }, true)).toEqual({ ok: true, edits: [] })
  })

  it('clearing the area sends an empty detail', () => {
    expect(planServiceSave(svc(), { ...serviceDraftFrom(svc()), detail: '  ' }, false)).toEqual({ ok: true, edits: [{ action: 'set_detail', serviceId: 's1', detail: '' }] })
  })

  it('invalid input is reported before anything is sent and still counts as unsaved', () => {
    expect(planServiceSave(svc(), { ...serviceDraftFrom(svc()), title: '   ' }, false)).toEqual({ ok: false, error: 'Enter a name for this item.' })
    const bad = planServiceSave(svc(), { ...serviceDraftFrom(svc()), price: '4x' }, false)
    expect(bad.ok).toBe(false)
    expect(isDirty(bad)).toBe(true)
    expect(planServiceSave(svc(), { ...serviceDraftFrom(svc()), price: '' }, false).ok).toBe(false)
  })
})

describe('planPartSave', () => {
  it('untouched → nothing; changes → one update_part with only the changed fields', () => {
    const p = part()
    expect(planPartSave(p, partDraftFrom(p))).toEqual({ ok: true, edits: [] })
    expect(planPartSave(p, { ...partDraftFrom(p), sell: '130', quantity: '2', partNumber: ' MR-1 ' })).toEqual({ ok: true, edits: [
      { action: 'update_part', partId: 'p1', patch: { quantity: '2', sellPriceCents: 13000, partNumber: 'MR-1' } },
    ] })
  })

  it('customer-supplied parts never send a sell price', () => {
    const p = part({ supply: 'customer', sellPriceCents: null, lineCents: null })
    expect(planPartSave(p, { ...partDraftFrom(p), sell: '50' })).toEqual({ ok: true, edits: [] })
  })

  it('rejects a missing name or a non-positive quantity', () => {
    expect(planPartSave(part(), { ...partDraftFrom(part()), description: ' ' }).ok).toBe(false)
    expect(planPartSave(part(), { ...partDraftFrom(part()), quantity: '0' }).ok).toBe(false)
    expect(planPartSave(part(), { ...partDraftFrom(part()), quantity: 'two' }).ok).toBe(false)
  })
})

describe('update_part is "Saved" only when the server view reflects it', () => {
  const view = (parts: PartView[]): EstimateViewData => ({ exists: true, flat: false, workTotalCents: 0, services: [], incomplete: false, referenceCents: null, parts })
  const edit = { action: 'update_part', partId: 'p1', patch: { description: 'Mirror glass', sellPriceCents: 4000 } }
  it('confirmed', () => {
    const v = view([part({ description: 'Mirror glass', sellPriceCents: 4000 })])
    expect(interpretSave(edit, { ok: true, status: 200 }, { ok: true, view: v })).toEqual({ ok: true, view: v })
  })
  it('not confirmed when the part is missing or unchanged', () => {
    expect(interpretSave(edit, { ok: true, status: 200 }, { ok: true, view: view([]) }).ok).toBe(false)
    expect(interpretSave(edit, { ok: true, status: 200 }, { ok: true, view: view([part()]) }).ok).toBe(false)
  })
})

describe('rebaseDraft — server changes while an editor is open', () => {
  const odor = svc({ title: 'odor', priceCents: null, catalogId: null, catalogName: null, detail: null, matchState: 'choose' })
  const ozone = svc({ title: 'Ozone Treatment', priceCents: null, catalogId: 'c-oz', catalogName: 'Ozone Treatment', detail: 'cabin', matchState: 'matched' })

  it('choosing a service updates an untouched name and area — no false unsaved changes', () => {
    const draft = rebaseDraft(serviceDraftFrom(odor), serviceDraftFrom(odor), serviceDraftFrom(ozone))
    expect(draft).toEqual(serviceDraftFrom(ozone))
    expect(isDirty(planServiceSave(ozone, draft, false))).toBe(false)
  })

  it('a deliberately edited name, price, or area stays as typed', () => {
    const typed = { title: 'Smoke smell — cabin', price: '120', detail: 'rear seats' }
    const draft = rebaseDraft(typed, serviceDraftFrom(odor), serviceDraftFrom(ozone))
    expect(draft).toEqual(typed)
    // Save then sends exactly those deliberate edits — never the old "odor" label.
    expect(planServiceSave(ozone, draft, false)).toEqual({ ok: true, edits: [
      { action: 'rename_service', serviceId: 's1', title: 'Smoke smell — cabin' },
      { action: 'set_service_price', serviceId: 's1', cents: 12000 },
      { action: 'set_detail', serviceId: 's1', detail: 'rear seats' },
    ] })
  })

  it('only the edited field is kept; untouched ones follow the server', () => {
    const draft = rebaseDraft({ ...serviceDraftFrom(odor), price: '90' }, serviceDraftFrom(odor), serviceDraftFrom(ozone))
    expect(draft).toEqual({ title: 'Ozone Treatment', price: '90', detail: 'cabin' })
    expect(planServiceSave(ozone, draft, false)).toEqual({ ok: true, edits: [{ action: 'set_service_price', serviceId: 's1', cents: 9000 }] })
  })

  it('partial save: the saved rename is no longer pending; the unsaved price still is', () => {
    const s0 = svc()
    const typed = { ...serviceDraftFrom(s0), title: 'Front seats', price: '60' }
    const s1 = svc({ title: 'Front seats' }) // rename landed, price failed
    const draft = rebaseDraft(typed, serviceDraftFrom(s0), serviceDraftFrom(s1))
    expect(draft).toEqual(typed)
    expect(planServiceSave(s1, draft, false)).toEqual({ ok: true, edits: [{ action: 'set_service_price', serviceId: 's1', cents: 6000 }] })
  })

  it('part editor: a server-side change follows untouched fields and keeps edited ones', () => {
    const p0 = part(), p1 = part({ quantity: 2, lineCents: 25000, partNumber: 'MR-1' })
    const draft = rebaseDraft({ ...partDraftFrom(p0), sell: '130' }, partDraftFrom(p0), partDraftFrom(p1))
    expect(draft).toEqual({ ...partDraftFrom(p1), sell: '130' })
    expect(planPartSave(p1, draft)).toEqual({ ok: true, edits: [{ action: 'update_part', partId: 'p1', patch: { sellPriceCents: 13000 } }] })
  })
})
