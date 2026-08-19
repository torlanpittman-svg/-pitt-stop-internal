import { describe, it, expect } from 'vitest'
import { money, isStale, freshnessLabel } from './sources'

describe('finance sources', () => {
  it('book balances are never trusted as cash', () => {
    const m = money(2595128, 'qbo', new Date(), 'book')
    expect(m.trusted).toBe(false)
    expect(m.confidence).toBe('book')
  })
  it('live + manual_verified are trusted', () => {
    expect(money(100, 'plaid', new Date(), 'live').trusted).toBe(true)
    expect(money(100, 'manual', new Date(), 'manual_verified').trusted).toBe(true)
    expect(money(100, 'manual', new Date(), 'estimated').trusted).toBe(false)
  })
  it('staleness by threshold', () => {
    expect(isStale(new Date())).toBe(false)
    expect(isStale(new Date(Date.now() - 48 * 3600_000))).toBe(true)
    expect(isStale(null)).toBe(true)
  })
  it('freshness labels', () => {
    expect(freshnessLabel(new Date())).toMatch(/s ago|min ago/)
    expect(freshnessLabel(null)).toBe('never')
    expect(freshnessLabel(new Date(Date.now() - 3 * 86400_000))).toBe('3 days ago')
  })
})
