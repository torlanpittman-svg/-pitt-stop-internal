import { describe, it, expect } from 'vitest'
import { validateMicrLayoutPatch, ALLOWED_MICR_FIELDS, MicrConfigError } from './micr-config'
import { micrGeom, DEFAULT_MICR_GEOM } from './layout'

describe('MICR-only calibration write path — validation', () => {
  it('accepts the allowed MICR coordinate fields within bounds', () => {
    const clean = validateMicrLayoutPatch({ baselineFromBottomIn: 0.1875, rightMarginIn: 0.25, amountFieldIn: 1.5, pitchIn: 0.125, sizePt: 10 })
    expect(clean).toEqual({ baselineFromBottomIn: 0.1875, rightMarginIn: 0.25, amountFieldIn: 1.5, pitchIn: 0.125, sizePt: 10 })
    expect(ALLOWED_MICR_FIELDS).toContain('baselineFromBottomIn')
  })

  it('accepts a single-field partial patch (calibration nudge)', () => {
    expect(validateMicrLayoutPatch({ baselineFromBottomIn: 0.21875 })).toEqual({ baselineFromBottomIn: 0.21875 })
  })

  it('REJECTS non-MICR check geometry keys (locked layout is untouchable here)', () => {
    for (const key of ['offsetX', 'offsetY', 'sectionHeightIn', 'position', 'fields', 'perField']) {
      expect(() => validateMicrLayoutPatch({ [key]: 1 })).toThrow(MicrConfigError)
      try { validateMicrLayoutPatch({ [key]: 1 }) } catch (e) { expect((e as MicrConfigError).code).toBe('non_micr_field') }
    }
  })

  it('REJECTS the micr_enabled / enable flags (this path never enables MICR)', () => {
    for (const key of ['micr_enabled', 'enabled', 'micrEnabled']) {
      try { validateMicrLayoutPatch({ [key]: true }); throw new Error('should have thrown') }
      catch (e) { expect((e as MicrConfigError).code).toBe('enable_not_allowed') }
    }
  })

  it('REJECTS unknown fields', () => {
    try { validateMicrLayoutPatch({ nope: 1 }); throw new Error('should have thrown') }
    catch (e) { expect((e as MicrConfigError).code).toBe('unknown_field') }
  })

  it('REJECTS out-of-range and non-numeric values (no silent coercion)', () => {
    try { validateMicrLayoutPatch({ baselineFromBottomIn: 5 }); throw new Error('x') } catch (e) { expect((e as MicrConfigError).code).toBe('out_of_range') }
    try { validateMicrLayoutPatch({ sizePt: 2 }); throw new Error('x') } catch (e) { expect((e as MicrConfigError).code).toBe('out_of_range') }
    try { validateMicrLayoutPatch({ pitchIn: 'abc' }); throw new Error('x') } catch (e) { expect((e as MicrConfigError).code).toBe('not_a_number') }
    try { validateMicrLayoutPatch({ baselineFromBottomIn: -0.1 }); throw new Error('x') } catch (e) { expect((e as MicrConfigError).code).toBe('out_of_range') }
  })

  it('REJECTS empty / malformed bodies', () => {
    try { validateMicrLayoutPatch({}); throw new Error('x') } catch (e) { expect((e as MicrConfigError).code).toBe('empty_patch') }
    try { validateMicrLayoutPatch(null); throw new Error('x') } catch (e) { expect((e as MicrConfigError).code).toBe('invalid_body') }
    try { validateMicrLayoutPatch([1, 2]); throw new Error('x') } catch (e) { expect((e as MicrConfigError).code).toBe('invalid_body') }
  })

  it('a validated patch resolves through micrGeom without disturbing untouched defaults', () => {
    const patch = validateMicrLayoutPatch({ baselineFromBottomIn: 0.25 })
    const resolved = micrGeom(patch as Partial<typeof DEFAULT_MICR_GEOM>)
    expect(resolved.baselineFromBottomIn).toBe(0.25)      // applied
    expect(resolved.pitchIn).toBe(DEFAULT_MICR_GEOM.pitchIn)   // untouched default
    expect(resolved.sizePt).toBe(DEFAULT_MICR_GEOM.sizePt)     // untouched default
  })
})
