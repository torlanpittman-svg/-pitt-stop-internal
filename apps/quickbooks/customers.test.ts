import { describe, it, expect } from 'vitest'
import { decideEmailReconcile } from './customers'

describe('decideEmailReconcile (dealer email policy, pure)', () => {
  it('QB blank + configured email → fill (backfill the blank)', () => {
    expect(decideEmailReconcile(null, 'billing@sterlingautogroup.net'))
      .toEqual({ billEmail: 'billing@sterlingautogroup.net', status: 'filled_blank', conflict: false, fill: true })
    expect(decideEmailReconcile('  ', 'x@y.com').fill).toBe(true)
  })

  it('QB == configured (case-insensitive) → reuse, no write', () => {
    const d = decideEmailReconcile('Billing@Sterling.NET', 'billing@sterling.net')
    expect(d.status).toBe('match')
    expect(d.fill).toBe(false)
    expect(d.conflict).toBe(false)
    expect(d.billEmail).toBe('billing@sterling.net')
  })

  it('QB differs from configured → conflict, NOT overwritten (no fill)', () => {
    const d = decideEmailReconcile('someoneelse@dealer.com', 'billing@dealer.com')
    expect(d.status).toBe('conflict')
    expect(d.conflict).toBe(true)
    expect(d.fill).toBe(false)              // never overwrites the different existing email
    expect(d.billEmail).toBe('billing@dealer.com')   // invoice uses the configured source of truth
  })

  it('no configured email + QB has one → use QB, no write', () => {
    expect(decideEmailReconcile('fschlett@purdygroupusa.com', null))
      .toEqual({ billEmail: 'fschlett@purdygroupusa.com', status: 'no_desired', conflict: false, fill: false })
  })

  it('no configured email + QB blank (Purdy today) → none, invoice still creates', () => {
    expect(decideEmailReconcile(null, null))
      .toEqual({ billEmail: null, status: 'no_desired', conflict: false, fill: false })
  })
})
