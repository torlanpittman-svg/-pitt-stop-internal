import { describe, it, expect, vi, beforeEach } from 'vitest'

// The AI READ step (separate from save). Ownership is REAL (canFileReceipt); receiptUploaderFromRequest,
// db, ai, blob and image-decode are mocked. Verifies fail-closed ownership, a successful read fills the
// proposal, a provider failure is a RECOVERABLE 'failed' (not lost), and a busy claim is a safe 409.
vi.mock('@/apps/expenses/authz', async () => {
  const actual = await vi.importActual<typeof import('@/apps/expenses/authz')>('@/apps/expenses/authz')
  return { ...actual, receiptUploaderFromRequest: vi.fn() }
})
vi.mock('@/apps/expenses/db', () => ({
  getReceipt: vi.fn(),
  claimRetryExtraction: vi.fn(),
  applyRetryExtraction: vi.fn(async () => ({ ok: true })),
  releaseRetryClaim: vi.fn(async () => {}),
  possibleDuplicateFor: vi.fn(async () => null),
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
  RATE_LIMITS: { extractActor: { limit: 30, windowMs: 600000 }, extractReceipt: { limit: 10, windowMs: 3600000 } },
}))
vi.mock('@/apps/expenses/ai', () => ({ extractExpense: vi.fn() }))
vi.mock('@/platform/blob', () => ({ getPrivateBlob: vi.fn(async () => ({ bytes: Buffer.from('img'), contentType: 'image/jpeg' })) }))
vi.mock('@/apps/expenses/image-decode', () => ({ derivedForExtraction: vi.fn(async (b: Buffer) => ({ bytes: b, contentType: 'image/jpeg' })) }))

import { POST } from './route'
import { receiptUploaderFromRequest } from '@/apps/expenses/authz'
import * as db from '@/apps/expenses/db'
import { extractExpense } from '@/apps/expenses/ai'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const params = Promise.resolve({ id: 'rec-1' })
const req = (body: unknown = {}) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const EXTRACTION = { vendor: 'Costco', date: '2026-03-14', subtotalCents: null, taxCents: null, totalCents: 44672, categoryLabel: null, categoryKey: 'shop_supplies', description: 'towels', paymentMethod: null, cardBrand: null, paymentLast4: null, accountEnding: null, receiptNumber: null, present: { vendor: true, date: true, total: true, category: true } }

beforeEach(() => {
  vi.clearAllMocks()
  asMock(receiptUploaderFromRequest).mockResolvedValue({ actor: { key: 'darryl', name: 'Darryl', role: 'manager' }, name: 'Darryl' })
  asMock(db.getReceipt).mockResolvedValue({ id: 'rec-1', uploadedByKey: 'darryl', storageRef: 'business-receipts/x.jpg', aiStatus: 'pending' })
  asMock(db.claimRetryExtraction).mockResolvedValue({ ok: true, row: { id: 'rec-1', storageRef: 'business-receipts/x.jpg' }, token: 'tok' })
  asMock(db.applyRetryExtraction).mockResolvedValue({ ok: true })
  asMock(extractExpense).mockResolvedValue({ status: 'extracted', model: 'gpt-4o', raw: {}, extraction: EXTRACTION })
})

describe('extract route', () => {
  it('anonymous is fail-closed (401)', async () => {
    asMock(receiptUploaderFromRequest).mockResolvedValue(null)
    const res = await POST(req(), { params })
    expect(res.status).toBe(401)
    expect(asMock(extractExpense)).not.toHaveBeenCalled()
  })

  it('a non-owner without a token is rejected (403) — no AI', async () => {
    asMock(receiptUploaderFromRequest).mockResolvedValue({ actor: { key: 'someone', name: 'X', role: 'employee' }, name: 'X' })
    asMock(db.getReceipt).mockResolvedValue({ id: 'rec-1', uploadedByKey: 'darryl', storageRef: 's', aiStatus: 'pending' })
    const res = await POST(req(), { params })
    expect(res.status).toBe(403)
    expect(asMock(extractExpense)).not.toHaveBeenCalled()
  })

  it('a successful read fills vendor/date/total and returns the proposal', async () => {
    const res = await POST(req(), { params })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true); expect(j.aiStatus).toBe('extracted')
    expect(j.proposal.vendor).toBe('Costco'); expect(j.proposal.totalCents).toBe(44672)
    expect(asMock(db.applyRetryExtraction)).toHaveBeenCalled()
  })

  it('the deterministic payment-source match is returned in the proposal (auto-select), null when unresolved', async () => {
    // Card evidence identifying AMB ••0022 → the client pre-selects that bubble.
    asMock(extractExpense).mockResolvedValue({ status: 'extracted', model: 'gpt-4o', raw: {}, extraction: { ...EXTRACTION, paymentMethod: 'card', cardBrand: 'mastercard', paymentLast4: '0022' } })
    let j = await (await POST(req(), { params })).json()
    expect(j.proposal.paymentChoice).toBe('amb_debit_0022')
    // A check alone can't identify the bank → no auto-select.
    asMock(extractExpense).mockResolvedValue({ status: 'extracted', model: 'gpt-4o', raw: {}, extraction: { ...EXTRACTION, paymentMethod: 'check', cardBrand: null, paymentLast4: null } })
    j = await (await POST(req(), { params })).json()
    expect(j.proposal.paymentChoice).toBeNull()
  })

  it('a provider FAILURE is recoverable: aiStatus=failed, the receipt is not lost', async () => {
    asMock(extractExpense).mockResolvedValue({ status: 'failed', model: null, raw: { error: 'timeout' }, extraction: { ...EXTRACTION, vendor: null, date: null, totalCents: null, present: {} } })
    const res = await POST(req(), { params })
    const j = await res.json()
    expect(j.aiStatus).toBe('failed')
    expect(asMock(db.applyRetryExtraction)).toHaveBeenCalled() // still recorded on the saved row
  })

  it('a busy claim is a safe 409 (no second AI call)', async () => {
    asMock(db.claimRetryExtraction).mockResolvedValue({ ok: false, busy: true, error: 'busy' })
    const res = await POST(req(), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).busy).toBe(true)
    expect(asMock(extractExpense)).not.toHaveBeenCalled()
  })

  it('an already-read receipt returns its proposal WITHOUT another AI call (resume)', async () => {
    asMock(db.getReceipt).mockResolvedValue({ id: 'rec-1', uploadedByKey: 'darryl', storageRef: 's', aiStatus: 'extracted', vendor: 'Costco', receiptDate: '2026-03-14', totalCents: 44672, category: 'shop_supplies', confidence: { vendor: true } })
    const res = await POST(req(), { params })
    const j = await res.json()
    expect(j.aiStatus).toBe('extracted'); expect(j.proposal.totalCents).toBe(44672)
    expect(asMock(db.claimRetryExtraction)).not.toHaveBeenCalled()
    expect(asMock(extractExpense)).not.toHaveBeenCalled()
  })
})
