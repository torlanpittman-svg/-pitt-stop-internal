import { describe, it, expect } from 'vitest'
import {
  parseCents, centsToDollars, categoryForLabel, isExpenseCategory, isBusinessEntity, isPaymentMethod,
  isReceiptStatus, isBusinessDate, isBusinessMonth, businessMonthOf, inBusinessMonth,
  canTransition, decideApproval, diffFields, auditEntry,
} from './types'

describe('parseCents — integer cents, never silently $0', () => {
  it('parses dollar strings and numbers to integer cents', () => {
    expect(parseCents('12.34')).toBe(1234)
    expect(parseCents('$1,250.00')).toBe(125000)
    expect(parseCents(9.99)).toBe(999)
    expect(parseCents('0.05')).toBe(5)
  })
  it('keeps missing/blank as null (never coerces to 0)', () => {
    expect(parseCents('')).toBeNull()
    expect(parseCents(null)).toBeNull()
    expect(parseCents(undefined)).toBeNull()
    expect(parseCents('abc')).toBeNull()
  })
  it('is rounding-safe and takes absolute value', () => {
    expect(parseCents('10.005')).toBe(1001) // rounds
    expect(parseCents('-42.00')).toBe(4200) // sign carried elsewhere
  })
  it('round-trips through centsToDollars', () => {
    expect(centsToDollars(1234)).toBe('12.34')
    expect(centsToDollars(null)).toBe('')
    expect(parseCents(centsToDollars(125000))).toBe(125000)
  })
})

describe('category mapping', () => {
  it('maps known labels and keys', () => {
    expect(categoryForLabel('Parts')).toBe('parts')
    expect(categoryForLabel('shop_supplies')).toBe('shop_supplies')
    expect(categoryForLabel('Fuel')).toBe('fuel')
  })
  it('routes free text into a coarse bucket without inventing an account', () => {
    expect(categoryForLabel('brake pads')).toBe('parts')
    expect(categoryForLabel('microfiber towels')).toBe('shop_supplies')
    expect(categoryForLabel('Adobe subscription')).toBe('office')
  })
  it('unknown / empty → uncategorized (stays flagged)', () => {
    expect(categoryForLabel('')).toBe('uncategorized')
    expect(categoryForLabel(null)).toBe('uncategorized')
    expect(categoryForLabel('zzz random')).toBe('other')
  })
})

describe('validators', () => {
  it('entity / category / payment / status guards', () => {
    expect(isBusinessEntity('detail')).toBe(true)
    expect(isBusinessEntity('nope')).toBe(false)
    expect(isExpenseCategory('parts')).toBe(true)
    expect(isExpenseCategory('parts_x')).toBe(false)
    expect(isPaymentMethod('card')).toBe(true)
    expect(isPaymentMethod('bitcoin')).toBe(false)
    expect(isReceiptStatus('needs_review')).toBe(true)
    expect(isReceiptStatus('weird')).toBe(false)
  })
})

describe('business dates/months — no UTC drift', () => {
  it('validates dates and months', () => {
    expect(isBusinessDate('2026-01-31')).toBe(true)
    expect(isBusinessDate('2026-13-01')).toBe(false)
    expect(isBusinessMonth('2026-02')).toBe(true)
    expect(isBusinessMonth('2026-2')).toBe(false)
  })
  it('month membership uses the plain calendar date (no timezone conversion)', () => {
    // A date at a month boundary must NOT drift into an adjacent month.
    expect(businessMonthOf('2026-01-31')).toBe('2026-01')
    expect(businessMonthOf('2026-02-01')).toBe('2026-02')
    expect(inBusinessMonth('2026-01-31', '2026-01')).toBe(true)
    expect(inBusinessMonth('2026-02-01', '2026-01')).toBe(false)
    expect(inBusinessMonth(null, '2026-01')).toBe(false)
  })
})

describe('status machine', () => {
  it('allows the manager decision transitions', () => {
    expect(canTransition('needs_review', 'approved')).toBe(true)
    expect(canTransition('needs_review', 'rejected')).toBe(true)
    expect(canTransition('processing_failed', 'needs_review')).toBe(true)
    expect(canTransition('approved', 'needs_review')).toBe(true) // reopen
    expect(canTransition('rejected', 'needs_review')).toBe(true) // reopen
  })
  it('is idempotent on same-state and blocks illegal jumps', () => {
    expect(canTransition('approved', 'approved')).toBe(true)
    expect(canTransition('rejected', 'approved')).toBe(false)
    expect(canTransition('approved', 'rejected')).toBe(false)
  })
})

describe('decideApproval — guard + idempotency', () => {
  it('approves a well-formed needs_review receipt', () => {
    expect(decideApproval('needs_review', 'detail', 1999)).toEqual({ action: 'approve' })
  })
  it('is idempotent when already approved', () => {
    expect(decideApproval('approved', 'detail', 1999)).toEqual({ action: 'noop_already_approved' })
  })
  it('blocks an unassigned business', () => {
    const d = decideApproval('needs_review', 'unassigned', 1999)
    expect(d.action).toBe('blocked')
  })
  it('blocks a missing or zero total (never books $0)', () => {
    expect(decideApproval('needs_review', 'detail', null).action).toBe('blocked')
    expect(decideApproval('needs_review', 'detail', 0).action).toBe('blocked')
  })
  it('blocks approving from a non-review status', () => {
    expect(decideApproval('rejected', 'detail', 1999).action).toBe('blocked')
  })
})

describe('audit trail helpers', () => {
  it('diffFields only reports changed fields', () => {
    const before = { vendor: 'A', totalCents: 100, category: 'parts' }
    const after = { vendor: 'B', totalCents: 100 }
    expect(diffFields(before, after)).toEqual({ vendor: { from: 'A', to: 'B' } })
  })
  it('diffFields returns undefined when nothing changed', () => {
    expect(diffFields({ a: 1 }, { a: 1 })).toBeUndefined()
  })
  it('auditEntry captures action + actor + changes', () => {
    const e = auditEntry('approved', 'Darryl', { totalCents: { from: 100, to: 200 } }, 'note')
    expect(e.action).toBe('approved')
    expect(e.actor).toBe('Darryl')
    expect(e.changes).toEqual({ totalCents: { from: 100, to: 200 } })
    expect(e.note).toBe('note')
    expect(typeof e.at).toBe('string')
  })
})
