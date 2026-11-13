import { describe, it, expect } from 'vitest'
import { parseReceiptJson, EMPTY_EXTRACTION } from './ai'

describe('parseReceiptJson — proposal normalization (never invents, never $0)', () => {
  it('extracts a well-formed receipt into integer cents', () => {
    const e = parseReceiptJson({
      vendor: "O'Reilly Auto Parts", date: '2026-09-14', subtotal: 45.0, tax: 3.71, total: 48.71,
      category: 'Parts', paymentMethod: 'card', paymentLast4: 'XXXX-1234', receiptNumber: 'INV-77',
    })
    expect(e.vendor).toBe("O'Reilly Auto Parts")
    expect(e.date).toBe('2026-09-14')
    expect(e.subtotalCents).toBe(4500)
    expect(e.taxCents).toBe(371)
    expect(e.totalCents).toBe(4871)
    expect(e.categoryKey).toBe('parts')
    expect(e.paymentMethod).toBe('card')
    expect(e.paymentLast4).toBe('1234')
    expect(e.receiptNumber).toBe('INV-77')
    expect(e.present).toEqual({ vendor: true, date: true, subtotal: true, tax: true, total: true, category: true, paymentMethod: true })
  })

  it('parses cardBrand + paymentMethod + accountEnding for the payment-source match (only validated values)', () => {
    const e = parseReceiptJson({ vendor: 'Costco', total: 40, paymentMethod: 'card', cardBrand: 'Mastercard', paymentLast4: '0022', accountEnding: '2649' })
    expect(e.paymentMethod).toBe('card'); expect(e.cardBrand).toBe('mastercard'); expect(e.paymentLast4).toBe('0022'); expect(e.accountEnding).toBe('2649')
    // a "multiple tenders" method is preserved; an unknown brand becomes null (never invented)
    expect(parseReceiptJson({ paymentMethod: 'multiple' }).paymentMethod).toBe('multiple')
    expect(parseReceiptJson({ cardBrand: 'JCB' }).cardBrand).toBeNull()
    expect(EMPTY_EXTRACTION.cardBrand).toBeNull(); expect(EMPTY_EXTRACTION.accountEnding).toBeNull()
  })

  it('keeps missing fields null and records absence in `present` (never coerces to $0)', () => {
    const e = parseReceiptJson({ vendor: 'Shell', total: 60.0 })
    expect(e.vendor).toBe('Shell')
    expect(e.totalCents).toBe(6000)
    expect(e.subtotalCents).toBeNull()
    expect(e.taxCents).toBeNull()
    expect(e.date).toBeNull()
    expect(e.present.total).toBe(true)
    expect(e.present.subtotal).toBe(false)
    expect(e.present.tax).toBe(false)
    expect(e.present.date).toBe(false)
  })

  it('rejects an invalid date and an out-of-set payment method', () => {
    const e = parseReceiptJson({ date: '09/14/2026', paymentMethod: 'crypto' })
    expect(e.date).toBeNull()
    expect(e.paymentMethod).toBeNull()
  })

  it('maps an unknown category to uncategorized (flagged), not a guessed account', () => {
    const e = parseReceiptJson({ category: 'mystery thing', total: 10 })
    expect(e.categoryKey).toBe('other')
    const e2 = parseReceiptJson({ total: 10 })
    expect(e2.categoryKey).toBe('uncategorized')
  })

  it('suggests a category from the item DESCRIPTION when there is no explicit category label', () => {
    // "microfiber towels" → detailing/shop supplies, even though no `category` was returned.
    const e = parseReceiptJson({ vendor: 'Costco', total: 40, description: 'microfiber towels, wax' })
    expect(e.categoryKey).toBe('shop_supplies')
    expect(e.description).toBe('microfiber towels, wax')
    expect(e.present.category).toBe(true) // a description counts as a category signal (a suggestion)
  })

  it('an explicit category label wins over the description', () => {
    const e = parseReceiptJson({ category: 'Parts', description: 'microfiber towels', total: 10 })
    expect(e.categoryKey).toBe('parts')
  })

  it('an empty / garbage object yields the empty proposal shape', () => {
    const e = parseReceiptJson({})
    expect(e).toEqual({ ...EMPTY_EXTRACTION })
    const e2 = parseReceiptJson(null)
    expect(e2.totalCents).toBeNull()
    expect(e2.categoryKey).toBe('uncategorized')
  })
})

// ── PDF / pasted text input + the extra fields (prompt exp_v3) ──
import { evidencePart, parseReceiptJson as parseV3 } from './ai'

describe('parseReceiptJson — shipping, order number (Tesla invoice shape)', () => {
  it('keeps shipping as its own component and the order number apart from the invoice number', () => {
    const e = parseV3({ vendor: 'Tesla Inc.', date: '2026-11-13', subtotal: 71, tax: 0, shipping: 9.21, total: 80.21, receiptNumber: '3000H0000513594', orderNumber: 'GPO-3Y3WMP6N16', description: 'seat cushion foam', paymentMethod: 'card' })
    expect(e).toMatchObject({ subtotalCents: 7100, taxCents: 0, shippingCents: 921, totalCents: 8021, receiptNumber: '3000H0000513594', orderNumber: 'GPO-3Y3WMP6N16' })
    expect(e.subtotalCents! + e.taxCents! + e.shippingCents!).toBe(e.totalCents) // shipping + tax are INSIDE the total, once
  })
  it('never invents shipping, an order number or a payment card', () => {
    const e = parseV3({ vendor: 'NAPA', total: 12.5, paymentMethod: 'card' })
    expect(e.shippingCents).toBeNull()
    expect(e.orderNumber).toBeNull()
    expect(e.paymentLast4).toBeNull()
    expect(e.cardBrand).toBeNull()
  })
})

describe('evidencePart — the model input for each kind of stored evidence', () => {
  it('a photo goes to vision', () => {
    expect(evidencePart('QUJD', 'image/jpeg')).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } })
  })
  it('a PDF is sent as a file input (never as an image)', () => {
    expect(evidencePart('QUJD', 'application/pdf')).toEqual({ type: 'file', file: { filename: 'receipt.pdf', file_data: 'data:application/pdf;base64,QUJD' } })
  })
  it('pasted text is sent as text', () => {
    const p = evidencePart(Buffer.from('Total: $80.21').toString('base64'), 'text/plain') as { type: string; text: string }
    expect(p.type).toBe('text')
    expect(p.text).toContain('Total: $80.21')
  })
})
