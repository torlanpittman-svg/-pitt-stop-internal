import { describe, it, expect } from 'vitest'
import { amountsWarning, duplicateEvidence, receiptDateWarning, sameVendor, todayBusinessDate } from './checks'
import { decideFiling } from './types'

describe('receiptDateWarning — questionable scanned dates', () => {
  const today = '2026-11-13'
  it('the Tesla case: a scan read 2020-11-13 on 2026-11-13 → year misread, suggests 2026-11-13', () => {
    const w = receiptDateWarning('2020-11-13', today)
    expect(w?.kind).toBe('year_misread')
    expect(w?.suggestion).toBe('2026-11-13')
    expect(w?.message).toContain('year may have been misread')
  })
  it('a normal recent date is not questioned', () => {
    expect(receiptDateWarning('2026-11-13', today)).toBeNull()
    expect(receiptDateWarning('2026-10-01', today)).toBeNull()
    expect(receiptDateWarning('2026-11-14', today)).toBeNull() // one day of timezone slack
  })
  it('a January receipt captured for a December purchase suggests LAST year, not a future date', () => {
    const w = receiptDateWarning('2021-12-28', '2027-01-05')
    expect(w).toMatchObject({ kind: 'year_misread', suggestion: '2026-12-28' })
  })
  it('a future date is flagged', () => {
    expect(receiptDateWarning('2027-03-01', today)?.kind).toBe('future')
  })
  it('a genuinely old date with no plausible year fix is flagged as old, with no suggestion', () => {
    expect(receiptDateWarning('2026-04-02', today)).toMatchObject({ kind: 'old', suggestion: null })
  })
  it('missing / malformed dates produce no warning (missing info is flagged elsewhere)', () => {
    expect(receiptDateWarning(null, today)).toBeNull()
    expect(receiptDateWarning('11/13/2026', today)).toBeNull()
  })
  it('todayBusinessDate is the shop-local calendar day', () => {
    expect(todayBusinessDate(new Date('2026-11-14T03:30:00Z'))).toBe('2026-11-13') // 9:30 PM Central on the 13th
  })
})

describe('decideFiling — an unconfirmed questionable date is flagged, a confirmed one files clean', () => {
  const base = { entity: 'detail', category: { kind: 'single' as const, key: 'parts' as const }, funding: 'business' as const, paymentMethod: 'card' as const, vendor: 'Tesla Inc.', receiptDate: '2020-11-13', totalCents: 8021 }
  it('flagged when nobody confirmed it', () => {
    const d = decideFiling({ ...base, questionableDate: true })
    expect(d.status).toBe('needs_review')
    expect(d.reasons).toEqual(['questionable_date'])
  })
  it('files clean once confirmed / corrected', () => {
    expect(decideFiling({ ...base, questionableDate: false }).status).toBe('filed')
    expect(decideFiling(base).status).toBe('filed')
  })
})

describe('amountsWarning — shipping and tax are inside the total, once', () => {
  it('Tesla: $71.00 + $9.21 shipping + $0.00 tax = $80.21 → no warning', () => {
    expect(amountsWarning({ subtotalCents: 7100, shippingCents: 921, taxCents: 0, totalCents: 8021 })).toBeNull()
  })
  it('a total that double-counts shipping is flagged', () => {
    expect(amountsWarning({ subtotalCents: 7100, shippingCents: 921, taxCents: 0, totalCents: 8942 })).toContain('$80.21')
  })
  it('not enough to check → no warning', () => {
    expect(amountsWarning({ totalCents: 8021 })).toBeNull()
    expect(amountsWarning({ subtotalCents: 7100 })).toBeNull()
  })
})

describe('duplicateEvidence — flags, never merges', () => {
  const tesla = { vendor: 'Tesla Inc.', receiptDate: '2026-11-13', totalCents: 8021, invoiceNumber: '3000H0000513594', orderNumber: 'GPO-3Y3WMP6N16' }
  it('same vendor + invoice number → likely (even with a different date/total)', () => {
    expect(duplicateEvidence(tesla, { vendor: 'TESLA, INC', invoiceNumber: '3000h0000513594', receiptDate: '2026-11-14', totalCents: 7100 }).strength).toBe('likely')
  })
  it('same order number → likely', () => {
    expect(duplicateEvidence(tesla, { vendor: null, orderNumber: 'gpo-3y3wmp6n16' }).strength).toBe('likely')
  })
  it('same vendor + date + total → likely', () => {
    expect(duplicateEvidence(tesla, { vendor: 'Tesla', receiptDate: '2026-11-13', totalCents: 8021 }).strength).toBe('likely')
  })
  it('same vendor + total a couple of days apart → possible', () => {
    const e = duplicateEvidence(tesla, { vendor: 'Tesla', receiptDate: '2026-11-15', totalCents: 8021 })
    expect(e.strength).toBe('possible')
    expect(e.reasons).toContain('2 days apart')
  })
  it('an equal total alone is NEVER evidence', () => {
    expect(duplicateEvidence(tesla, { vendor: 'O’Reilly', receiptDate: '2026-11-13', totalCents: 8021 }).strength).toBe('none')
  })
  it('same vendor, different amounts and documents → not a duplicate', () => {
    expect(duplicateEvidence(tesla, { vendor: 'Tesla Inc.', receiptDate: '2026-11-13', totalCents: 12000, invoiceNumber: '3000H0000999999' }).strength).toBe('none')
  })
  it('vendor matching ignores punctuation and company suffixes, never matches blanks', () => {
    expect(sameVendor('Tesla Inc.', 'TESLA')).toBe(true)
    expect(sameVendor('', '')).toBe(false)
    expect(sameVendor('NAPA', 'AutoZone')).toBe(false)
  })
})
