import { describe, it, expect } from 'vitest'
import { correctedLineDescription, diffVehicle, qbSyncDecision } from './correction'

describe('correctedLineDescription', () => {
  it('builds YEAR MAKE MODEL COLOR #STOCK (the corrected GMC 1500 example)', () => {
    expect(correctedLineDescription({ year: '2024', make: 'GMC', model: '1500', stockNumber: 'AP12345' }, 'White'))
      .toBe('2024 GMC 1500 White #AP12345')
  })
  it('omits empty segments', () => {
    expect(correctedLineDescription({ year: '2024', make: 'GMC', model: '1500' }, null))
      .toBe('2024 GMC 1500')
  })
})

describe('diffVehicle', () => {
  it('lists only changed fields with old/new', () => {
    const d = diffVehicle(
      { year: '2024', make: 'GMC', model: '1300', vin: 'V1', stockNumber: 'AP12345' },
      { year: '2024', make: 'GMC', model: '1500', vin: 'V1', stockNumber: 'AP12345' },
    )
    expect(d.changed).toEqual(['model'])
    expect(d.old).toEqual({ model: '1300' })
    expect(d.new).toEqual({ model: '1500' })
  })
  it('treats null/blank/whitespace as unchanged', () => {
    expect(diffVehicle({ make: 'GMC', model: null }, { make: ' GMC ', model: '' }).changed).toEqual([])
  })
})

describe('qbSyncDecision', () => {
  const base = { qbLineId: 'L1', qbInvoiceNumber: '100810', qbSyncStatus: 'synced' }
  it('update when a synced line exists and the description changed', () => {
    expect(qbSyncDecision({ ...base, oldDescription: '2024 GMC 1300 #AP1', newDescription: '2024 GMC 1500 #AP1' })).toBe('update')
  })
  it('no_change when the description is identical (e.g. only VIN edited)', () => {
    expect(qbSyncDecision({ ...base, oldDescription: '2024 GMC 1500 #AP1', newDescription: '2024 GMC 1500 #AP1' })).toBe('no_change')
  })
  it('not_linked when there is no synced dealer invoice line', () => {
    expect(qbSyncDecision({ qbLineId: null, qbInvoiceNumber: null, qbSyncStatus: null, oldDescription: 'a', newDescription: 'b' })).toBe('not_linked')
    expect(qbSyncDecision({ ...base, qbSyncStatus: 'queued', oldDescription: 'a', newDescription: 'b' })).toBe('not_linked')
    expect(qbSyncDecision({ ...base, qbLineId: null, oldDescription: 'a', newDescription: 'b' })).toBe('not_linked')
  })
})

describe('qbSyncDecision — hand-made QuickBooks invoice (qb_invoice_external)', () => {
  it('never rewrites a line on an externally managed invoice, even when fully linked and changed', () => {
    expect(qbSyncDecision({
      qbLineId: '1', qbInvoiceNumber: '100937', qbSyncStatus: 'synced', qbInvoiceExternal: true,
      oldDescription: '2026 Kia Sorento Panthera #TG481851', newDescription: '2026 Kia Sorento Black #TG481851',
    })).toBe('not_linked')
  })
  it('false/absent flag keeps the existing behaviour', () => {
    const base = { qbLineId: '1', qbInvoiceNumber: '100931', qbSyncStatus: 'synced', oldDescription: 'a #K1', newDescription: 'b #K1' }
    expect(qbSyncDecision({ ...base, qbInvoiceExternal: false })).toBe('update')
    expect(qbSyncDecision(base)).toBe('update')
  })
})
