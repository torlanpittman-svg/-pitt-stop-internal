/**
 * Employee OPERATIONAL FILING — pure decision + capability-token + ownership tests (no DB, deterministic).
 *
 * Covers the product rules: a complete ordinary receipt files immediately; missing info / mixed categories /
 * personal money / unpaid / unsure all SAVE-but-flag (never trap); the ceramic-coating example needs no
 * vehicle; the capture token authorizes only its own receipt; ownership fails closed for a foreign id.
 */
import { describe, it, expect } from 'vitest'
import { decideFiling, categoryChoiceFrom, canAcknowledgeOutstanding, isOutstandingReason, outstandingKindLabel, type FilingAnswers } from './types'
import { signCaptureToken, verifyCaptureToken } from './capture-token'
import { canFileReceipt } from './authz'
import type { AuthedActor } from '@/apps/auth/employee-session'

const complete = (over: Partial<FilingAnswers> = {}): FilingAnswers => ({
  entity: 'detail',
  category: { kind: 'single', key: 'shop_supplies' },
  funding: 'business',
  paymentMethod: 'card',
  vendor: 'O’Reilly Auto Parts',
  receiptDate: '2026-09-16',
  totalCents: 4599,
  ...over,
})

describe('decideFiling — clean filing', () => {
  it('a complete ordinary receipt files immediately (no reasons)', () => {
    const d = decideFiling(complete())
    expect(d.status).toBe('filed')
    expect(d.reasons).toEqual([])
    expect(d.category).toBe('shop_supplies')
    expect(d.paymentMethod).toBe('card')
  })

  it('the ceramic-coating example (Detail → Detailing supplies → Business card) needs no vehicle', () => {
    // Detailing supplies maps to the existing shop-supplies bucket; no vehicle is involved.
    const d = decideFiling(complete({ category: { kind: 'single', key: 'shop_supplies' } }))
    expect(d.status).toBe('filed')
    expect(d.category).toBe('shop_supplies')
  })

  it('business cash keeps the instrument', () => {
    const d = decideFiling(complete({ funding: 'business', paymentMethod: 'cash' }))
    expect(d.status).toBe('filed')
    expect(d.paymentMethod).toBe('cash')
  })
})

describe('decideFiling — exceptions save but flag (never trap)', () => {
  it('missing total → needs_review, missing_info', () => {
    const d = decideFiling(complete({ totalCents: null }))
    expect(d.status).toBe('needs_review')
    expect(d.reasons).toContain('missing_info')
  })
  it('missing vendor and date → needs_review, missing_info (deduped once)', () => {
    const d = decideFiling(complete({ vendor: '', receiptDate: null }))
    expect(d.status).toBe('needs_review')
    expect(d.reasons.filter((r) => r === 'missing_info')).toHaveLength(1)
  })
  it('mixed categories → uncategorized + mixed_category (never dumps the total into one guess)', () => {
    const d = decideFiling(complete({ category: { kind: 'mixed' } }))
    expect(d.status).toBe('needs_review')
    expect(d.category).toBe('uncategorized')
    expect(d.reasons).toContain('mixed_category')
  })
  it('other / not sure → uncategorized + unclear_category', () => {
    const d = decideFiling(complete({ category: { kind: 'unsure' } }))
    expect(d.status).toBe('needs_review')
    expect(d.category).toBe('uncategorized')
    expect(d.reasons).toContain('unclear_category')
  })
  it('personal money → personal_reimbursement and NO business payment instrument', () => {
    const d = decideFiling(complete({ funding: 'personal', paymentMethod: null }))
    expect(d.status).toBe('needs_review')
    expect(d.reasons).toContain('personal_reimbursement')
    expect(d.paymentMethod).toBeNull()
  })
  it('not paid yet → unpaid and no instrument', () => {
    const d = decideFiling(complete({ funding: 'unpaid', paymentMethod: null }))
    expect(d.status).toBe('needs_review')
    expect(d.reasons).toContain('unpaid')
    expect(d.paymentMethod).toBeNull()
  })
  it('business chosen without a method → missing_info (never inferred)', () => {
    const d = decideFiling(complete({ funding: 'business', paymentMethod: null }))
    expect(d.status).toBe('needs_review')
    expect(d.reasons).toContain('missing_info')
  })
  it('business not chosen → missing_business', () => {
    const d = decideFiling(complete({ entity: 'unassigned' }))
    expect(d.status).toBe('needs_review')
    expect(d.reasons).toContain('missing_business')
  })
  it('an unresolved duplicate → duplicate reason', () => {
    const d = decideFiling(complete({ duplicate: true }))
    expect(d.status).toBe('needs_review')
    expect(d.reasons).toContain('duplicate')
  })
  it('a $0 total is not a valid purchase total', () => {
    expect(decideFiling(complete({ totalCents: 0 })).reasons).toContain('missing_info')
  })
})

describe('acknowledge-outstanding classification (manager resolution)', () => {
  it('personal / unpaid / mixed are the only acknowledgeable outstanding reasons', () => {
    expect(isOutstandingReason('personal_reimbursement')).toBe(true)
    expect(isOutstandingReason('unpaid')).toBe(true)
    expect(isOutstandingReason('mixed_category')).toBe(true)
    expect(isOutstandingReason('missing_info')).toBe(false)
    expect(isOutstandingReason('unclear_category')).toBe(false)
    expect(isOutstandingReason('duplicate')).toBe(false)
  })
  it('canAcknowledge only when EVERY reason is outstanding (never to hide a fixable gap)', () => {
    expect(canAcknowledgeOutstanding(['personal_reimbursement'])).toBe(true)
    expect(canAcknowledgeOutstanding(['unpaid', 'mixed_category'])).toBe(true)
    expect(canAcknowledgeOutstanding(['personal_reimbursement', 'missing_info'])).toBe(false) // must fix first
    expect(canAcknowledgeOutstanding([])).toBe(false)
  })
  it('outstandingKindLabel names the still-open item', () => {
    expect(outstandingKindLabel(['personal_reimbursement'])).toContain('reimbursement')
    expect(outstandingKindLabel(['unpaid'])).toContain('payment')
    expect(outstandingKindLabel(['mixed_category'])).toContain('allocation')
  })
})

describe('categoryChoiceFrom', () => {
  it('maps modes to choices', () => {
    expect(categoryChoiceFrom('mixed', undefined)).toEqual({ kind: 'mixed' })
    expect(categoryChoiceFrom('unsure', undefined)).toEqual({ kind: 'unsure' })
    expect(categoryChoiceFrom('single', 'parts')).toEqual({ kind: 'single', key: 'parts' })
    expect(categoryChoiceFrom(undefined, 'bogus')).toEqual({ kind: 'single', key: 'uncategorized' })
  })
})

describe('capture token — bound to one receipt id', () => {
  it('verifies for its own id and rejects a different id / garbage / empty', () => {
    const t = signCaptureToken('rcpt-abc')
    expect(verifyCaptureToken(t, 'rcpt-abc')).toBe(true)
    expect(verifyCaptureToken(t, 'rcpt-xyz')).toBe(false)
    expect(verifyCaptureToken('nonsense', 'rcpt-abc')).toBe(false)
    expect(verifyCaptureToken('', 'rcpt-abc')).toBe(false)
    expect(verifyCaptureToken(undefined, 'rcpt-abc')).toBe(false)
  })
  it('rejects an expired token', () => {
    const t = signCaptureToken('rcpt-abc', -1000) // already expired
    expect(verifyCaptureToken(t, 'rcpt-abc')).toBe(false)
  })
})

describe('canFileReceipt — fail-closed ownership', () => {
  const manager: AuthedActor = { key: 'darryl', name: 'Darryl', role: 'manager' }
  const employee: AuthedActor = { key: 'sam', name: 'Sam', role: 'employee' }
  const other: AuthedActor = { key: 'lee', name: 'Lee', role: 'employee' }
  const row = { id: 'r1', uploadedByKey: 'sam' }

  it('a manager may file anything', () => {
    expect(canFileReceipt(manager, { id: 'r1', uploadedByKey: null }, null)).toBe(true)
  })
  it('the uploader (key match) may file their own', () => {
    expect(canFileReceipt(employee, row, null)).toBe(true)
  })
  it('a valid capture token authorizes filing (e.g. a shared-PIN device)', () => {
    const tok = signCaptureToken('r1')
    expect(canFileReceipt(null, { id: 'r1', uploadedByKey: null }, tok)).toBe(true)
  })
  it('a different employee with no token cannot file a foreign receipt', () => {
    expect(canFileReceipt(other, row, null)).toBe(false)
  })
  it('anonymous with no token cannot file', () => {
    expect(canFileReceipt(null, row, null)).toBe(false)
  })
  it('a token for a DIFFERENT receipt does not authorize this one', () => {
    const tok = signCaptureToken('other-receipt')
    expect(canFileReceipt(other, row, tok)).toBe(false)
  })
})
