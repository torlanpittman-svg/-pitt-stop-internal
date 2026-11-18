/**
 * Job-screen grouping of the estimate view (pure): which parts sit under which service, what a
 * non-manager may see, and the plain-language removal confirmations. No DB.
 */
import { describe, it, expect } from 'vitest'
import type { EstimatePartView, EstimateServiceView } from '@/apps/workflow/estimate-db'
import { groupJobItems, redactItemsView, removeServiceMessage, validatePartDraft, partAssignOptions, partsPostOutcome, placeOfAddedPart, removedAfterAddMessage, replayedAddMessage, resolvePartAssign, serviceAssignKey, textAssignKey, WHOLE_JOB, INVOICED_NEEDS_MANAGER_MSG, SERVICE_NEEDS_MANAGER_MSG, UNCONFIRMED_ADD_MSG } from './job-items-view'

const svc = (id: string, title = id, declined = false): EstimateServiceView => ({ id, title, priceCents: 1000, suggestedCents: null, declined } as unknown as EstimateServiceView)

describe('groupJobItems — declined services', () => {
  it('a charged part attached to a DECLINED service is listed under Parts (still billed, still removable), never hidden with the service', () => {
    const view = { services: [svc('s1', 'Tint', true), svc('s2', 'Oil change')], parts: [part('p1', { laborStatus: 'included', laborServiceId: 's1' }), part('p2', { laborStatus: 'included', laborServiceId: 's2' })] }
    const g = groupJobItems(view as unknown as Parameters<typeof groupJobItems>[0])
    expect(g.standalone.map((p) => p.id)).toEqual(['p1'])
    expect(g.services.find((s) => s.id === 's2')!.parts.map((p) => p.id)).toEqual(['p2'])
    expect(g.services.find((s) => s.id === 's1')!.parts).toEqual([])
  })
})
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
    expect(INVOICED_NEEDS_MANAGER_MSG).toBe('This job has a QuickBooks invoice. Ask a manager to remove this part.')
    expect(SERVICE_NEEDS_MANAGER_MSG).toMatch(/manager/i)
  })
})

describe('validatePartDraft (the add-part form; the server re-validates)', () => {
  const draft = (over: Partial<Parameters<typeof validatePartDraft>[0]>) => ({ name: ' Cabin air filter ', cost: '', price: '', partNumber: '', quantity: '1', ...over })
  it('a blank customer price is a problem on the price field — never a silent $0', () => {
    for (const price of ['', '   ']) {
      const r = validatePartDraft(draft({ price }), false)
      expect(r).toMatchObject({ ok: false, problem: { field: 'price' } })
      if (!r.ok) expect(r.problem.message).toMatch(/Enter the customer price/)
    }
  })
  it('a negative or non-numeric price is rejected on the price field', () => {
    for (const price of ['-1', 'abc', '1e999', '12,50']) {
      expect(validatePartDraft(draft({ price }), true)).toMatchObject({ ok: false, problem: { field: 'price' } })
    }
  })
  it('an explicit 0 is accepted (no-charge part); dollars become whole cents; quantity may be decimal but must be > 0', () => {
    expect(validatePartDraft(draft({ price: '0' }), false)).toMatchObject({ ok: true, input: { priceCents: 0, quantity: 1 } })
    expect(validatePartDraft(draft({ price: '12.5', quantity: '2' }), false)).toMatchObject({ ok: true, input: { name: 'Cabin air filter', priceCents: 1250, quantity: 2, costCents: null, partNumber: null } })
    expect(validatePartDraft(draft({ price: '59.999' }), false)).toMatchObject({ ok: true, input: { priceCents: 6000 } })
    expect(validatePartDraft(draft({ price: '5', quantity: '0' }), false)).toMatchObject({ ok: false, problem: { field: 'quantity' } })
    expect(validatePartDraft(draft({ price: '5', quantity: '' }), false)).toMatchObject({ ok: false, problem: { field: 'quantity' } })
    expect(validatePartDraft(draft({ price: '5', quantity: '1.5', partNumber: ' CF-1 ' }), false)).toMatchObject({ ok: true, input: { quantity: 1.5, partNumber: 'CF-1' } })
  })
  it('our cost is only read for a manager (an employee draft never carries one) and is checked before the price', () => {
    expect(validatePartDraft(draft({ cost: '4', price: '9' }), true)).toMatchObject({ ok: true, input: { costCents: 400, priceCents: 900 } })
    expect(validatePartDraft(draft({ cost: '4', price: '9' }), false)).toMatchObject({ ok: true, input: { costCents: null, priceCents: 900 } })
    expect(validatePartDraft(draft({ cost: 'x', price: '' }), true)).toMatchObject({ ok: false, problem: { field: 'cost' } })
    expect(validatePartDraft(draft({ cost: 'x', price: '' }), false)).toMatchObject({ ok: false, problem: { field: 'price' } })
  })
})

describe('serviceRemovalConsequence (swipe confirmation + editor Remove share it)', () => {
  it('names what goes with the line', async () => {
    const { serviceRemovalConsequence } = await import('./job-items-view')
    expect(serviceRemovalConsequence([])).toBe('Its charge will also be removed.')
    expect(serviceRemovalConsequence([{ description: 'Cabin filter' }])).toBe('Its attached part “Cabin filter” and its charges will also be removed.')
    expect(serviceRemovalConsequence([{ description: 'A' }, { description: 'B' }])).toBe('Its 2 attached parts (“A”, “B”) and their charges will also be removed.')
  })
})

describe('add-part "Assign to" (Whole job or one of the Job\'s services)', () => {
  const services = [
    { id: 'a1', title: 'Oil Change' },
    { id: 'b2', title: 'Replace Carpet' },
    { id: 'c3', title: 'Oil Change' },          // same name as a1 — a different service
    { id: 'd4', title: 'Declined Wax', declined: true },
  ]

  it('lists Whole job first, then each listed service in screen order; a declined service is not offered', () => {
    const o = partAssignOptions(services, [])
    expect(o.map((x) => x.key)).toEqual([WHOLE_JOB, 'svc:a1', 'svc:b2', 'svc:c3'])
    expect(o[0].label).toBe('Whole job')
    expect(o[2].label).toBe('Replace Carpet')
  })

  it('services that share a name get distinct values (their ids) and distinguishable labels', () => {
    const o = partAssignOptions(services, [])
    const oil = o.filter((x) => x.label.startsWith('Oil Change'))
    expect(oil.map((x) => x.label)).toEqual(['Oil Change (1 of 2)', 'Oil Change (2 of 2)'])
    expect(new Set(o.map((x) => x.key)).size).toBe(o.length)
  })

  it('the chosen value resolves to THAT service id — never to the first service with the same name', () => {
    expect(resolvePartAssign(serviceAssignKey('c3'), services, [])).toEqual({ kind: 'service', serviceId: 'c3', title: 'Oil Change' })
    expect(resolvePartAssign(serviceAssignKey('a1'), services, [])).toEqual({ kind: 'service', serviceId: 'a1', title: 'Oil Change' })
  })

  it('Whole job resolves to no service', () => {
    expect(resolvePartAssign(WHOLE_JOB, services, [])).toEqual({ kind: 'job' })
  })

  it('a service that left the Job (removed or declined while the form was open) resolves to null — never silently Whole job', () => {
    expect(resolvePartAssign(serviceAssignKey('gone'), services, [])).toBeNull()
    expect(resolvePartAssign(serviceAssignKey('d4'), services, [])).toBeNull()
    expect(resolvePartAssign('', services, [])).toBeNull()
    expect(resolvePartAssign('nonsense', services, [])).toBeNull()
  })

  it('text-only services are offered once per title (the server mirrors them by title) and resolve by title', () => {
    const o = partAssignOptions(services, ['Tint', ' tint ', 'Oil Change', 'Headlights'])
    expect(o.slice(4).map((x) => x.label)).toEqual(['Tint', 'Headlights'])   // "Oil Change" is already a listed service
    expect(resolvePartAssign(textAssignKey('Tint'), services, ['Tint', 'Headlights'])).toEqual({ kind: 'text', title: 'Tint' })
    expect(resolvePartAssign(textAssignKey('Tint'), services, ['Headlights'])).toBeNull()
  })
})

describe('partsPostOutcome — saved, definitely not saved, or not known', () => {
  it('a confirmed save is ok and carries the part id; a first save is not a replay', () => {
    expect(partsPostOutcome(200, { ok: true, partId: 'p1' })).toEqual({ ok: true, partId: 'p1', replayed: false, differs: false, removed: false, savedName: null })
  })
  it('a repeat that found the part already saved says so — with the name the SERVER saved, and whether the form had changed or the part was since removed', () => {
    expect(partsPostOutcome(200, { ok: true, partId: 'p1', replayed: true, differs: true, savedName: 'Brake pads' })).toEqual({ ok: true, partId: 'p1', replayed: true, differs: true, removed: false, savedName: 'Brake pads' })
    expect(partsPostOutcome(200, { ok: true, partId: 'p1', replayed: true, removed: true })).toMatchObject({ replayed: true, removed: true })
  })
  it('"not saved" needs the server to say so: an add it marked notSaved, or a 401 / 403 / 404 / 409 (decided before any write)', () => {
    expect(partsPostOutcome(400, { ok: false, error: 'That service is no longer on this job.', notSaved: true })).toEqual({ ok: false, error: 'That service is no longer on this job.', needsManager: undefined, saved: 'no' })
    expect(partsPostOutcome(403, { ok: false, error: 'Ask a manager.', needsManager: true })).toMatchObject({ ok: false, needsManager: true, saved: 'no' })
    expect(partsPostOutcome(409, { ok: false, error: 'This job was removed.' })).toMatchObject({ saved: 'no' })
  })
  it('an UNMARKED 400 is not proof that nothing was written (a removal can fail after its write) — unknown, with the server’s explanation kept', () => {
    expect(partsPostOutcome(400, { ok: false, error: 'That part is no longer on this estimate.' })).toEqual({ ok: false, error: 'That part is no longer on this estimate.', needsManager: undefined, saved: 'unknown' })
  })
  it('no response, a 5xx, or an answer that does not say: the part MAY have been saved', () => {
    for (const [status, body] of [[null, null], [500, { ok: false, error: 'We couldn’t confirm this part was saved.' }], [502, null], [200, null], [400, null], [200, { ok: false }]] as const) {
      expect(partsPostOutcome(status, body)).toMatchObject({ ok: false, saved: 'unknown' })
    }
    expect((partsPostOutcome(502, null) as { error: string }).error).toMatch(/Could not save/)
  })
})

describe('what the user is told after a retry found the part already saved', () => {
  it('unchanged form: a plain confirmation of where it is', () => {
    expect(replayedAddMessage('Brake pads', { kind: 'job' }, false)).toBe('Brake pads saved on this job.')
    expect(replayedAddMessage('Brake pads', { kind: 'service', title: 'Brake job' }, false)).toBe('Brake pads saved under Brake job.')
  })
  it('changed form: says the first try was kept, that the changes were NOT applied, and how to change the part — never "cancel and start over"', () => {
    const msg = replayedAddMessage('Brake pads', { kind: 'service', title: 'Brake job' }, true)
    expect(msg).toContain('already saved under Brake job')
    expect(msg).toContain('were not applied')
    expect(msg).toContain('tap the part to edit it')
    expect(msg + UNCONFIRMED_ADD_MSG + removedAfterAddMessage('x')).not.toMatch(/cancel|start over/i)
    expect(UNCONFIRMED_ADD_MSG).toContain('will not be added twice')
  })
  it('someone who cannot open parts is not told to tap one', () => {
    const msg = replayedAddMessage('Brake pads', { kind: 'job' }, true, false)
    expect(msg).toContain('ask a manager to change it')
    expect(msg).not.toContain('tap the part')
  })
  it('when the list could not be read back it says so instead of claiming a position', () => {
    expect(replayedAddMessage('Brake pads', 'unread', false)).toBe('Brake pads saved on this job. The list could not be refreshed — check it before adding anything else.')
    expect(replayedAddMessage('Brake pads', 'unread', true)).toMatch(/already saved on this job by your first try.*not applied.*could not be refreshed/)
  })
})

describe('placeOfAddedPart — after a retry, report where the part REALLY is', () => {
  const s = (id: string, title: string, declined = false) => ({ id, title, declined }) as EstimateServiceView
  const p = (id: string, laborServiceId: string | null) => ({ id, description: id, laborServiceId, laborStatus: laborServiceId ? 'included' : 'none' }) as unknown as EstimatePartView
  const v = { services: [s('a', 'Oil Change'), s('b', 'Oil Change'), s('c', 'Wax', true)], parts: [p('p1', 'b'), p('p2', null), p('p3', 'c')] }

  it('a part under a service is reported under THAT service (by id — same-named services stay distinct)', () => {
    expect(placeOfAddedPart(v, 'p1')).toEqual({ kind: 'service', serviceId: 'b', title: 'Oil Change' })
  })
  it('a whole-job part — and one whose service was declined — is reported on the job', () => {
    expect(placeOfAddedPart(v, 'p2')).toEqual({ kind: 'job' })
    expect(placeOfAddedPart(v, 'p3')).toEqual({ kind: 'job' })
  })
  it('a part that is not live on the Job (replayed but cancelled) is null — it must not be announced as added', () => {
    expect(placeOfAddedPart(v, 'cancelled-id')).toBeNull()
    expect(placeOfAddedPart(v, null)).toBeNull()
  })
})
