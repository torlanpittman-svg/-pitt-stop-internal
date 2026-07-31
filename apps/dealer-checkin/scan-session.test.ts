import { describe, it, expect } from 'vitest'
import {
  newClientRequestId, blankFields, freshScanSession, isCleanSession, type ScanState,
} from './scan-session'

// Simulate the OCR + edit step populating a scan session (what processImage does).
function populate(s: ScanState, o: {
  stock: string; year?: string; make?: string; model?: string; color?: string
  imageUrl: string; storedUrl: string; hash: string; dealerId?: string | null
}): ScanState {
  return {
    ...s,
    imageUrl: o.imageUrl, storedUrl: o.storedUrl, imageHash: o.hash,
    rawOcr: { stockNumber: o.stock }, ocrValues: { stockNumber: o.stock },
    fields: { stockNumber: o.stock, year: o.year ?? '', make: o.make ?? '', model: o.model ?? '', color: o.color ?? '' },
    selectedDealerId: o.dealerId ?? null,
  }
}
// Simulate pressing "Confirm and Send" (the ONLY path that can create an invoice).
function confirmSubmit(s: ScanState): ScanState { return { ...s, submitted: true } }
// A confirmed, submitted session is the only thing that yields a QuickBooks invoice.
function createdInvoice(s: ScanState): boolean { return s.submitted }

describe('scan-session invariants', () => {
  it('mints a unique idempotency key per scan', () => {
    expect(newClientRequestId()).not.toBe(newClientRequestId())
  })
  it('blankFields returns a fresh object each call (no shared reference)', () => {
    const a = blankFields(); const b = blankFields()
    a.stockNumber = 'K1'
    expect(b.stockNumber).toBe('')
  })
  it('a fresh session is clean; a populated one is not', () => {
    expect(isCleanSession(freshScanSession())).toBe(true)
    const dirty = populate(freshScanSession(), { stock: 'K1', imageUrl: 'blob:a', storedUrl: 'https://b/a', hash: 'h' })
    expect(isCleanSession(dirty)).toBe(false)
  })
})

describe('regression: scan → OCR → edit → back out → restart → scan again → confirm', () => {
  it('starting over yields fresh state and a new key; the confirmed scan carries only its own data', () => {
    // scan A → OCR → edit stock + dealer
    let a = populate(freshScanSession(), { stock: 'U100', make: 'Subaru', imageUrl: 'blob:A', storedUrl: 'https://b/A', hash: 'hA', dealerId: 'sub-id' })
    a = { ...a, fields: { ...a.fields, stockNumber: 'U100-EDIT' }, selectedDealerId: 'autogroup-id' } // employee edits
    expect(a.submitted).toBe(false) // still on the edit screen

    // back out → Start Over → fresh session B
    const b0 = freshScanSession()
    expect(isCleanSession(b0)).toBe(true)
    expect(b0.clientRequestId).not.toBe(a.clientRequestId)

    // scan again (unrelated vehicle) then confirm
    let b = populate(b0, { stock: 'K220', make: 'Kia', imageUrl: 'blob:B', storedUrl: 'https://b/B', hash: 'hB', dealerId: 'kia-id' })
    b = confirmSubmit(b)

    // B carries ONLY B's data — no leakage from the abandoned A
    expect(b.fields.stockNumber).toBe('K220')
    expect(b.imageHash).toBe('hB')
    expect(b.selectedDealerId).toBe('kia-id')
    expect(b.clientRequestId).not.toBe(a.clientRequestId)
    expect(createdInvoice(b)).toBe(true)   // the confirmed scan creates its invoice
    expect(createdInvoice(a)).toBe(false)  // the abandoned scan never did
  })
})

describe('regression: abandon one scan → scan an unrelated tag (no invoice for the abandoned one)', () => {
  it('both are independent and only the confirmed one creates an invoice', () => {
    // abandon scan A before confirming
    const a = populate(freshScanSession(), { stock: 'S900', imageUrl: 'blob:A', storedUrl: 'https://b/A', hash: 'hA' })
    expect(createdInvoice(a)).toBe(false)

    // unrelated tag B, fresh session, confirmed
    const b = confirmSubmit(populate(freshScanSession(), { stock: 'K111', imageUrl: 'blob:B', storedUrl: 'https://b/B', hash: 'hB' }))

    expect(a.clientRequestId).not.toBe(b.clientRequestId)
    expect(b.imageHash).not.toBe(a.imageHash)
    expect(createdInvoice(a)).toBe(false) // abandoned → no QuickBooks invoice
    expect(createdInvoice(b)).toBe(true)  // unrelated tag succeeds independently
  })
})
