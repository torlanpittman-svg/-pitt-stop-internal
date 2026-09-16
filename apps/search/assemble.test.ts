import { describe, it, expect } from 'vitest'
import { parseQuery } from './normalize'
import { assembleResults, type RawCandidate } from './assemble'
import { scopeForRole } from './authz'
import type { SearchCategory } from './types'

const p = (s: string) => parseQuery(s).parsed!

function cand(over: Partial<RawCandidate> & { category: SearchCategory; id: string }): RawCandidate {
  return {
    href: `/x/${over.id}`,
    title: over.id,
    subtitle: '',
    matchFields: { text: [over.title ?? over.id] },
    ...over,
  }
}

describe('assembleResults — scope enforcement', () => {
  it('anonymous scope yields no groups even when candidates exist', () => {
    const scope = scopeForRole(null, false)
    const out = assembleResults(p('honey'), scope, [cand({ category: 'customers', id: 'c1', title: 'Honey' })])
    expect(out.total).toBe(0)
    expect(out.groups).toHaveLength(0)
  })

  it('ordinary employees never receive manager-only check results', () => {
    const scope = scopeForRole('employee', true)
    const out = assembleResults(p('acme'), scope, [
      cand({ category: 'jobs', id: 'j1', title: 'ACME job' }),
      cand({ category: 'checks', id: 'k1', title: 'ACME', matchFields: { text: ['ACME'] } }),
    ])
    expect(out.groups.map((g) => g.category)).toEqual(['jobs'])
  })

  it('managers additionally receive checks + receipts', () => {
    const scope = scopeForRole('manager', true)
    const out = assembleResults(p('acme'), scope, [
      cand({ category: 'checks', id: 'k1', title: 'ACME', matchFields: { text: ['ACME'] } }),
      cand({ category: 'receipts', id: 'r1', title: 'ACME', matchFields: { text: ['ACME'] } }),
    ])
    expect(out.groups.map((g) => g.category).sort()).toEqual(['checks', 'receipts'])
  })
})

describe('assembleResults — ranking + service search', () => {
  const scope = scopeForRole('employee', true)

  it('exact matches rank before partial within a category', () => {
    const out = assembleResults(p('honda'), scope, [
      cand({ category: 'vehicles', id: 'v-partial', title: 'x', matchFields: { text: ['Used Honda Accord'] } }),
      cand({ category: 'vehicles', id: 'v-exact', title: 'x', matchFields: { text: ['Honda'] } }),
    ])
    const ids = out.groups[0].results.map((r) => r.id)
    expect(ids[0]).toBe('v-exact')
  })

  it('a service word returns the associated JOB (with vehicle context preserved)', () => {
    const out = assembleResults(p('ceramic'), scope, [
      cand({
        category: 'jobs', id: 'job-1', href: '/orders/job-1',
        title: 'SO-1042 · Honey', subtitle: '2020 Tesla · ····1234', meta: 'Ceramic coating',
        matchFields: { ids: ['SO-1042'], text: ['Honey', '2020 Tesla', 'Full ceramic coating package'] },
      }),
    ])
    expect(out.groups[0].category).toBe('jobs')
    expect(out.groups[0].results[0].href).toBe('/orders/job-1')
    expect(out.groups[0].results[0].subtitle).toContain('1234')
  })

  it('drops candidates that did not actually match (defensive)', () => {
    const out = assembleResults(p('zzzzz'), scope, [cand({ category: 'jobs', id: 'j', title: 'unrelated' })])
    expect(out.total).toBe(0)
  })

  it('de-dupes by id, keeping the strongest tier', () => {
    const out = assembleResults(p('honey'), scope, [
      cand({ category: 'customers', id: 'dup', title: 'x', matchFields: { text: ['Honeycomb'] } }),  // partial
      cand({ category: 'customers', id: 'dup', title: 'x', matchFields: { text: ['Honey'] } }),       // exact
    ])
    expect(out.groups[0].results).toHaveLength(1)
    expect(out.groups[0].results[0].tier).toBe(0)
  })
})

describe('assembleResults — limits', () => {
  const scope = scopeForRole('employee', true)
  it('enforces the per-category cap', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      cand({ category: 'jobs', id: `j${i}`, title: 'x', matchFields: { text: ['match'] }, sortKey: String(i) }))
    const out = assembleResults(p('match'), scope, many, { perCategory: 5, overall: 100 })
    expect(out.groups[0].results).toHaveLength(5)
    expect(out.truncated).toBe(true)
  })

  it('enforces the overall cap across categories', () => {
    const jobs = Array.from({ length: 6 }, (_, i) => cand({ category: 'jobs', id: `j${i}`, title: 'x', matchFields: { text: ['match'] } }))
    const veh = Array.from({ length: 6 }, (_, i) => cand({ category: 'vehicles', id: `v${i}`, title: 'x', matchFields: { text: ['match'] } }))
    const out = assembleResults(p('match'), scope, [...jobs, ...veh], { perCategory: 8, overall: 7 })
    expect(out.total).toBe(7)
    expect(out.truncated).toBe(true)
  })
})

describe('assembleResults — result shape carries no secrets', () => {
  it('only whitelisted display fields appear on a result', () => {
    const scope = scopeForRole('manager', true)
    const out = assembleResults(p('acme'), scope, [
      cand({ category: 'checks', id: 'k1', href: '/checks/k1', title: '#1005 · ACME', subtitle: '2026-01-01 · $50.00', matchFields: { text: ['ACME'] } }),
    ])
    const allowed = new Set(['category', 'id', 'href', 'title', 'subtitle', 'meta', 'badge', 'phone', 'tier', 'sortKey'])
    for (const r of out.groups[0].results) {
      for (const k of Object.keys(r)) expect(allowed.has(k)).toBe(true)
    }
  })
})
