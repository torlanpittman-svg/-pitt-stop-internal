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
  beforeEach(() => { delete process.env.AUTODEV_API_KEY; delete process.env.PLATETOVIN_API_KEY; delete process.env.PLATE_LOOKUP_ENABLED; delete process.env.PLATE_LOOKUP_PROVIDER })
  afterEach(() => { process.env = { ...OLD }; vi.unstubAllGlobals() })

  it('no key → no provider, feature disabled', () => {
    expect(getPlateProvider()).toBeNull()
    expect(isPlateLookupEnabled()).toBe(false)
  })
  it('defaults to platetovin; key present but flag off → still disabled', () => {
    process.env.PLATETOVIN_API_KEY = 'secret'
    expect(getPlateProvider()?.name).toBe('platetovin')
    expect(isPlateLookupEnabled()).toBe(false)
  })
  it('platetovin key present AND flag on → enabled', () => {
    process.env.PLATETOVIN_API_KEY = 'secret'
    process.env.PLATE_LOOKUP_ENABLED = 'true'
    expect(isPlateLookupEnabled()).toBe(true)
  })
  it('auto_dev kept as a selectable fallback provider', () => {
    process.env.PLATE_LOOKUP_PROVIDER = 'auto_dev'
    process.env.AUTODEV_API_KEY = 'secret'
    expect(getPlateProvider()?.name).toBe('auto_dev')
  })
})

describe('PlateToVinProvider.lookup (active provider)', () => {
  const OLD = { ...process.env }
  beforeEach(() => { process.env.PLATE_LOOKUP_PROVIDER = 'platetovin'; process.env.PLATETOVIN_API_KEY = 'secret' })
  afterEach(() => { process.env = { ...OLD }; vi.unstubAllGlobals() })

  it('POSTs {state,plate} to /api/convert with raw Authorization and parses the vehicle', async () => {
    let calledUrl = '', auth = '', body = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: { headers: Record<string, string>; body: string }) => {
      calledUrl = url; auth = opts.headers.Authorization; body = opts.body
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ success: true, vin: { vin: '4JGBB8GB9BA648907', year: '2011', make: 'Mercedes-Benz', model: 'M-Class', trim: 'ML 350', style: 'SUV' } }) } as unknown as Response
    }))
    const r = await getPlateProvider()!.lookup('7ABC123', 'CA')
    expect(calledUrl).toBe('https://platetovin.com/api/convert')
    expect(auth).toBe('secret') // raw key, no Bearer
    expect(JSON.parse(body)).toEqual({ state: 'CA', plate: '7ABC123' })
    expect(r).toMatchObject({ vin: '4JGBB8GB9BA648907', year: '2011', make: 'Mercedes-Benz', model: 'M-Class', trim: 'ML 350', status: 'http_200' })
  })
  it('returns vin:null when success:false / no vin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: false }) } as unknown as Response)))
    const r = await getPlateProvider()!.lookup('NOPE', 'TX')
    expect(r.vin).toBeNull()
  })
  it('returns vin:null on a non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response)))
    const r = await getPlateProvider()!.lookup('NOPE', 'TX')
    expect(r.vin).toBeNull()
    expect(r.status).toBe('http_404')
  })
})
