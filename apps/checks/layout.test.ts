import { describe, it, expect } from 'vitest'
import { buildLayout, resolveFieldPosition, slotOriginY, CHECK_HEIGHT_IN, DEFAULT_LAYOUT } from './layout'

describe('check layout math — single source of truth for positions', () => {
  it('slot origin by position', () => {
    expect(slotOriginY('top')).toBe(0)
    expect(slotOriginY('middle')).toBe(CHECK_HEIGHT_IN)
    expect(slotOriginY('bottom')).toBe(CHECK_HEIGHT_IN * 2)
  })

  it('applies global offset to every field', () => {
    const layout = buildLayout({ offsetX: 0.1, offsetY: 0.2 })
    const base = DEFAULT_LAYOUT.perField.payee
    const p = resolveFieldPosition(layout, 'payee')
    expect(p.xIn).toBeCloseTo(base.xIn + 0.1, 5)
    expect(p.yIn).toBeCloseTo(base.yIn + 0.2, 5)
  })

  it('adds the slot origin for middle/bottom checks', () => {
    const mid = buildLayout({ position: 'middle' })
    const p = resolveFieldPosition(mid, 'payee')
    expect(p.yIn).toBeCloseTo(DEFAULT_LAYOUT.perField.payee.yIn + CHECK_HEIGHT_IN, 5)
  })

  it('buildLayout ignores non-finite offsets and empty field lists', () => {
    const l = buildLayout({ offsetX: NaN as unknown as number, fields: [] })
    expect(l.offsetX).toBe(0)
    expect(l.fields.length).toBeGreaterThan(0)
  })

  it('checkNumber IS drawn by default (Blue Summit blank stock — we print the whole face)', () => {
    expect(DEFAULT_LAYOUT.fields).toContain('checkNumber')
  })
})
