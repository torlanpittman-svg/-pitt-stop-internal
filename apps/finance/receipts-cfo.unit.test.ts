/**
 * CFO × Receipts — PURE match-scoring tests (no DB). Guarantees the reconciliation SUGGESTION signal is
 * honest: equal amounts alone are at most 'possible' (never 'strong', never auto-linked); 'strong' needs an
 * exact amount + a close date + a vendor/name overlap; a receipt with no amount matches nothing.
 */
import { describe, it, expect } from 'vitest'
import { scoreCandidate, rankCandidates, daysBetween, amountToleranceCents } from './receipts-cfo'

const txn = (over: Partial<{ id: string; amountCents: number; txnDate: string; name: string | null; merchantName: string | null }> = {}) => ({
  id: 't1', amountCents: 4599, txnDate: '2026-01-16', name: null, merchantName: 'O’Reilly Auto Parts', ...over,
})

describe('daysBetween', () => {
  it('counts whole days and is null for invalid dates', () => {
    expect(daysBetween('2026-01-10', '2026-01-16')).toBe(6)
    expect(daysBetween('2026-01-16', '2026-01-10')).toBe(6)
    expect(daysBetween(null, '2026-01-10')).toBeNull()
    expect(daysBetween('not-a-date', '2026-01-10')).toBeNull()
  })
})

describe('scoreCandidate', () => {
  const receipt = { totalCents: 4599, receiptDate: '2026-01-15', vendor: 'O’Reilly Auto Parts' }

  it('exact amount + close date + name overlap → strong', () => {
    const s = scoreCandidate(receipt, txn())
    expect(s.strength).toBe('strong')
    expect(s.amountDeltaCents).toBe(0)
    expect(s.nameOverlap).toBe(true)
  })

  it('equal amount but NO name overlap → only possible (never strong; no silent link on amount alone)', () => {
    const s = scoreCandidate(receipt, txn({ merchantName: 'Some Unrelated Store', name: null }))
    expect(s.amountDeltaCents).toBe(0)
    expect(s.strength).toBe('possible')
  })

  it('exact amount + name but a far date → possible, not strong', () => {
    const s = scoreCandidate(receipt, txn({ txnDate: '2026-01-27' })) // 12 days apart
    expect(s.strength).toBe('possible')
  })

  it('within tolerance amount → possible', () => {
    const s = scoreCandidate(receipt, txn({ amountCents: 4599 + amountToleranceCents(4599) }))
    expect(s.strength).toBe('possible')
  })

  it('amount far outside tolerance → none', () => {
    const s = scoreCandidate(receipt, txn({ amountCents: 9999 }))
    expect(s.strength).toBe('none')
  })

  it('a receipt with no/zero total matches nothing', () => {
    expect(scoreCandidate({ totalCents: null, receiptDate: '2026-01-15', vendor: 'x' }, txn()).strength).toBe('none')
    expect(scoreCandidate({ totalCents: 0, receiptDate: '2026-01-15', vendor: 'x' }, txn()).strength).toBe('none')
  })
})

describe('rankCandidates', () => {
  const receipt = { totalCents: 4599, receiptDate: '2026-01-15', vendor: 'O’Reilly Auto Parts' }
  it('orders strong before possible, filters none, caps to the limit', () => {
    const cands = [
      txn({ id: 'far', amountCents: 9999 }),                                  // none
      txn({ id: 'possible', merchantName: 'Unrelated', amountCents: 4599 }),  // possible
      txn({ id: 'strong', amountCents: 4599, txnDate: '2026-01-15' }),        // strong
    ]
    const ranked = rankCandidates(receipt, cands, 5)
    expect(ranked.map((r) => r.txnId)).toEqual(['strong', 'possible'])
    expect(rankCandidates(receipt, cands, 1).map((r) => r.txnId)).toEqual(['strong'])
  })
})
