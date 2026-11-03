/**
 * Job-screen grouping of the estimate view (pure): which parts sit under which service, what a
 * non-manager may see, and the plain-language removal confirmations. No DB.
 */
import { describe, it, expect } from 'vitest'
import type { EstimatePartView, EstimateServiceView } from '@/apps/workflow/estimate-db'
import { groupJobItems, redactItemsView, removeServiceMessage, NEEDS_MANAGER_MSG, SERVICE_NEEDS_MANAGER_MSG } from './job-items-view'

const svc = (id: string, title = id): EstimateServiceView => ({ id, title, priceCents: 1000, suggestedCents: null, declined: false } as unknown as EstimateServiceView)
const part = (id: string, o: Partial<EstimatePartView> = {}): EstimatePartView => ({
  id, serviceId: `row-${id}`, description: id, fitment: null, partNumber: null, supplier: null, quantity: 1,
  unitCostCents: 400, sellPriceCents: 1200, lineCents: 1200, supply: 'shop', laborStatus: 'needs_review', laborServiceId: null, laborNote: null, invoiceText: id,
  ...o,
} as unknown as EstimatePartView)

describe('groupJobItems', () => {
  it('a part whose installation is included in (or added as) a listed service sits under that service; everything else is standalone', () => {
    const view = {
      services: [svc('oil'), svc('brakes')],
      parts: [
        part('filter', { laborStatus: 'included', laborServiceId: 'oil' }),
        part('pads', { laborStatus: 'labor_added', laborServiceId: 'brakes' }),
        part('wipers'),                                                        // never reviewed → standalone
        part('bulb', { laborStatus: 'needs_review', laborServiceId: 'oil' }),  // points at a service but not decided → standalone
        part('orphan', { laborStatus: 'included', laborServiceId: 'gone' }),   // its service left the estimate → standalone
      ],
    }
    const g = groupJobItems(view)
    expect(g.services.map((s) => [s.id, s.parts.map((p) => p.id)])).toEqual([['oil', ['filter']], ['brakes', ['pads']]])
    expect(g.standalone.map((p) => p.id)).toEqual(['wipers', 'bulb', 'orphan'])
  })
  it('keeps service order and copies every service field; a view without parts groups to empty lists', () => {
    const g = groupJobItems({ services: [svc('b', 'Brakes'), svc('a', 'Alignment')], parts: undefined })
    expect(g.services.map((s) => s.title)).toEqual(['Brakes', 'Alignment'])
    expect(g.services.every((s) => s.parts.length === 0 && s.priceCents === 1000)).toBe(true)
    expect(g.standalone).toEqual([])
  })
})

describe('redactItemsView', () => {
  const view = { parts: [part('x', { unitCostCents: 400, sellPriceCents: 1200, lineCents: 2400, quantity: 2 })], workTotalCents: 3400 }
  it('a manager sees everything (same object back)', () => {
    expect(redactItemsView(view, true)).toBe(view)
  })
  it('a non-manager never receives OUR COST but keeps the customer amount, quantity and total', () => {
    const r = redactItemsView(view, false)
    expect(r.parts[0].unitCostCents).toBeNull()
    expect(r.parts[0].sellPriceCents).toBe(1200)
    expect(r.parts[0].lineCents).toBe(2400)
    expect(r.parts[0].quantity).toBe(2)
    expect(r.workTotalCents).toBe(3400)
    expect(view.parts[0].unitCostCents).toBe(400)   // input untouched
  })
})

describe('removeServiceMessage', () => {
  it('names the service, every attached part, and that the prices leave the total', () => {
    expect(removeServiceMessage('Oil change', [])).toBe('Remove “Oil change” from this job? Its price will be removed from the job total.')
    expect(removeServiceMessage('Oil change', [{ description: 'Oil filter' }]))
      .toBe('Remove “Oil change” and its attached part “Oil filter”? Both prices will be removed from the job total.')
    expect(removeServiceMessage('Brakes', [{ description: 'Pads' }, { description: 'Rotors' }]))
      .toBe('Remove “Brakes” and its 2 attached parts (“Pads”, “Rotors”)? All of their prices will be removed from the job total.')
  })
  it('the needs-a-manager messages say what to do, in plain words', () => {
    expect(NEEDS_MANAGER_MSG).toMatch(/manager/i)
    expect(NEEDS_MANAGER_MSG).toMatch(/invoice/i)
    expect(SERVICE_NEEDS_MANAGER_MSG).toMatch(/manager/i)
  })
})
