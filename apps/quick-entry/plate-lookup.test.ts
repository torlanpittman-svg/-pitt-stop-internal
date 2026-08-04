import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { normalizePlate, isValidState, getPlateProvider, isPlateLookupEnabled } from './plate-lookup'

describe('plate input helpers', () => {
  it('normalizePlate uppercases and strips spaces/punctuation', () => {
    expect(normalizePlate(' abc-123 ')).toBe('ABC123')
    expect(normalizePlate('7xyz.88')).toBe('7XYZ88')
  })
  it('isValidState accepts US states (case-insensitive) incl. TX + DC, rejects junk', () => {
    expect(isValidState('TX')).toBe(true)
    expect(isValidState('tx')).toBe(true)
    expect(isValidState('DC')).toBe(true)
    expect(isValidState('ZZ')).toBe(false)
    expect(isValidState('')).toBe(false)
  })
})

describe('provider registry + feature flag', () => {
  const OLD = { ...process.env }
  beforeEach(() => { delete process.env.AUTODEV_API_KEY; delete process.env.PLATE_LOOKUP_ENABLED; delete process.env.PLATE_LOOKUP_PROVIDER })
  afterEach(() => { process.env = { ...OLD }; vi.unstubAllGlobals() })

  it('no key → no provider, feature disabled', () => {
    expect(getPlateProvider()).toBeNull()
    expect(isPlateLookupEnabled()).toBe(false)
  })
  it('key present but flag off → still disabled', () => {
    process.env.AUTODEV_API_KEY = 'secret'
    expect(getPlateProvider()?.name).toBe('auto_dev')
    expect(isPlateLookupEnabled()).toBe(false)
  })
  it('key present AND flag on → enabled', () => {
    process.env.AUTODEV_API_KEY = 'secret'
    process.env.PLATE_LOOKUP_ENABLED = 'true'
    expect(isPlateLookupEnabled()).toBe(true)
  })
})

describe('AutoDevProvider.lookup', () => {
  const OLD = { ...process.env }
  afterEach(() => { process.env = { ...OLD }; vi.unstubAllGlobals() })

  it('calls the plate/{state}/{plate} endpoint with Bearer auth and parses the vehicle', async () => {
    process.env.AUTODEV_API_KEY = 'secret'
    let calledUrl = '', authHeader = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: { headers: Record<string, string> }) => {
      calledUrl = url; authHeader = opts.headers.Authorization
      return { ok: true, status: 200, headers: { get: () => 'req_123' },
        json: async () => ({ vin: '1N4BL4BV3LC205823', year: 2020, make: 'Nissan', model: 'Altima', trim: '2.5 S' }) } as unknown as Response
    }))
    const r = await getPlateProvider()!.lookup('ABC123', 'TX')
    expect(calledUrl).toBe('https://api.auto.dev/plate/TX/ABC123')
    expect(authHeader).toBe('Bearer secret')
    expect(r).toMatchObject({ vin: '1N4BL4BV3LC205823', year: '2020', make: 'Nissan', model: 'Altima', trim: '2.5 S', status: 'http_200', requestId: 'req_123' })
  })
  it('returns vin:null on a 404 (plate not found)', async () => {
    process.env.AUTODEV_API_KEY = 'secret'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response)))
    const r = await getPlateProvider()!.lookup('NOPE', 'TX')
    expect(r.vin).toBeNull()
    expect(r.status).toBe('http_404')
  })
})
