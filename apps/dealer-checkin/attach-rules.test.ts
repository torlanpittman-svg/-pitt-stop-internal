import { describe, it, expect } from 'vitest'
import {
  canLinkInvoice,
  parseStockFromNotes,
  resolveDealerForOrder,
  findStockLineInvoice,
  mapInvoiceStatus,
  decideAttachAction,
} from './attach-rules'

const DEALERS = [
  { stockPrefix: 'U',  name: 'Sterling Subaru' },
  { stockPrefix: 'K',  name: 'Sterling Kia' },
  { stockPrefix: 'S',  name: 'Sterling Auto Group' },
  { stockPrefix: 'AP', name: 'Purdy Mazda' },
]

describe('canLinkInvoice (environment guard)', () => {
  it('blocks sandbox QB from linking to a production job', () => {
    const r = canLinkInvoice('sandbox')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/sandbox/i)
  })
  it('allows production', () => {
    expect(canLinkInvoice('production').ok).toBe(true)
  })
  it('allows sandbox only with the explicit test override', () => {
    expect(canLinkInvoice('sandbox', true).ok).toBe(true)
  })
})

describe('parseStockFromNotes (manual / board entry)', () => {
  it('reads the stock token the board/check-in flow writes', () => {
    expect(parseStockFromNotes('Stock: U685978 | Sterling Subaru | Manual board-only entry (no invoice)')).toBe('U685978')
  })
  it('handles the normal check-in note format', () => {
    expect(parseStockFromNotes('Stock: K1234 | Invoice: 1077 | Sterling Kia')).toBe('K1234')
  })
  it('returns null when absent or a placeholder', () => {
    expect(parseStockFromNotes('Quick Entry · Parri Clayton · Mini Detail')).toBeNull()
    expect(parseStockFromNotes('Stock: n/a | Sterling Subaru')).toBeNull()
    expect(parseStockFromNotes(null)).toBeNull()
    expect(parseStockFromNotes('')).toBeNull()
  })
})

describe('resolveDealerForOrder', () => {
  it('resolves by stock prefix (same as normal intake)', () => {
    expect(resolveDealerForOrder({ stock: 'U685978', customerName: null }, DEALERS)?.name).toBe('Sterling Subaru')
  })
  it('prefers the longest prefix match', () => {
    expect(resolveDealerForOrder({ stock: 'AP55', customerName: null }, DEALERS)?.name).toBe('Purdy Mazda')
  })
  it('falls back to exact customer-name match when stock is missing', () => {
    expect(resolveDealerForOrder({ stock: null, customerName: 'Sterling Subaru' }, DEALERS)?.name).toBe('Sterling Subaru')
  })
  it('returns null when neither resolves', () => {
    expect(resolveDealerForOrder({ stock: 'Z9', customerName: 'Unknown Lot' }, DEALERS)).toBeNull()
  })
})

describe('findStockLineInvoice (recovery + duplicate detection)', () => {
  const invoices = [
    { id: 'i1', docNumber: '1050', descriptions: ['2022 Honda Civic Blue #K1111'] },
    { id: 'i2', docNumber: '1051', descriptions: ['2026 Tesla Model Y White #U685978', '2024 Kia Soul #K2222'] },
  ]
  it('recovers the invoice already carrying the stock line (prevents double charge)', () => {
    expect(findStockLineInvoice('U685978', invoices)?.docNumber).toBe('1051')
  })
  it('is case- and space-insensitive on the stock token', () => {
    expect(findStockLineInvoice('  u685978 ', invoices)?.id).toBe('i2')
  })
  it('returns null when the stock is not on any invoice (safe to write)', () => {
    expect(findStockLineInvoice('U999999', invoices)).toBeNull()
  })
  it('returns null for a missing stock', () => {
    expect(findStockLineInvoice(null, invoices)).toBeNull()
  })
})

describe('mapInvoiceStatus', () => {
  it('none when there is no scan', () => {
    expect(mapInvoiceStatus(null)).toBe('none')
  })
  it('linked when synced with a number', () => {
    expect(mapInvoiceStatus({ qbInvoiceNumber: '1051', qbSyncStatus: 'synced' })).toBe('linked')
  })
  it('queued and failed map to retryable states', () => {
    expect(mapInvoiceStatus({ qbInvoiceNumber: null, qbSyncStatus: 'queued' })).toBe('queued')
    expect(mapInvoiceStatus({ qbInvoiceNumber: null, qbSyncStatus: 'error' })).toBe('failed')
  })
  it('pending otherwise', () => {
    expect(mapInvoiceStatus({ qbInvoiceNumber: null, qbSyncStatus: null })).toBe('pending')
  })
})

describe('decideAttachAction', () => {
  it('appends when an eligible invoice exists, else creates', () => {
    expect(decideAttachAction(true)).toBe('appended')
    expect(decideAttachAction(false)).toBe('created')
  })
})
