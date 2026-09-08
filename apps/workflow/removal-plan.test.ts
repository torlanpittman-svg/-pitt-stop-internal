import { describe, it, expect } from 'vitest'
import {
  decideQbRemovalPlan, descriptionMatchesStock,
  planRequiresQbWrite, planBlocksRemoval, shouldSoftCancel,
  type RemovalLinkage, type QbInvoiceSnapshot, type QbSalesLine,
} from './removal-plan'

// The fail-closed brain of coordinated Work Board + QuickBooks removal. Pure — proves the exact
// QB action for every case without a live QuickBooks or database.

const dealerLink = (over: Partial<RemovalLinkage> = {}): RemovalLinkage => ({
  isDealer: true, hasQbLink: true, stockToken: '#K518991', storedLineId: null, ...over,
})
const retailLink = (over: Partial<RemovalLinkage> = {}): RemovalLinkage => ({
  isDealer: false, hasQbLink: true, stockToken: null, storedLineId: null, ...over,
})
const line = (id: string, description: string, amountCents = 20000): QbSalesLine => ({ id, description, amountCents })
const snap = (over: Partial<QbInvoiceSnapshot> = {}): QbInvoiceSnapshot => ({
  status: 'resolved', invoiceId: '42', invoiceNumber: '100810',
  totalCents: 20000, balanceCents: 20000, emailStatus: 'NotSet', voided: false, salesLines: [], ...over,
})

describe('CASE A — no QuickBooks link', () => {
  it('a Job that never reached QB → no_qb (soft-cancel only, no mutation)', () => {
    expect(decideQbRemovalPlan(dealerLink({ hasQbLink: false }), null)).toEqual({ kind: 'no_qb' })
    expect(decideQbRemovalPlan(retailLink({ hasQbLink: false }), null)).toEqual({ kind: 'no_qb' })
  })
})

describe('CASE B — one vehicle on a multi-vehicle dealer invoice', () => {
  const threeLines = [
    line('1', '2024 Toyota Camry Blue #A111'),   // legitimate
    line('2', '2024 Kia Sportage White #K518991'), // ACCIDENTAL (target)
    line('3', '2023 Ford F150 Black #C333'),      // legitimate
  ]
  it('removes ONLY the exact matching line; the other two are untouched', () => {
    const plan = decideQbRemovalPlan(dealerLink(), snap({ salesLines: threeLines }))
    expect(plan).toEqual({ kind: 'line_remove', invoiceId: '42', invoiceNumber: '100810', lineId: '2' })
  })
  it('the two legitimate lines never match the target stock token', () => {
    expect(descriptionMatchesStock('2024 Toyota Camry Blue #A111', '#K518991')).toBe(false)
    expect(descriptionMatchesStock('2023 Ford F150 Black #C333', '#K518991')).toBe(false)
  })
  it('a stored qb_line_id that AGREES is accepted', () => {
    const plan = decideQbRemovalPlan(dealerLink({ storedLineId: '2' }), snap({ salesLines: threeLines }))
    expect(plan.kind).toBe('line_remove')
  })
})

describe('CASE C — standalone dealer invoice (only that vehicle)', () => {
  it('a single matching sales line → void_standalone', () => {
    const plan = decideQbRemovalPlan(dealerLink(), snap({ salesLines: [line('9', 'Kia #K518991')] }))
    expect(plan).toEqual({ kind: 'void_standalone', invoiceId: '42', invoiceNumber: '100810' })
  })
  it('retail is always standalone → void_standalone (identity PSID-proven upstream)', () => {
    const plan = decideQbRemovalPlan(retailLink(), snap({ salesLines: [line('1', 'Labor'), line('2', 'Shop supplies')] }))
    expect(plan).toEqual({ kind: 'void_standalone', invoiceId: '42', invoiceNumber: '100810' })
  })
})

describe('AMBIGUOUS — never guess, fail closed (QB untouched, removal refused)', () => {
  it('stock token matches ZERO lines', () => {
    const plan = decideQbRemovalPlan(dealerLink(), snap({ salesLines: [line('1', 'Camry #A111')] }))
    expect(plan).toEqual({ kind: 'ambiguous', reason: 'stock_token_matched_0_lines' })
  })
  it('stock token matches MORE THAN ONE line', () => {
    const plan = decideQbRemovalPlan(dealerLink(), snap({ salesLines: [line('1', 'Kia #K518991'), line('2', 'Kia #K518991')] }))
    expect(plan).toEqual({ kind: 'ambiguous', reason: 'stock_token_matched_2_lines' })
  })
  it('a stored qb_line_id that DISAGREES with the matched line', () => {
    const plan = decideQbRemovalPlan(dealerLink({ storedLineId: '999' }), snap({ salesLines: [line('2', 'Kia #K518991')] }))
    expect(plan).toEqual({ kind: 'ambiguous', reason: 'stored_line_id_mismatch' })
  })
  it('dealer with no stock token at all', () => {
    expect(decideQbRemovalPlan(dealerLink({ stockToken: null }), snap({ salesLines: [line('1', 'x')] })))
      .toEqual({ kind: 'ambiguous', reason: 'no_stock_token' })
  })
  it('could not resolve exactly one invoice for the DocNumber', () => {
    expect(decideQbRemovalPlan(dealerLink(), snap({ status: 'ambiguous', ambiguousReason: '2_invoices_for_docnumber' })))
      .toEqual({ kind: 'ambiguous', reason: '2_invoices_for_docnumber' })
  })
  it('retail PSID mismatch is surfaced as ambiguous', () => {
    expect(decideQbRemovalPlan(retailLink(), snap({ status: 'ambiguous', ambiguousReason: 'psid_mismatch' })))
      .toEqual({ kind: 'ambiguous', reason: 'psid_mismatch' })
  })
})

describe('PAYMENT ACTIVITY — fail closed for every path', () => {
  it('a partially/fully paid invoice (balance < total) → blocked_paid, even multi-line', () => {
    const paid = snap({ balanceCents: 10000, totalCents: 20000, salesLines: [line('1', 'Kia #K518991'), line('2', 'Camry #A111')] })
    expect(decideQbRemovalPlan(dealerLink(), paid)).toEqual({ kind: 'blocked_paid', invoiceNumber: '100810', reason: 'payment_activity' })
  })
  it('a fully paid standalone (balance 0, total > 0) → blocked_paid (never void paid money)', () => {
    const paid = snap({ balanceCents: 0, totalCents: 20000, salesLines: [line('1', 'Kia #K518991')] })
    expect(decideQbRemovalPlan(dealerLink(), paid).kind).toBe('blocked_paid')
  })
})

describe('IDEMPOTENT — a retry recognises QB is already in the desired state', () => {
  it('already voided → idempotent_qb_done (proceed, no second mutation)', () => {
    expect(decideQbRemovalPlan(dealerLink(), snap({ voided: true, totalCents: 0, balanceCents: 0 })))
      .toEqual({ kind: 'idempotent_qb_done', invoiceNumber: '100810' })
  })
  it('invoice vanished from QB (not_found) → idempotent_qb_done', () => {
    expect(decideQbRemovalPlan(dealerLink(), snap({ status: 'not_found' })))
      .toEqual({ kind: 'idempotent_qb_done', invoiceNumber: '100810' })
  })
})

describe('descriptionMatchesStock — whole-token match only (no #12 ⊂ #123 bug)', () => {
  it('matches the exact token at a word boundary', () => {
    expect(descriptionMatchesStock('2024 Kia #K518991', '#K518991')).toBe(true)
    expect(descriptionMatchesStock('2024 Kia #K518991 Blue', '#k518991')).toBe(true) // case-insensitive
  })
  it('does not match a longer stock that merely starts the same', () => {
    expect(descriptionMatchesStock('Kia #123', '#12')).toBe(false)
    expect(descriptionMatchesStock('Kia #12', '#123')).toBe(false)
  })
})

describe('sequencing helpers — the atomicity rule in one place', () => {
  it('planRequiresQbWrite only for line_remove / void_standalone', () => {
    expect(planRequiresQbWrite({ kind: 'line_remove', invoiceId: '1', invoiceNumber: '1', lineId: '2' })).toBe(true)
    expect(planRequiresQbWrite({ kind: 'void_standalone', invoiceId: '1', invoiceNumber: '1' })).toBe(true)
    expect(planRequiresQbWrite({ kind: 'no_qb' })).toBe(false)
    expect(planRequiresQbWrite({ kind: 'idempotent_qb_done', invoiceNumber: '1' })).toBe(false)
  })
  it('planBlocksRemoval only for ambiguous / blocked_paid', () => {
    expect(planBlocksRemoval({ kind: 'ambiguous', reason: 'x' })).toBe(true)
    expect(planBlocksRemoval({ kind: 'blocked_paid', invoiceNumber: '1', reason: 'y' })).toBe(true)
    expect(planBlocksRemoval({ kind: 'no_qb' })).toBe(false)
    expect(planBlocksRemoval({ kind: 'line_remove', invoiceId: '1', invoiceNumber: '1', lineId: '2' })).toBe(false)
  })
  it('shouldSoftCancel: blocked never cancels; a required write must have succeeded; else proceed', () => {
    expect(shouldSoftCancel({ kind: 'ambiguous', reason: 'x' }, undefined)).toBe(false)
    expect(shouldSoftCancel({ kind: 'blocked_paid', invoiceNumber: '1', reason: 'y' }, undefined)).toBe(false)
    // required write, not yet confirmed / failed → do NOT cancel
    expect(shouldSoftCancel({ kind: 'void_standalone', invoiceId: '1', invoiceNumber: '1' }, undefined)).toBe(false)
    expect(shouldSoftCancel({ kind: 'void_standalone', invoiceId: '1', invoiceNumber: '1' }, false)).toBe(false)
    // required write confirmed → cancel
    expect(shouldSoftCancel({ kind: 'line_remove', invoiceId: '1', invoiceNumber: '1', lineId: '2' }, true)).toBe(true)
    // no write needed → cancel
    expect(shouldSoftCancel({ kind: 'no_qb' }, undefined)).toBe(true)
    expect(shouldSoftCancel({ kind: 'idempotent_qb_done', invoiceNumber: '1' }, undefined)).toBe(true)
  })
})
