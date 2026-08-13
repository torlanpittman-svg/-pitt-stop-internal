import { describe, it, expect } from 'vitest'
import { allocateProportional } from './allocate'

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0)

describe('allocateProportional', () => {
  it('scales $650 down to $600 exactly, weighted by current prices', () => {
    // 300/150/100/100 = 650 → 600
    const out = allocateProportional(60000, [30000, 15000, 10000, 10000])
    expect(sum(out)).toBe(60000)
    expect(out).toEqual([27692, 13846, 9231, 9231])
  })

  it('always sums exactly to the total (penny-drift cases)', () => {
    for (const [t, w] of [
      [10000, [1, 1, 1]],        // 100.00 / 3
      [10001, [1, 1, 1]],
      [55555, [3, 5, 7, 11]],
      [1, [1, 1, 1, 1]],         // 1 cent across 4
      [0, [5, 5]],
    ] as [number, number[]][]) {
      const out = allocateProportional(t, w)
      expect(sum(out)).toBe(t)
      expect(out.every((x) => x >= 0)).toBe(true)
    }
  })

  it('even-splits when there are no usable weights', () => {
    expect(allocateProportional(1000, [0, 0, 0])).toEqual([334, 333, 333])
    expect(sum(allocateProportional(1000, [0, 0, 0]))).toBe(1000)
  })

  it('total of 0 → all zero', () => {
    expect(allocateProportional(0, [30000, 10000])).toEqual([0, 0])
  })

  it('single bucket gets the whole total', () => {
    expect(allocateProportional(64999, [999])).toEqual([64999])
  })

  it('gives leftover cents to the largest fractional remainder deterministically', () => {
    // 100 across 3 equal → 34,33,33 (first index wins the extra cent)
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33])
  })
})
