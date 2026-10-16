import { describe, it, expect } from 'vitest'
import { jobTotalCents, fmt, tierLabel, serviceLabels, type JobLine } from './job-lines'

const line = (p: number, over: Partial<JobLine> = {}): JobLine => ({ key: 'k', catalogId: null, kind: 'package', name: 'x', priceCents: p, ...over })
const svc = (name: string, kind: JobLine['kind'] = 'package'): JobLine => ({ key: `k${name}`, catalogId: kind === 'custom' ? null : 'cat', kind, name, priceCents: 0 })

describe('quick entry line math', () => {
  it('sums line prices', () => {
    expect(jobTotalCents([line(35000), line(30000), line(7500)])).toBe(72500)
  })
  it('empty list totals 0; bad values ignored', () => {
    expect(jobTotalCents([])).toBe(0)
    expect(jobTotalCents([line(NaN)])).toBe(0)
  })
  it('formats cents to dollars', () => {
    expect(fmt(35000)).toBe('$350.00')
    expect(fmt(0)).toBe('$0.00')
  })
  it('builds a readable size/condition label', () => {
    expect(tierLabel('large_3row_suv', '')).toBe('large 3row suv')
    expect(tierLabel('sedan', 'heavy')).toBe('sedan · heavy')
    expect(tierLabel('', '')).toBe('')
  })
})

describe('serviceLabels (Work Board card services)', () => {
  it('one selected service', () => {
    expect(serviceLabels([svc('Interior Detail')])).toEqual(['Interior Detail'])
  })
  it('multiple selected services, in order', () => {
    expect(serviceLabels([svc('Interior Detail'), svc('Exterior Wash'), svc('Wax')]))
      .toEqual(['Interior Detail', 'Exterior Wash', 'Wax'])
  })
  it('includes the custom "Other" text and trims it', () => {
    expect(serviceLabels([svc('Polish'), svc('  Pet hair removal  ', 'custom')]))
      .toEqual(['Polish', 'Pet hair removal'])
  })
  it('drops blank / whitespace-only custom lines', () => {
    expect(serviceLabels([svc('Wax'), svc('   ', 'custom'), svc('', 'custom')]))
      .toEqual(['Wax'])
  })
  it('legacy / no services → empty list (card shows the "No services listed." fallback)', () => {
    expect(serviceLabels([])).toEqual([])
  })
})

import { linesFromEntries, chooseCandidate, keepAsTyped, choosePart, chooseTires, reopenChoice, type InterpEntry } from './job-lines'

describe('rushed-entry interpretation → reviewable Quick Entry lines', () => {
  let n = 0
  const k = () => `t${n++}`
  const e = (over: Partial<InterpEntry>): InterpEntry => ({ entry: 'x', corrected: 'x', status: 'none', intent: 'unknown', area: null, part: null, question: null, source: 'none', candidates: [], ...over })
  const shampoo = { catalogId: 'c-shampoo', name: 'Seat Shampoo' }
  const detail = { catalogId: 'c-detail', name: 'Interior Detail' }

  it('a clear match is added directly with identity, area, and the typed words (no price)', () => {
    const [l] = linesFromEntries([e({ entry: 'shamp pass seat', status: 'resolved', intent: 'service', area: 'passenger seat', source: 'alias', candidates: [shampoo] })], [], k)
    expect(l).toMatchObject({ catalogId: 'c-shampoo', name: 'Seat Shampoo', detail: 'passenger seat', entryText: 'shamp pass seat', matchMethod: 'alias', priceCents: 0 })
    expect(l.pending).toBeFalsy()
  })
  it('several options → added as typed with the real options to pick from; picking keeps area + wording', () => {
    const [l] = linesFromEntries([e({ entry: 'coffee stain pass seat', status: 'choose', intent: 'service', area: 'passenger seat', candidates: [detail, shampoo] })], [], k)
    expect(l).toMatchObject({ catalogId: null, name: 'coffee stain pass seat', pending: { candidates: [detail, shampoo] } })
    expect(chooseCandidate(l, shampoo)).toMatchObject({ catalogId: 'c-shampoo', name: 'Seat Shampoo', detail: 'passenger seat', entryText: 'coffee stain pass seat', pending: null, matchMethod: 'suggestion' })
  })
  it('a part asks who supplies it; "keep as typed" never marks a confirmed one-off (the manager still reviews)', () => {
    const [l] = linesFromEntries([e({ entry: 'dr side mirror assy', status: 'choose', intent: 'part', part: { description: 'Driver-side mirror assembly' }, candidates: [{ catalogId: 'c-install', name: 'Installation Labor' }] })], [], k)
    expect(l.pending).toMatchObject({ intent: 'part', candidates: [] })   // installation is never auto-offered as the match
    expect(choosePart(l, 'shop')).toMatchObject({ name: 'Driver-side mirror assembly', partSupply: 'shop', pending: null, catalogId: null })
    expect(keepAsTyped(l)).toMatchObject({ name: 'dr side mirror assy', matchMethod: null, pending: null, partSupply: null })
  })
  it('tires need a mode AND a sane quantity', () => {
    const [l] = linesFromEntries([e({ entry: 'replace tires', status: 'choose', intent: 'tires' })], [], k)
    expect(chooseTires(l, 'both', 0)).toBeNull()
    expect(chooseTires(l, 'both', 13)).toBeNull()
    expect(chooseTires(l, 'install_customer', 4)).toMatchObject({ tires: { mode: 'install_customer', quantity: 4 }, pending: null })
  })
  it('unrecognized text is kept as typed; nothing is dropped; duplicates of selected lines are skipped', () => {
    const existing = [{ key: 'a', catalogId: 'c-detail', kind: 'package' as const, name: 'Interior Detail', priceCents: 17500 }]
    const out = linesFromEntries([e({ entry: 'xyzzy' }), e({ entry: 'interior detail', status: 'resolved', intent: 'service', source: 'exact', candidates: [detail] })], existing, k)
    expect(out.map((l) => l.name)).toEqual(['xyzzy'])
  })
  it('a wrong match can be corrected from the same real options', () => {
    const [l] = linesFromEntries([e({ entry: 'condtnr', status: 'resolved', intent: 'service', source: 'ai', candidates: [shampoo, detail] })], [], k)
    expect(reopenChoice(l).pending?.candidates).toEqual([shampoo, detail])
  })
})
