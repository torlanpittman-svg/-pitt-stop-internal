import { describe, it, expect } from 'vitest'
import { interpretVinScan } from './vin-scan'

const GOOD = 'W1K2J5KBXPA118276'

describe('interpretVinScan — Scan VIN in Edit Vehicle', () => {
  it('a valid, decoded read fills the VIN and hands the decode to the form (never saved by itself)', () => {
    const r = interpretVinScan(true, { vin: GOOD, valid: true, year: '2023', make: 'MERCEDES-BENZ', model: 'CLS-Class' })
    expect(r).toEqual({ kind: 'decoded', vin: GOOD, decode: { ok: true, valid: true, vin: GOOD, year: '2023', make: 'MERCEDES-BENZ', model: 'CLS-Class', error: undefined } })
  })

  it('a valid VIN the decoder could not describe still fills the VIN, but asks for manual details', () => {
    const r = interpretVinScan(true, { vin: GOOD, valid: true, year: null, make: null, model: null })
    expect(r.kind).toBe('decoded')
    if (r.kind === 'decoded') { expect(r.decode.ok).toBe(false); expect(r.decode.error).toMatch(/manually/) }
  })

  it('a read that fails validation is only a review candidate — it never replaces the VIN on file', () => {
    const r = interpretVinScan(true, { vin: 'W1K2J5KBXPA11827G', valid: false, message: 'We may have misread one or more characters. Review and correct the VIN.' })
    expect(r).toEqual({ kind: 'review', candidate: 'W1K2J5KBXPA11827G', message: 'We may have misread one or more characters. Review and correct the VIN.' })
  })

  it('does not trust valid:true on something that is not VIN-shaped (no guessed characters)', () => {
    expect(interpretVinScan(true, { vin: 'W1K2J5KBXPA11827O', valid: true, make: 'X' }).kind).toBe('review')
    expect(interpretVinScan(true, { vin: 'SHORT', valid: true, make: 'X' }).kind).toBe('review')
  })

  it('an unreadable photo / reader error explains and changes nothing', () => {
    expect(interpretVinScan(false, { error: 'VIN not visible in photo — try holding the camera steady or type it manually' }))
      .toEqual({ kind: 'unreadable', message: 'VIN not visible in photo — try holding the camera steady or type it manually' })
    expect(interpretVinScan(false, null).kind).toBe('unreadable')
    expect(interpretVinScan(true, {}).kind).toBe('unreadable')
  })
})
