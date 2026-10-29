import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeProposals } from './import-ai'
import { EMPTY_PROPOSAL, type ImportProposal } from './import-normalize'

function proposal(over: Partial<ImportProposal>): ImportProposal {
  return { ...EMPTY_PROPOSAL, rows: [], ...over }
}

describe('mergeProposals — agreement kept, disagreement flagged (never first-wins)', () => {
  it('keeps a field when all pages agree', () => {
    const m = mergeProposals([
      { imageId: 'a', proposal: proposal({ supplier: 'NAPA', orderReference: 'INV-1', documentKind: 'purchase' }) },
      { imageId: 'b', proposal: proposal({ supplier: 'NAPA', orderReference: 'INV-1', documentKind: 'purchase' }) },
    ])
    expect(m.supplier).toBe('NAPA')
    expect(m.orderReference).toBe('INV-1')
    expect(m.documentKind).toBe('purchase')
    expect(m.conflicts).toEqual({ supplier: false, orderReference: false, documentKind: false })
  })
  it('nulls a disagreeing field and flags the conflict (not first-wins)', () => {
    const m = mergeProposals([
      { imageId: 'a', proposal: proposal({ supplier: 'NAPA', documentKind: 'purchase' }) },
      { imageId: 'b', proposal: proposal({ supplier: "O'Reilly", documentKind: 'quote' }) },
    ])
    expect(m.supplier).toBeNull()
    expect(m.documentKind).toBe('unknown')
    expect(m.conflicts.supplier).toBe(true)
    expect(m.conflicts.documentKind).toBe(true)
  })
  it('concatenates rows tagged with their source image', () => {
    const m = mergeProposals([
      { imageId: 'a', proposal: proposal({ rows: [{ description: 'Rotor', partNumber: null, brand: null, supplier: null, quantity: 1, unitCostCents: 100, listPriceCents: null, lineTotalCents: null }] }) },
      { imageId: 'b', proposal: proposal({ rows: [{ description: 'Pads', partNumber: null, brand: null, supplier: null, quantity: 2, unitCostCents: 200, listPriceCents: null, lineTotalCents: null }] }) },
    ])
    expect(m.rows.map((r) => r.sourceImageId)).toEqual(['a', 'b'])
    expect(m.rows.map((r) => r.description)).toEqual(['Rotor', 'Pads'])
  })
})

describe('extractPartsImport — fail-closed, never throws', () => {
  const OLD = process.env.OPENAI_API_KEY
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { if (OLD === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = OLD; vi.restoreAllMocks() })

  it('returns failed + empty proposal with no API key (no network)', async () => {
    delete process.env.OPENAI_API_KEY
    const { extractPartsImport } = await import('./import-ai')
    const r = await extractPartsImport('AAAA', 'image/jpeg')
    expect(r.status).toBe('failed')
    expect(r.proposal.rows).toHaveLength(0)
    expect(r.raw).toEqual({ error: 'OPENAI_API_KEY not set' })
  })

  it('parses a mocked model response into a validated proposal', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: async () => ({
          model: 'gpt-4o-mock',
          choices: [{ message: { content: JSON.stringify({ documentKind: 'purchase', supplier: 'NAPA', orderReference: 'INV-9', lineItems: [{ description: 'Rotor', unitCost: 42.15, quantity: 2, listPrice: 88.99 }] }) } }],
        }) } }
      },
    }))
    const { extractPartsImport } = await import('./import-ai')
    const r = await extractPartsImport('AAAA', 'image/jpeg')
    expect(r.status).toBe('extracted')
    expect(r.proposal.documentKind).toBe('purchase')
    expect(r.proposal.rows[0].unitCostCents).toBe(4215)
    expect(r.proposal.rows[0].listPriceCents).toBe(8899)
    expect(r.proposal.rows[0].quantity).toBe(2)
  })

  it('a non-JSON model response degrades to failed (recoverable), never throws', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    vi.doMock('openai', () => ({
      default: class { chat = { completions: { create: async () => ({ model: 'm', choices: [{ message: { content: 'sorry, I cannot read this' } }] }) } } },
    }))
    const { extractPartsImport } = await import('./import-ai')
    const r = await extractPartsImport('AAAA', 'image/jpeg')
    expect(r.status).toBe('failed')
    expect(r.raw).toEqual({ error: 'extract_failed' })
  })
})
