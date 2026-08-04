import { describe, it, expect } from 'vitest'
import { isDuplicateService, partitionServices } from './services'

describe('isDuplicateService', () => {
  it('matches case-insensitively and ignores surrounding space', () => {
    expect(isDuplicateService(['Interior Detail'], 'interior detail')).toBe(true)
    expect(isDuplicateService(['Interior Detail'], '  Interior Detail ')).toBe(true)
    expect(isDuplicateService(['Interior Detail'], 'Wax')).toBe(false)
    expect(isDuplicateService([], 'Wax')).toBe(false)
  })
})

describe('partitionServices', () => {
  it('separates brand-new from already-present (case-insensitive), trims + drops blanks', () => {
    const r = partitionServices(['Interior Detail'], ['Wax', 'interior detail', '  ', 'Polish'])
    expect(r.fresh).toEqual(['Wax', 'Polish'])
    expect(r.duplicates).toEqual(['interior detail'])
  })
  it('dedupes within the same request', () => {
    const r = partitionServices([], ['Wax', 'wax', 'Wax'])
    expect(r.fresh).toEqual(['Wax'])
    expect(r.duplicates).toEqual(['wax', 'Wax'])
  })
  it('all new when nothing exists', () => {
    expect(partitionServices([], ['Interior Detail', 'Polish'])).toEqual({ fresh: ['Interior Detail', 'Polish'], duplicates: [] })
  })
  it('carries custom "Other" free text through as fresh', () => {
    const r = partitionServices(['Wax'], ['Headliner steam clean'])
    expect(r.fresh).toEqual(['Headliner steam clean'])
    expect(r.duplicates).toEqual([])
  })
})
