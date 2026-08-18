import { describe, it, expect } from 'vitest'
import { buildInvoiceDraft } from './invoice-draft'

// Minimal shapes — buildInvoiceDraft only reads the fields asserted below.
function order(over: Record<string, unknown> = {}) {
  return {
    customerName: 'Jane Doe', source: 'retail', serviceType: 'detail',
    vehicle: { year: 2020, make: 'Honda', model: 'Civic', vin: 'X' },
    services: ['Interior Detail'], ...over,
  } as never
}
function full(est: Record<string, unknown>, feeLines: { feeCode: string; priceCents: number }[] = []) {
  return {
    estimate: {
      priceMode: 'explicit_pretax', explicitTotalCents: 65000, taxCents: 0,
      totalCents: 68959, needsTaxReview: false, waiveShopSupplies: false, waiveCardFee: false, taxExempt: false,
      ...est,
    },
    services: [{ lines: feeLines.map((f) => ({ generated: true, feeCode: f.feeCode, priceCents: f.priceCents })) }],
  } as never
}
const P = { paymentLabel: 'Card Payment', role: 'manager' as const }

describe('buildInvoiceDraft', () => {
  it('dealer Jobs carry no retail draft', () => {
    const d = buildInvoiceDraft({ order: order({ source: 'dealer', serviceType: 'dealer_detail' }), full: null, ...P })
    expect(d.isDealer).toBe(true)
    expect(d.priced).toBe(false)
  })

  it('unpriced retail Job is not priced', () => {
    const d = buildInvoiceDraft({ order: order(), full: full({ priceMode: 'itemized', explicitTotalCents: null }), ...P })
    expect(d.isDealer).toBe(false)
    expect(d.priced).toBe(false)
  })

  it('priced retail Job exposes work + fee breakdown + total', () => {
    const d = buildInvoiceDraft({
      order: order(),
      full: full({ totalCents: 68959 }, [{ feeCode: 'shop_supplies', priceCents: 1950 }, { feeCode: 'payment_charge', priceCents: 2009 }]),
      ...P,
    })
    expect(d.priced).toBe(true)
    expect(d.workPriceCents).toBe(65000)
    expect(d.shopSupplies).toEqual({ cents: 1950, waived: false })
    expect(d.paymentCharge).toEqual({ cents: 2009, waived: false, label: 'Card Payment' })
    expect(d.totalCents).toBe(68959)
    expect(d.tax.applicable).toBe(false)   // detailing → $0, hidden
  })

  it('reflects a removed (waived) charge and drops it from the shown amount source', () => {
    const d = buildInvoiceDraft({
      order: order(),
      full: full({ waiveCardFee: true, totalCents: 66950 }, [{ feeCode: 'shop_supplies', priceCents: 1950 }]),
      ...P,
    })
    expect(d.paymentCharge.waived).toBe(true)
    expect(d.paymentCharge.cents).toBe(0)   // no generated payment line exists when waived
    expect(d.totalCents).toBe(66950)
  })

  it('prices an ITEMIZED Job from the sum of service lines (fees excluded, no double-count)', () => {
    const full = {
      estimate: {
        priceMode: 'itemized', explicitTotalCents: null, taxCents: 0, totalCents: 68959,
        needsTaxReview: false, waiveShopSupplies: false, waiveCardFee: false, taxExempt: false,
      },
      services: [
        { lines: [{ generated: false, priceCents: 30000, qty: '1' }] },   // Interior Detail
        { lines: [{ generated: false, priceCents: 35000, qty: '1' }] },   // Exterior + Wax
        { lines: [
          { generated: true, feeCode: 'shop_supplies', priceCents: 1950, qty: '1' },
          { generated: true, feeCode: 'payment_charge', priceCents: 2009, qty: '1' },
        ] },
      ],
    } as never
    const d = buildInvoiceDraft({ order: order(), full, ...P })
    expect(d.priced).toBe(true)
    expect(d.workPriceCents).toBe(65000)   // 300 + 350, fee lines excluded
    expect(d.shopSupplies.cents).toBe(1950)
    expect(d.paymentCharge.cents).toBe(2009)
    expect(d.totalCents).toBe(68959)
  })

  it('shows the tax row when tax applies or is under review', () => {
    const taxed = buildInvoiceDraft({ order: order(), full: full({ taxCents: 5363, totalCents: 74322 }), ...P })
    expect(taxed.tax.applicable).toBe(true)
    const review = buildInvoiceDraft({ order: order(), full: full({ needsTaxReview: true }), ...P })
    expect(review.tax.applicable).toBe(true)
  })

  // Phase C: invoice-id-first qb state derivation (linked / syncNeeded / needsReview).
  describe('qb link state', () => {
    const qb = (est: Record<string, unknown>) => buildInvoiceDraft({ order: order(), full: full(est), ...P }).qb
    it('not linked when no qb_invoice_id', () => {
      const s = qb({ qbStatus: 'none', qbInvoiceId: null })
      expect(s.linked).toBe(false); expect(s.syncNeeded).toBe(false); expect(s.needsReview).toBe(false)
    })
    it('linked + current when created with no error', () => {
      const s = qb({ qbStatus: 'created', qbInvoiceId: '23501', qbInvoiceNumber: '100841', qbSyncError: null })
      expect(s.linked).toBe(true); expect(s.status).toBe('created'); expect(s.syncNeeded).toBe(false); expect(s.needsReview).toBe(false)
    })
    it('syncNeeded from the "sync needed" error convention', () => {
      const s = qb({ qbStatus: 'created', qbInvoiceId: '23501', qbSyncError: 'QuickBooks sync needed — a price changed.' })
      expect(s.linked).toBe(true); expect(s.syncNeeded).toBe(true); expect(s.needsReview).toBe(false)
    })
    it('needsReview takes precedence over syncNeeded', () => {
      const s = qb({ qbStatus: 'created', qbInvoiceId: '23501', qbSyncError: 'Needs review — Customer no longer matches this invoice' })
      expect(s.needsReview).toBe(true); expect(s.syncNeeded).toBe(false)
    })
  })
})
