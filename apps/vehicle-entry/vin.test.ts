import { describe, it, expect } from 'vitest'
import { validateVIN, normalizeVIN } from './vin'

// These back the VIN-correction fix in /api/estimator/vin: when validation fails
// (e.g. check digit), the route must NOT discard the candidate — it returns
// normalizeVIN(raw) with valid:false so the employee can review/correct it.
describe('validateVIN', () => {
  it('accepts a valid VIN (correct check digit)', () => {
    expect(validateVIN('1HGCM82633A004352')).toEqual({ valid: true })
  })
  it('flags a check-digit mismatch (candidate must still be preserved by the caller)', () => {
    const r = validateVIN('1HGCM82633A004353') // last-but-9 check digit now wrong
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/check digit/i)
  })
  it('rejects I, O, Q', () => {
    expect(validateVIN('1HGCM8263IA004352').valid).toBe(false)
    expect(validateVIN('1HGCM8263OA004352').valid).toBe(false)
    expect(validateVIN('1HGCM8263QA004352').valid).toBe(false)
  })
  it('rejects wrong length', () => {
    expect(validateVIN('1HGCM8263').valid).toBe(false)
  })
})

describe('normalizeVIN (candidate preserved for the editable field)', () => {
  it('uppercases and strips whitespace but keeps every VIN character', () => {
    expect(normalizeVIN(' 1hgcm82633a004352 ')).toBe('1HGCM82633A004352')
  })
  it('preserves a bad-check-digit candidate verbatim (not discarded)', () => {
    expect(normalizeVIN('1hgcm82633a004353')).toBe('1HGCM82633A004353')
  })
})
