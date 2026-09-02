import { describe, it, expect } from 'vitest'
import { authorizeSync, classifyFreshness, FRESH_MAX_HOURS } from './sync-health'

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
