import { describe, it, expect } from 'vitest'
import { scopeForRole, scopeAllows } from './authz'

describe('scopeForRole — server-side category authorization', () => {
  it('anonymous / unauthenticated → NOTHING (fail closed)', () => {
    const s = scopeForRole(null, false)
    expect(s.authenticated).toBe(false)
    expect(s.categories.size).toBe(0)
    expect(scopeAllows(s, 'customers')).toBe(false)
    expect(scopeAllows(s, 'checks')).toBe(false)
  })

  it('ordinary employee → operational categories only (no financial ones)', () => {
    const s = scopeForRole('employee', true)
    expect(scopeAllows(s, 'customers')).toBe(true)
    expect(scopeAllows(s, 'vehicles')).toBe(true)
    expect(scopeAllows(s, 'jobs')).toBe(true)
    expect(scopeAllows(s, 'auto_sales')).toBe(true)
    // Manager-only financial categories are denied.
    expect(scopeAllows(s, 'checks')).toBe(false)
    expect(scopeAllows(s, 'receipts')).toBe(false)
  })

  it('authenticated-but-anonymous (legacy) session is employee-level (no financial categories)', () => {
    const s = scopeForRole(null, true)
    expect(scopeAllows(s, 'jobs')).toBe(true)
    expect(scopeAllows(s, 'checks')).toBe(false)
  })

  it('manager → the additional financial categories', () => {
    const s = scopeForRole('manager', true)
    expect(scopeAllows(s, 'checks')).toBe(true)
    expect(scopeAllows(s, 'receipts')).toBe(true)
  })

  it('admin ⊇ manager', () => {
    const s = scopeForRole('admin', true)
    expect(scopeAllows(s, 'checks')).toBe(true)
    expect(scopeAllows(s, 'receipts')).toBe(true)
  })
})
