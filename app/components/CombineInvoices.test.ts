/**
 * The panel's decision after Retry / Finish (CombineInvoicesSection). Regression for the review finding: a stale stop
 * BEFORE the void has already cancelled the combine, so the panel must refresh at once — never round-trip to a review
 * of a combine that no longer exists (which left the "not finished" block on screen until a reload).
 */
import { describe, it, expect } from 'vitest'
import { afterResume } from './CombineInvoices'

describe('afterResume', () => {
  it('a stale stop that cancelled the combine (before the void) refreshes — the "not finished" panel goes away', () => {
    expect(afterResume({ ok: false, block: 'stale', status: 'cancelled' })).toBe('refresh')
    expect(afterResume({ ok: false, block: 'stale', status: 'prepared' })).toBe('refresh')
  })
  it('after the void, a stale or emailed-acknowledgement stop loads a fresh review instead', () => {
    for (const status of ['voided', 'relinked'] as const) {
      expect(afterResume({ ok: false, block: 'stale', status })).toBe('review')
      expect(afterResume({ ok: false, block: 'confirm_required', status })).toBe('review')
    }
  })
  it('success and every other stop refresh', () => {
    expect(afterResume({ ok: true, status: 'completed' })).toBe('refresh')
    expect(afterResume({ ok: false, block: 'attention', status: 'relinked' })).toBe('refresh')
    expect(afterResume({ ok: false, block: 'busy', status: 'prepared' })).toBe('refresh')
  })
})
