/**
 * REGRESSION (New Estimate "cannot click Continue", 2026-11-06): the screen judges the year after trimming,
 * so the API must too — a year typed as "2019 " (phone keyboard suggestion) is a valid 4-digit year, and
 * surrounding whitespace must never turn a complete form into a 400 after Continue.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/platform/db', () => ({ getDb: () => { throw new Error('no db in this test') } }))

import { intakeInput } from './db'

const base = { requestId: '7d5b2a2e-5f3b-4a6b-9f1a-0b9d2c4e8a11', customerName: 'Brian McDonald', make: 'GMC', model: 'Sierra' }

describe('intakeInput.year', () => {
  it('accepts a 4-digit year with surrounding whitespace and stores it trimmed', () => {
    const r = intakeInput.safeParse({ ...base, year: '2019 ' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.year).toBe('2019')
  })
  it('still rejects anything that is not 4 digits', () => {
    for (const year of ['19', '2019.', 'twenty', '', '20 19']) expect(intakeInput.safeParse({ ...base, year }).success).toBe(false)
  })
})
