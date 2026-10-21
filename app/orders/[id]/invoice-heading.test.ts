import { describe, it, expect } from 'vitest'
import { invoiceHeading } from './InvoiceDraftPanel'
import { nextEntry } from './InvoicePaymentSection'

describe('Record Payment recovery: what the sheet keeps after a server preview', () => {
  const typed = { method: 'cash' as const, amountText: '50.00', amountEdited: true }
  it('a deliberate recheck keeps the typed amount + method (lost response / "Check QuickBooks")', () => {
    expect(nextEntry(typed, {}, true)).toEqual(typed)
  })
  it('opening fresh clears the entry ("Record Payment" / "Record another payment")', () => {
    expect(nextEntry(typed, {}, false)).toEqual({ method: null, amountText: '', amountEdited: false })
  })
  it('a pinned unconfirmed attempt always overrides, whatever was typed', () => {
    expect(nextEntry(typed, { pendingMethod: 'check', pendingAmountCents: 41100 }, true))
      .toEqual({ method: 'check', amountText: '411.00', amountEdited: true })
    expect(nextEntry(typed, { pendingMethod: 'check', pendingAmountCents: 41100 }, false))
      .toEqual({ method: 'check', amountText: '411.00', amountEdited: true })
  })
  it('a pinned method with no pinned amount keeps the typed amount (recheck)', () => {
    expect(nextEntry(typed, { pendingMethod: 'cash' }, true)).toEqual({ method: 'cash', amountText: '50.00', amountEdited: true })
  })
})

const qb = (over: Partial<Parameters<typeof invoiceHeading>[0] & object> = {}) => ({
  status: 'none', linked: false, invoiceNumber: null, error: null, syncNeeded: false, needsReview: false,
  sent: false, resendRecommended: false, sentAt: null, ...over,
})

describe('invoiceHeading — never implies a document was created or sent', () => {
  it('no QuickBooks invoice yet → "Invoice Draft", no status', () => {
    expect(invoiceHeading(null)).toEqual({ title: 'Invoice Draft', status: null })
    expect(invoiceHeading(qb())).toEqual({ title: 'Invoice Draft', status: null })
    expect(invoiceHeading(qb({ status: 'error' }))).toEqual({ title: 'Invoice Draft', status: null })   // failed create
  })
  it('created, not sent', () => {
    expect(invoiceHeading(qb({ status: 'created', linked: true, invoiceNumber: '100897' })))
      .toEqual({ title: 'Invoice #100897', status: 'Created in QuickBooks · not sent' })
  })
  it('sent', () => {
    expect(invoiceHeading(qb({ status: 'sent', linked: true, invoiceNumber: '42', sent: true }))).toEqual({ title: 'Invoice #42', status: 'Sent' })
  })
  it('paid only when QuickBooks confirmed it — an unconfirmed payment is not "Paid"', () => {
    expect(invoiceHeading(qb({ status: 'sent', linked: true, invoiceNumber: '42', sent: true, payment: { status: 'paid' } })).status).toBe('Paid')
    expect(invoiceHeading(qb({ status: 'sent', linked: true, invoiceNumber: '42', sent: true, payment: { status: 'uncertain' } })).status).toBe('Sent')
    // Partially paid only from the QuickBooks-confirmed aggregate — never "Paid" while a balance remains.
    expect(invoiceHeading(qb({ status: 'sent', linked: true, invoiceNumber: '42', sent: true, payment: { status: 'recorded', balanceState: 'partial' } })).status).toBe('Partially paid')
    expect(invoiceHeading(qb({ status: 'sent', linked: true, invoiceNumber: '42', sent: true, payment: { status: 'error', balanceState: 'partial' } })).status).toBe('Partially paid')
    expect(invoiceHeading(qb({ status: 'created', linked: true, invoiceNumber: '42', payment: { status: 'review' } })).status).toBe('Created in QuickBooks · not sent')
  })
  it('stale / review states', () => {
    expect(invoiceHeading(qb({ status: 'created', linked: true, invoiceNumber: '7', syncNeeded: true })).status).toBe('Created in QuickBooks · sync needed')
    expect(invoiceHeading(qb({ status: 'sent', linked: true, invoiceNumber: '7', sent: true, syncNeeded: true })).status).toBe('Sent · sync needed')
    expect(invoiceHeading(qb({ status: 'created', linked: true, needsReview: true })).status).toBe('Needs review')
    expect(invoiceHeading(qb({ status: 'created', linked: true })).title).toBe('Invoice')
  })
})
