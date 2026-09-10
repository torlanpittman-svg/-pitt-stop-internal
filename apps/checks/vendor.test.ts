import { describe, it, expect } from 'vitest'
import { decideVendor, type QbVendor } from './vendor'

const v = (id: string, displayName: string): QbVendor => ({ id, displayName, active: true })

describe('decideVendor — fail-closed payee resolution', () => {
  it('exactly one exact match (case/space-insensitive) → use it', () => {
    expect(decideVendor('thompson derrig', [v('7', 'Thompson Derrig')])).toEqual({ action: 'use', vendorId: '7', displayName: 'Thompson Derrig' })
  })
  it('normalizes extra whitespace', () => {
    expect(decideVendor('Thompson   Derrig', [v('7', 'Thompson Derrig')])).toMatchObject({ action: 'use', vendorId: '7' })
  })
  it('no match → create', () => {
    expect(decideVendor('Brand New LLC', [])).toEqual({ action: 'create' })
  })
  it('more than one exact match → ambiguous (never picks first)', () => {
    const d = decideVendor('Acme', [v('1', 'Acme'), v('2', 'Acme')])
    expect(d.action).toBe('ambiguous')
    if (d.action === 'ambiguous') expect(d.matches).toHaveLength(2)
  })
  it('ignores non-exact fuzzy matches when deciding create', () => {
    // A LIKE sweep could return near names; decideVendor only counts exact-normalized matches.
    expect(decideVendor('Acme', [v('1', 'Acme Supply'), v('2', 'Acme Parts')])).toEqual({ action: 'create' })
  })
})
