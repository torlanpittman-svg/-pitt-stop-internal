import { describe, it, expect } from 'vitest'
import { checkNewAllocation, effectiveAmountCents, summarizeAllocations } from './allocations'

describe('summarizeAllocations — a purchase reconciles to its own total', () => {
  it('no allocations → unallocated, the whole total is the visible remainder', () => {
    expect(summarizeAllocations(8021, [])).toMatchObject({ state: 'unallocated', allocatedCents: 0, unallocatedCents: 8021, overCents: 0 })
  })
  it('a whole-purchase allocation is worth exactly the receipt total (Tesla: $80.21)', () => {
    const s = summarizeAllocations(8021, [{ amountCents: null }])
    expect(s).toMatchObject({ state: 'full', allocatedCents: 8021, unallocatedCents: 0, whole: true })
  })
  it('a whole-purchase allocation FOLLOWS a corrected total (never a stale copy)', () => {
    expect(effectiveAmountCents({ amountCents: null }, 8021)).toBe(8021)
    expect(effectiveAmountCents({ amountCents: null }, 9000)).toBe(9000)
    expect(effectiveAmountCents({ amountCents: null }, null)).toBeNull() // unknown total is never $0
  })
  it('a split leaves the remainder visible', () => {
    expect(summarizeAllocations(10000, [{ amountCents: 4000 }, { amountCents: 2500 }])).toMatchObject({ state: 'partial', allocatedCents: 6500, unallocatedCents: 3500 })
  })
  it('a split that adds up is full', () => {
    expect(summarizeAllocations(10000, [{ amountCents: 4000 }, { amountCents: 6000 }]).state).toBe('full')
  })
  it('allocations beyond the total are reported as a discrepancy, not silently clamped', () => {
    expect(summarizeAllocations(10000, [{ amountCents: 7000 }, { amountCents: 4000 }])).toMatchObject({ state: 'over', overCents: 1000, unallocatedCents: 0 })
  })
  it('removed allocations never count', () => {
    expect(summarizeAllocations(10000, [{ amountCents: 7000, status: 'removed' }, { amountCents: 4000, status: 'active' }])).toMatchObject({ state: 'partial', allocatedCents: 4000 })
  })
  it('allocated with an unknown total is its own state', () => {
    expect(summarizeAllocations(null, [{ amountCents: null }])).toMatchObject({ state: 'unknown_total', allocatedCents: null, unallocatedCents: null })
  })
})

describe('checkNewAllocation — splits can never exceed the purchase total', () => {
  it('whole purchase is allowed only when nothing else is assigned', () => {
    expect(checkNewAllocation(8021, [], null).ok).toBe(true)
    expect(checkNewAllocation(8021, [{ amountCents: 1000 }], null).ok).toBe(false)
    expect(checkNewAllocation(8021, [{ amountCents: null }], null).ok).toBe(false)
  })
  it('a split amount up to the remainder is allowed; one cent more is refused', () => {
    expect(checkNewAllocation(10000, [{ amountCents: 4000 }], 6000).ok).toBe(true)
    const over = checkNewAllocation(10000, [{ amountCents: 4000 }], 6001)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain('$60.00 unassigned of $100.00')
  })
  it('a split cannot be added next to a whole-purchase allocation', () => {
    expect(checkNewAllocation(10000, [{ amountCents: null }], 1000).ok).toBe(false)
  })
  it('a split needs a known total and a positive whole-cent amount', () => {
    expect(checkNewAllocation(null, [], 1000).ok).toBe(false)
    expect(checkNewAllocation(10000, [], 0).ok).toBe(false)
    expect(checkNewAllocation(10000, [], -5).ok).toBe(false)
    expect(checkNewAllocation(10000, [], 10.5).ok).toBe(false)
  })
  it('a removed allocation frees its amount', () => {
    expect(checkNewAllocation(10000, [{ amountCents: 9000, status: 'removed' }], 10000).ok).toBe(true)
  })
})
