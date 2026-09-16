import { describe, it, expect } from 'vitest'
import { validateDecodedMeta, MIN_DIM, MAX_DIM } from './image-decode'

describe('validateDecodedMeta — decodability + dimension bounds', () => {
  it('accepts a decoded jpeg/png/webp of sane dimensions', () => {
    expect(validateDecodedMeta({ format: 'jpeg', width: 800, height: 600 })).toEqual({ ok: true })
    expect(validateDecodedMeta({ format: 'png', width: MIN_DIM, height: MIN_DIM })).toEqual({ ok: true })
    expect(validateDecodedMeta({ format: 'webp', width: 1200, height: 1600 })).toEqual({ ok: true })
  })
  it('rejects an undecodable file (null meta)', () => {
    expect(validateDecodedMeta(null).ok).toBe(false)
  })
  it('rejects a non-raster / disallowed format (e.g. svg/gif/tiff)', () => {
    expect(validateDecodedMeta({ format: 'svg', width: 100, height: 100 }).ok).toBe(false)
    expect(validateDecodedMeta({ format: 'gif', width: 100, height: 100 }).ok).toBe(false)
  })
  it('rejects zero / too-small dimensions (corrupt image)', () => {
    expect(validateDecodedMeta({ format: 'jpeg', width: 0, height: 0 }).ok).toBe(false)
    expect(validateDecodedMeta({ format: 'jpeg', width: 2, height: 2 }).ok).toBe(false)
  })
  it('rejects absurdly large dimensions (decompression abuse)', () => {
    expect(validateDecodedMeta({ format: 'png', width: MAX_DIM + 1, height: 10 }).ok).toBe(false)
  })
})
