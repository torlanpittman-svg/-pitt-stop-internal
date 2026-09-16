import { describe, it, expect } from 'vitest'
import { decideRetrieval, toReviewCard, receiptImagePath, type ReviewCardData } from './view'

type Row = Parameters<typeof toReviewCard>[0]

// Minimal private-storage row (only the fields the view helpers read; the rest are irrelevant here).
function row(over: Partial<Row> = {}): Row {
  return {
    id: 'rec-1', status: 'needs_review', entity: 'detail', category: 'parts', vendor: 'ACME',
    receiptDate: '2026-09-14', subtotalCents: 100, taxCents: 8, totalCents: 108, paymentMethod: 'card',
    accountRef: null, paymentLast4: '1234', memo: null, inventoryVehicleId: null,
    storage: 'blob_private', storageRef: 'business-receipts/deadbeef.jpg', filename: 'r.jpg',
    contentType: 'image/jpeg', imageHash: 'deadbeef', byteSize: 100,
    aiStatus: 'extracted', aiModel: 'gpt-4o', aiRaw: { content: 'SENSITIVE raw model text' },
    aiExtracted: { vendor: 'ACME' }, confidence: { vendor: true, total: true },
    reviewedBy: null, reviewedAt: null, approvedBy: null, approvedAt: null, rejectedReason: null,
    auditLog: [], uploadedBy: 'Bart', qbSyncStatus: 'none', qbEntityRef: null, qbSyncedAt: null,
    createdAt: new Date('2026-09-14T12:00:00Z'), updatedAt: new Date('2026-09-14T12:00:00Z'),
    ...over,
  } as unknown as Row
}

describe('toReviewCard — client-safe serialization', () => {
  it('serves the image only through the gated path, never the Blob reference', () => {
    const card = toReviewCard(row())
    expect(card.imageUrl).toBe(receiptImagePath('rec-1'))
    expect(card.imageUrl).toBe('/api/expenses/receipt/rec-1/image')
  })

  it('EXCLUDES ai_raw / ai_extracted / storageRef and never leaks the Blob pathname', () => {
    const card = toReviewCard(row()) as ReviewCardData & Record<string, unknown>
    expect('aiRaw' in card).toBe(false)
    expect('aiExtracted' in card).toBe(false)
    expect('storageRef' in card).toBe(false)
    const json = JSON.stringify(card)
    expect(json).not.toContain('business-receipts/deadbeef.jpg') // pathname never in payload
    expect(json).not.toContain('SENSITIVE raw model text')       // raw AI text never in payload
  })

  it('exposes only the boolean presence map (confidence), not the extracted values', () => {
    const card = toReviewCard(row())
    expect(card.present).toEqual({ vendor: true, total: true })
  })

  it('has no image url when nothing was stored', () => {
    const card = toReviewCard(row({ storage: 'none', storageRef: null }))
    expect(card.imageUrl).toBeNull()
  })
})

describe('decideRetrieval — gated image authorization (IDOR-safe)', () => {
  it('anonymous → 401 (before any existence check)', () => {
    expect(decideRetrieval(null, row())).toEqual({ ok: false, status: 401 })
  })
  it('employee / non-manager → 403', () => {
    expect(decideRetrieval({ role: 'employee' }, row())).toEqual({ ok: false, status: 403 })
    expect(decideRetrieval({ role: null }, row())).toEqual({ ok: false, status: 403 })
  })
  it('manager + nonexistent receipt → 404 (no leak, no pathname)', () => {
    expect(decideRetrieval({ role: 'manager' }, null)).toEqual({ ok: false, status: 404 })
  })
  it('manager + a receipt without private storage → 404', () => {
    expect(decideRetrieval({ role: 'manager' }, row({ storage: 'none', storageRef: null }))).toEqual({ ok: false, status: 404 })
  })
  it('manager + valid private image → resolves the pathname server-side, inline for safe images', () => {
    const d = decideRetrieval({ role: 'manager' }, row())
    expect(d).toEqual({ ok: true, pathname: 'business-receipts/deadbeef.jpg', contentType: 'image/jpeg', disposition: 'inline' })
  })
  it('admin also allowed', () => {
    expect(decideRetrieval({ role: 'admin' }, row()).ok).toBe(true)
  })
  it('an unexpected/unsafe stored content type is served as an octet-stream attachment (never inline)', () => {
    const d = decideRetrieval({ role: 'manager' }, row({ contentType: 'text/html' }))
    expect(d).toEqual({ ok: true, pathname: 'business-receipts/deadbeef.jpg', contentType: 'application/octet-stream', disposition: 'attachment' })
  })
})
