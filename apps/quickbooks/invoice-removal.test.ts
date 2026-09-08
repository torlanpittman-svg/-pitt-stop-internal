import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock the low-level QB client so we can exercise the removal I/O (snapshot reads, surgical line
// removal, void) deterministically — no real QuickBooks, no network.
vi.mock('./client', () => ({
  qbApiRequest: vi.fn(),
  queryQBO: vi.fn(),
  qboEscape: (s: string) => s.replace(/'/g, "\\'"),
}))

import { qbApiRequest, queryQBO } from './client'
import {
  readDealerInvoiceSnapshot, readRetailInvoiceSnapshot, removeInvoiceLine, voidInvoice,
} from './invoice-removal'

const mockReq = qbApiRequest as unknown as ReturnType<typeof vi.fn>
const mockQuery = queryQBO as unknown as ReturnType<typeof vi.fn>

const salesLine = (id: string, description: string, amount = 200) => ({
  Id: id, DetailType: 'SalesItemLineDetail', Amount: amount, Description: description,
})

beforeEach(() => { mockReq.mockReset(); mockQuery.mockReset() })

describe('readDealerInvoiceSnapshot — resolve exactly one invoice by DocNumber', () => {
  it('one match → resolved snapshot with mapped sales lines + amounts in cents', async () => {
    mockQuery.mockResolvedValue({ Invoice: [{ Id: '42', DocNumber: '100810', SyncToken: '3', TotalAmt: 400, Balance: 400, Line: [salesLine('1', 'Kia #K1'), salesLine('2', 'Camry #A2')] }] })
    const s = await readDealerInvoiceSnapshot('100810')
    expect(s.status).toBe('resolved')
    expect(s.invoiceId).toBe('42')
    expect(s.totalCents).toBe(40000)
    expect(s.balanceCents).toBe(40000)
    expect(s.salesLines).toEqual([
      { id: '1', description: 'Kia #K1', amountCents: 20000 },
      { id: '2', description: 'Camry #A2', amountCents: 20000 },
    ])
  })
  it('zero matches → not_found (idempotent: invoice already gone)', async () => {
    mockQuery.mockResolvedValue({ Invoice: [] })
    expect((await readDealerInvoiceSnapshot('100810')).status).toBe('not_found')
  })
  it('more than one match → ambiguous (fail closed)', async () => {
    mockQuery.mockResolvedValue({ Invoice: [{ Id: '1', SyncToken: '0' }, { Id: '2', SyncToken: '0' }] })
    expect((await readDealerInvoiceSnapshot('100810')).status).toBe('ambiguous')
  })
})

describe('readRetailInvoiceSnapshot — PSID identity proof', () => {
  it('PrivateNote PSID matches the estimate id → resolved', async () => {
    mockQuery.mockResolvedValue({ Invoice: [{ Id: '7', DocNumber: '200', SyncToken: '1', TotalAmt: 150, Balance: 150, PrivateNote: 'PSID:11111111-1111-1111-1111-111111111111', Line: [salesLine('1', 'Labor', 150)] }] })
    expect((await readRetailInvoiceSnapshot('7', '11111111-1111-1111-1111-111111111111')).status).toBe('resolved')
  })
  it('PSID mismatch → ambiguous (never void an invoice we cannot prove is ours)', async () => {
    mockQuery.mockResolvedValue({ Invoice: [{ Id: '7', SyncToken: '1', PrivateNote: 'PSID:99999999-9999-9999-9999-999999999999' }] })
    expect((await readRetailInvoiceSnapshot('7', '11111111-1111-1111-1111-111111111111')).status).toBe('ambiguous')
  })
  it('invoice gone → not_found', async () => {
    mockQuery.mockResolvedValue({ Invoice: [] })
    expect((await readRetailInvoiceSnapshot('7', 'x')).status).toBe('not_found')
  })
})

describe('removeInvoiceLine — surgical, preserves other lines, idempotent, refuses last line', () => {
  it('removes ONLY the target line; the other two are posted back unchanged', async () => {
    const invoice = { Id: '42', DocNumber: '100810', SyncToken: '3', TotalAmt: 600, Balance: 600, Line: [salesLine('1', 'Camry #A1'), salesLine('2', 'Kia #K2'), salesLine('3', 'Ford #C3')] }
    let postedBody: any = null
    mockReq.mockImplementation(async (opts: any) => {
      if (!opts.method || opts.method === 'GET') return { Invoice: invoice }
      postedBody = opts.body
      return { Invoice: { ...invoice, Line: opts.body.Line, TotalAmt: 400, SyncToken: '4' } }
    })
    const r = await removeInvoiceLine({ invoiceId: '42', lineId: '2' })
    expect(r.ok).toBe(true)
    const ids = postedBody.Line.map((l: any) => l.Id)
    expect(ids).toEqual(['1', '3'])                 // target '2' gone, others preserved
    expect(postedBody.sparse).toBe(false)
    expect(r.totalCentsBefore).toBe(60000)
    expect(r.totalCentsAfter).toBe(40000)
  })
  it('target line already absent → idempotent success, NO write', async () => {
    const invoice = { Id: '42', SyncToken: '3', TotalAmt: 400, Line: [salesLine('1', 'A'), salesLine('3', 'C')] }
    const post = vi.fn()
    mockReq.mockImplementation(async (opts: any) => {
      if (!opts.method || opts.method === 'GET') return { Invoice: invoice }
      post(); return { Invoice: invoice }
    })
    const r = await removeInvoiceLine({ invoiceId: '42', lineId: '2' })
    expect(r).toMatchObject({ ok: true, idempotent: true })
    expect(post).not.toHaveBeenCalled()
  })
  it('refuses to remove the LAST line (that is the void case)', async () => {
    const invoice = { Id: '42', SyncToken: '3', TotalAmt: 200, Line: [salesLine('2', 'Kia #K2')] }
    mockReq.mockImplementation(async () => ({ Invoice: invoice }))
    const r = await removeInvoiceLine({ invoiceId: '42', lineId: '2' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/void/)
  })
})

describe('voidInvoice — operation=void, idempotent', () => {
  it('not yet voided → POSTs operation=void with Id + SyncToken only', async () => {
    const invoice = { Id: '42', DocNumber: '100810', SyncToken: '3', TotalAmt: 200, Balance: 200, Line: [salesLine('1', 'Kia #K1')] }
    let postOpts: any = null
    mockReq.mockImplementation(async (opts: any) => {
      if (!opts.method || opts.method === 'GET') return { Invoice: invoice }
      postOpts = opts
      return { Invoice: { ...invoice, TotalAmt: 0, Balance: 0, PrivateNote: 'Voided', SyncToken: '4' } }
    })
    const r = await voidInvoice({ invoiceId: '42' })
    expect(r.ok).toBe(true)
    expect(postOpts.query).toEqual({ operation: 'void' })
    expect(postOpts.body).toEqual({ Id: '42', SyncToken: '3' })
    expect(r.totalCentsBefore).toBe(20000)
  })
  it('already voided → idempotent success, NO second void', async () => {
    const invoice = { Id: '42', SyncToken: '9', TotalAmt: 0, Balance: 0, PrivateNote: 'Voided.' }
    const post = vi.fn()
    mockReq.mockImplementation(async (opts: any) => {
      if (!opts.method || opts.method === 'GET') return { Invoice: invoice }
      post(); return { Invoice: invoice }
    })
    const r = await voidInvoice({ invoiceId: '42' })
    expect(r).toMatchObject({ ok: true, idempotent: true })
    expect(post).not.toHaveBeenCalled()
  })
})
