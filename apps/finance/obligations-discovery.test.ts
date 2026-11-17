import { describe, it, expect } from 'vitest'
import { discoveryUpdate, pickRowToAdopt, visibleProposals } from './obligations-discovery'

describe('bill discovery — one row per bill, and the owner’s decision sticks', () => {
  const row = (status: string, vendor = 'Autoleap', amountCents: number | null = 29154, asOf = '2026-11-01') => ({ status, vendor, amountCents, frequency: 'monthly', asOf: new Date(asOf) })

  it('a re-run rewrites a proposal whole, but only refreshes the evidence on a bill the owner decided', () => {
    const full = { amountCents: 1, priority: 'planned', lastSeen: 'x' }, observed = { lastSeen: 'x' }
    expect(discoveryUpdate('proposed', full, observed)).toBe(full)
    for (const s of ['confirmed', 'paused', 'ignored']) expect(discoveryUpdate(s, full, observed)).toBe(observed)   // amount / priority untouched
  })

  it('adopts the copy that carries the owner’s decision, so an ignored bill is not proposed again', () => {
    expect(pickRowToAdopt([row('proposed'), row('ignored'), row('proposed')])?.status).toBe('ignored')
    expect(pickRowToAdopt([row('proposed'), row('confirmed'), row('ignored')])?.status).toBe('confirmed')
    expect(pickRowToAdopt([])).toBeUndefined()
  })

  it('95 duplicate copies of one proposal show as one, and the rest are counted as hidden', () => {
    const dupes = Array.from({ length: 95 }, (_, i) => row('proposed', 'Farmers N', 20684, `2026-08-${String((i % 28) + 1).padStart(2, '0')}`))
    const v = visibleProposals(dupes)
    expect(v.proposed).toHaveLength(1)
    expect(v.hidden).toBe(94)
  })

  it('a proposal for a vendor the owner already ignored or confirmed is not shown', () => {
    const v = visibleProposals([row('ignored', 'City Of College Ppd City Of College', 142230), row('proposed', 'city of college ppd city of college', 142230), row('proposed', 'Clover', 3242)])
    expect(v.proposed.map((p) => p.vendor)).toEqual(['Clover'])
    expect(v.hidden).toBe(1)
  })

  it('the same vendor at a genuinely different amount stays a separate proposal', () => {
    expect(visibleProposals([row('proposed', 'Autoleap', 15854), row('proposed', 'Autoleap', 42454)]).proposed).toHaveLength(2)
  })
})
