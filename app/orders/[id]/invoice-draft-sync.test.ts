/**
 * Coordination rules for the shared Invoice Draft / estimate totals that re-read in place (no remount)
 * after an item edit. These guard against the regressions introduced by that change:
 *  - a slow earlier read overwriting a newer fee draft when responses resolve out of order;
 *  - Create / Sync / Send / fee controls staying live while a refresh or an editor save is running;
 *  - a FAILED totals refresh leaving the old total showing as current/actionable (must fail closed); and
 *  - a confirmed action (Send / Choose customer) running while no current draft is loaded.
 */
import { describe, it, expect } from 'vitest'
import { createDraftSequencer, invoiceActionsLocked, estimateActionsLocked, interpretDraftResponse, draftActionReady } from './invoice-draft-sync'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('createDraftSequencer — only the latest read may write the draft', () => {
  it('a stale earlier response cannot overwrite a newer fee draft (out-of-order resolution)', async () => {
    const seq = createDraftSequencer()
    let applied: string | null = null
    // Each "read" captures a token when it STARTS and may apply only if it is still the latest.
    const read = (value: string, resolveMs: number) => {
      const token = seq.begin()
      return delay(resolveMs).then(() => { if (seq.isCurrent(token)) applied = value })
    }
    // A slow in-place refresh starts first; the user then removes a fee (a newer, faster read).
    const slowRefresh = read('stale-refresh', 40)
    const freshFee = read('fresh-fee', 5)
    await Promise.all([slowRefresh, freshFee])
    // The fee draft is newest and must stand even though the refresh resolved last.
    expect(applied).toBe('fresh-fee')
  })

  it('the most recently started read always wins, regardless of which resolves first', async () => {
    const seq = createDraftSequencer()
    let applied: number | null = null
    const read = (value: number, resolveMs: number) => {
      const token = seq.begin()
      return delay(resolveMs).then(() => { if (seq.isCurrent(token)) applied = value })
    }
    await Promise.all([read(1, 5), read(2, 25), read(3, 1)])
    expect(applied).toBe(3)   // token 3 was started last
  })

  it('isCurrent is false for every superseded token', () => {
    const seq = createDraftSequencer()
    const a = seq.begin(); const b = seq.begin()
    expect(seq.isCurrent(a)).toBe(false)
    expect(seq.isCurrent(b)).toBe(true)
    const c = seq.begin()
    expect(seq.isCurrent(b)).toBe(false)
    expect(seq.isCurrent(c)).toBe(true)
  })
})

describe('invoiceActionsLocked — the Invoice Draft actions are inert while unsafe', () => {
  it('is false only when nothing is pending', () => {
    expect(invoiceActionsLocked({})).toBe(false)
    expect(invoiceActionsLocked({ refreshing: false, editorBusy: false, busy: false, creating: false, sending: false, syncing: false, savingCust: false })).toBe(false)
  })
  it.each([
    ['refreshing', { refreshing: true }],
    ['editor saving', { editorBusy: true }],
    ['a fee override in flight', { busy: true }],
    ['creating the invoice', { creating: true }],
    ['sending', { sending: true }],
    ['syncing', { syncing: true }],
    ['saving the chosen customer', { savingCust: true }],
  ])('is true while %s', (_label, state) => {
    expect(invoiceActionsLocked(state)).toBe(true)
  })
})

describe('estimateActionsLocked — the standalone estimate actions are inert while unsafe', () => {
  it('is false only when idle', () => {
    expect(estimateActionsLocked({})).toBe(false)
    expect(estimateActionsLocked({ busy: false, editorBusy: false, refreshing: false })).toBe(false)
  })
  it.each([
    ['refreshing after an item edit', { refreshing: true }],
    ['the editor above is saving', { editorBusy: true }],
    ['an action is in flight', { busy: true }],
  ])('is true while %s', (_label, state) => {
    expect(estimateActionsLocked(state)).toBe(true)
  })
})

describe('interpretDraftResponse — a failed totals refresh fails closed', () => {
  it('a 2xx response carrying a real draft is usable', () => {
    const draft = { totalCents: 215000 }
    expect(interpretDraftResponse(true, { draft })).toEqual({ draft, error: null })
  })
  it('a non-2xx response drops the draft (never kept as current) and surfaces the server error', () => {
    expect(interpretDraftResponse(false, { error: 'Server is down' })).toEqual({ draft: null, error: 'Server is down' })
  })
  it('a 500 with no usable error uses the fallback message', () => {
    expect(interpretDraftResponse(false, null)).toEqual({ draft: null, error: 'Could not load the invoice totals. Try again.' })
  })
  it('a 2xx response with a missing draft fails closed (malformed body)', () => {
    expect(interpretDraftResponse(true, { error: 'nope' })).toEqual({ draft: null, error: 'nope' })
    expect(interpretDraftResponse(true, {}).draft).toBeNull()
    expect(interpretDraftResponse(true, { draft: null }).draft).toBeNull()
  })
  it('a null body (unparseable JSON) fails closed with the provided fallback', () => {
    expect(interpretDraftResponse(true, null, 'Unable to load total.')).toEqual({ draft: null, error: 'Unable to load total.' })
  })
  it('a blank/whitespace server error falls back rather than showing an empty message', () => {
    expect(interpretDraftResponse(false, { error: '   ' }).error).toBe('Could not load the invoice totals. Try again.')
  })
})

describe('draftActionReady — confirmed actions require a current loaded draft', () => {
  it('true only when a draft is present and nothing is loading/refreshing', () => {
    expect(draftActionReady({ draft: true })).toBe(true)
    expect(draftActionReady({ draft: true, loading: false, refreshing: false })).toBe(true)
  })
  it.each([
    ['no draft (e.g. after a failed refresh dropped it)', { draft: false }],
    ['still loading', { draft: true, loading: true }],
    ['refreshing the totals', { draft: true, refreshing: true }],
  ])('false when %s', (_label, state) => {
    expect(draftActionReady(state)).toBe(false)
  })
})
