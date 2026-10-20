import { describe, it, expect } from 'vitest'
import { invoiceHeading } from './InvoiceDraftPanel'

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
  it('stale / review states', () => {
    expect(invoiceHeading(qb({ status: 'created', linked: true, invoiceNumber: '7', syncNeeded: true })).status).toBe('Created in QuickBooks · sync needed')
    expect(invoiceHeading(qb({ status: 'sent', linked: true, invoiceNumber: '7', sent: true, syncNeeded: true })).status).toBe('Sent · sync needed')
    expect(invoiceHeading(qb({ status: 'created', linked: true, needsReview: true })).status).toBe('Needs review')
    expect(invoiceHeading(qb({ status: 'created', linked: true })).title).toBe('Invoice')
  })
})
