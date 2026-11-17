import { describe, it, expect } from 'vitest'
import { authorizeSync, classifyFreshness, classifySource, overallHealth, FRESH_MAX_HOURS } from './sync-health'

describe('finance-sync auth policy', () => {
  const token = 'tok_finance'
  const secret = 'cron_secret'

  it('when CRON_SECRET is set, the scheduled sync requires a matching bearer (Vercel Cron sends it)', () => {
    expect(authorizeSync(`Bearer ${secret}`, { cronSecret: secret, financeToken: token }, false).ok).toBe(true)
    // No/invalid bearer → denied (this is the failure mode that silently broke prod when the secret
    // was UNSET but FINANCE_SYNC_TOKEN forced auth — see reason below for the fixed unset case).
    expect(authorizeSync(null, { cronSecret: secret, financeToken: token }, false).ok).toBe(false)
    expect(authorizeSync('Bearer nope', { cronSecret: secret, financeToken: token }, false).ok).toBe(false)
  })

  it('when CRON_SECRET is UNSET, the scheduled sync falls OPEN (parity with drain-dealer-queue)', () => {
    // This is the fix: a Vercel-scheduled call with no bearer must still run so daily refresh works.
    const d = authorizeSync(null, { cronSecret: null, financeToken: token }, false)
    expect(d.ok).toBe(true)
    expect(d.reason).toBe('sync:open')
  })

  it('FINANCE_SYNC_TOKEN always authorizes a manual/operator run', () => {
    expect(authorizeSync(`Bearer ${token}`, { cronSecret: null, financeToken: token }, false).ok).toBe(true)
    expect(authorizeSync(`Bearer ${token}`, { cronSecret: secret, financeToken: token }, false).ok).toBe(true)
  })

  it('diagnostics ALWAYS require a valid bearer (never fall open — they leak the DB host)', () => {
    expect(authorizeSync(null, { cronSecret: null, financeToken: token }, true).ok).toBe(false)
    expect(authorizeSync('Bearer nope', { cronSecret: null, financeToken: token }, true).ok).toBe(false)
    expect(authorizeSync(`Bearer ${token}`, { cronSecret: null, financeToken: token }, true).ok).toBe(true)
  })
})

describe('finance freshness policy', () => {
  const now = new Date('2026-09-02T12:00:00Z')

  it('a recent successful refresh is FRESH', () => {
    const r = classifyFreshness(new Date('2026-09-02T06:00:00Z'), 'ok', null, now)
    expect(r.status).toBe('fresh')
    expect(r.ageHours).toBeCloseTo(6, 1)
  })

  it('older than the daily window + grace is STALE', () => {
    const old = new Date(now.getTime() - (FRESH_MAX_HOURS + 5) * 3_600_000)
    expect(classifyFreshness(old, 'ok', null, now).status).toBe('stale')
  })

  it('a failed most-recent run surfaces as FAILED (never masquerades as fresh)', () => {
    const old = new Date(now.getTime() - 40 * 3_600_000)
    expect(classifyFreshness(old, 'error', 'plaid timeout', now).status).toBe('failed')
  })

  it('a fresh success AFTER an earlier failure is FRESH (recovered), not FAILED', () => {
    const recent = new Date(now.getTime() - 2 * 3_600_000)
    expect(classifyFreshness(recent, 'ok', null, now).status).toBe('fresh')
  })

  it('no sync at all is UNKNOWN, not silently zero/fresh', () => {
    expect(classifyFreshness(null, null, null, now).status).toBe('unknown')
  })
})

describe('per-connection health — one healthy bank must not hide a broken one', () => {
  const now = new Date('2026-11-17T12:00:00Z')
  const src = (o: Partial<Parameters<typeof classifySource>[0]> = {}) => ({ label: 'Pitt Stop Auto Sales *5600', institution: 'Extraco Banks', operating: false, itemStatus: 'active', lastError: null, balanceAsOf: '2026-11-17T09:00:00Z', ...o })

  it('a connection in error is an error, with how long ago it last read a balance', () => {
    const h = classifySource(src({ itemStatus: 'error', lastError: 'finance:plaid /accounts/balance/get → INSTITUTION_NOT_RESPONDING: try again soon', balanceAsOf: '2026-09-26T09:16:41Z' }), now)
    expect(h.state).toBe('error')
    expect(h.detail).toMatch(/not updating/)
    expect(h.detail).toMatch(/52 days ago/)
    expect(h.detail).not.toMatch(/finance:plaid/)          // no internal route noise in what the owner reads
  })
  it('an active connection is ok inside the freshness window and stale beyond it', () => {
    expect(classifySource(src(), now).state).toBe('ok')
    expect(classifySource(src({ balanceAsOf: '2026-11-15T00:00:00Z' }), now).state).toBe('stale')
    expect(classifySource(src({ balanceAsOf: null }), now).state).toBe('stale')
  })
  it('a broken NON-operating bank downgrades "fresh" and is named in the message', () => {
    const broken = classifySource(src({ itemStatus: 'error', balanceAsOf: '2026-09-26T09:16:41Z' }), now)
    const o = overallHealth('fresh', 'Bank data is current.', [classifySource(src({ label: 'Pitt Stop Detail *2649', operating: true }), now), broken])
    expect(o.status).toBe('stale')
    expect(o.message).toMatch(/Operating account is current, but: .*\*5600 is not updating/)
  })
  it('a broken OPERATING bank is a failure', () => {
    const op = classifySource(src({ label: 'Pitt Stop Detail *2649', operating: true, itemStatus: 'error', balanceAsOf: '2026-11-10T00:00:00Z' }), now)
    expect(overallHealth('fresh', 'Bank data is current.', [op]).status).toBe('failed')
  })
  it('all healthy → unchanged', () => {
    expect(overallHealth('fresh', 'Bank data is current.', [classifySource(src({ operating: true }), now)])).toEqual({ status: 'fresh', message: 'Bank data is current.' })
  })
})
