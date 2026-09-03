import { describe, it, expect, vi } from 'vitest'
import {
  decideCustomer, isPlaceholderEmail, isPlaceholderPhone, sanitizeContact,
  resolveRetailCustomer, resolveRetailCustomerIdentity, AmbiguousCustomerError,
  type ResolveDeps, type RetailContact,
} from './retail-customer'

// ── Placeholder detection (the Michael-Feldman→Angela-Brown root cause) ──
describe('placeholder contact detection', () => {
  it('treats "no@no.com" and friends as NOT a real email', () => {
    for (const e of ['no@no.com', 'NO@NO.COM', 'none@none.com', 'test@test.com', 'na@na.com', 'x@example.com', '', null, 'no', 'notanemail'])
      expect(isPlaceholderEmail(e)).toBe(true)
  })
  it('accepts a real email', () => {
    expect(isPlaceholderEmail('michael.feldman@gmail.com')).toBe(false)
    expect(isPlaceholderEmail('a@b.co')).toBe(false)
  })
  it('rejects junk phones, accepts a real 10-digit number', () => {
    expect(isPlaceholderPhone('0000000000')).toBe(true)
    expect(isPlaceholderPhone('1111111111')).toBe(true)
    expect(isPlaceholderPhone('555')).toBe(true)
    expect(isPlaceholderPhone('9792683704')).toBe(false)
  })
  it('sanitizeContact strips placeholders to null (keeps the name + real values)', () => {
    expect(sanitizeContact({ name: 'Michael Feldman', email: 'no@no.com', phone: '9792683704' }))
      .toEqual({ name: 'Michael Feldman', email: null, phone: '9792683704' })
  })
})

// ── Pure decision core ──
describe('decideCustomer (pure; fails closed, never first-of-many)', () => {
  it('CASE 1: directory cache wins', () => {
    expect(decideCustomer({ dirCacheId: '42', emailUsable: true, emailMatchIds: ['9'], nameMatchIds: ['9'] }))
      .toEqual({ action: 'use', qbCustomerId: '42', matchedBy: 'directory-cache' })
  })
  it('CASE 2: unique email match', () => {
    expect(decideCustomer({ dirCacheId: null, emailUsable: true, emailMatchIds: ['7'], nameMatchIds: [] }))
      .toEqual({ action: 'use', qbCustomerId: '7', matchedBy: 'qb-email' })
  })
  it('CASE 3: no evidence → create', () => {
    expect(decideCustomer({ dirCacheId: null, emailUsable: false, emailMatchIds: [], nameMatchIds: [] }))
      .toEqual({ action: 'create' })
  })
  it('CASE 4: ambiguous email → ambiguous (NOT first result)', () => {
    expect(decideCustomer({ dirCacheId: null, emailUsable: true, emailMatchIds: ['1', '2'], nameMatchIds: [] }).action).toBe('ambiguous')
  })
  it('CASE 4: ambiguous name → ambiguous', () => {
    expect(decideCustomer({ dirCacheId: null, emailUsable: false, emailMatchIds: [], nameMatchIds: ['1', '2'] }).action).toBe('ambiguous')
  })
  it('placeholder email (emailUsable=false) is never evidence even if matches were somehow passed', () => {
    expect(decideCustomer({ dirCacheId: null, emailUsable: false, emailMatchIds: ['angela'], nameMatchIds: [] }))
      .toEqual({ action: 'create' })
  })
})

// ── Full resolver with injected deps (deterministic, no QB/DB) ──
function makeDeps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    findDirectory: async () => null,
    qbFindByEmail: async () => [],
    qbFindByName: async () => [],
    qbCreate: async (c) => ({ id: 'NEW-' + c.name.replace(/\s+/g, ''), email: c.email ?? null, syncToken: '0' }),
    qbGetCustomer: async (id) => ({ id, email: null, syncToken: '0' }),
    reconcileEmail: async (cust) => ({ billEmail: cust.email, emailStatus: 'none', emailConflict: false }),
    cacheToDirectory: async () => 'dir-1',
    ...over,
  }
}
const MICHAEL: RetailContact = { name: 'Michael Feldman', email: 'no@no.com', phone: '9792683704' }
const ANGELA_QB = { id: '1296', email: 'no@no.com', syncToken: '3' }

describe('resolveRetailCustomer (regression: wrong-customer attachment)', () => {
  it('TEST 1: directory cache → that exact CustomerRef', async () => {
    const r = await resolveRetailCustomer({ name: 'Jane', email: 'jane@x.com' }, makeDeps({ findDirectory: async () => ({ id: 'd', quickbooksCustomerId: '500' }) }))
    expect(r).toMatchObject({ qbCustomerId: '500', created: false, matchedBy: 'directory-cache' })
  })

  it('TEST 2: not in QB → creates + uses the NEW returned id', async () => {
    const create = vi.fn(async (c: RetailContact) => ({ id: '100000001', email: null, syncToken: '0' }))
    const r = await resolveRetailCustomer({ name: 'Michael Feldman', email: 'mf@gmail.com' }, makeDeps({ qbCreate: create }))
    expect(create).toHaveBeenCalledOnce()
    expect(r).toMatchObject({ qbCustomerId: '100000001', created: true, matchedBy: 'created' })
  })

  it('TEST 3 + 4: Michael (placeholder email) NEVER resolves to Angela — email is not queried, Michael is created', async () => {
    // Angela holds no@no.com in QB. If email were used, qbFindByEmail would return her.
    const emailLookup = vi.fn(async () => [ANGELA_QB])
    const create = vi.fn(async () => ({ id: 'MICHAEL-NEW', email: null, syncToken: '0' }))
    const r = await resolveRetailCustomer(MICHAEL, makeDeps({ qbFindByEmail: emailLookup, qbFindByName: async () => [], qbCreate: create }))
    expect(emailLookup).not.toHaveBeenCalled()          // placeholder email is never used as identity
    expect(r.qbCustomerId).toBe('MICHAEL-NEW')
    expect(r.qbCustomerId).not.toBe('1296')             // never Angela
    expect(r.matchedBy).toBe('created')
  })

  it('TEST 3: A then B — B can never inherit A’s CustomerRef (no shared state)', async () => {
    const depsA = makeDeps({ qbFindByName: async () => [{ id: 'A', email: null, syncToken: '0' }] })
    const depsB = makeDeps({ qbFindByName: async () => [{ id: 'B', email: null, syncToken: '0' }] })
    const a = await resolveRetailCustomer({ name: 'Alice' }, depsA)
    const b = await resolveRetailCustomer({ name: 'Bob' }, depsB)
    expect(a.qbCustomerId).toBe('A')
    expect(b.qbCustomerId).toBe('B')
  })

  it('TEST 5: ambiguous QB match → throws, no CustomerRef chosen', async () => {
    const deps = makeDeps({ qbFindByName: async () => [{ id: '1', email: null, syncToken: '0' }, { id: '2', email: null, syncToken: '0' }] })
    await expect(resolveRetailCustomer({ name: 'John Smith' }, deps)).rejects.toBeInstanceOf(AmbiguousCustomerError)
  })

  it('TEST 6: QB customer creation failure → throws (invoice must not be created under anyone)', async () => {
    const deps = makeDeps({ qbCreate: async () => { throw new Error('QB create 500') } })
    await expect(resolveRetailCustomer({ name: 'New Person', email: 'new@x.com' }, deps)).rejects.toThrow('QB create 500')
  })

  it('TEST 7: QB lookup failure → throws (never falls back to a default/previous customer)', async () => {
    const deps = makeDeps({ qbFindByName: async () => { throw new Error('QB query 500') } })
    await expect(resolveRetailCustomer({ name: 'Someone' }, deps)).rejects.toThrow('QB query 500')
  })

  it('TEST 8: idempotency — repeated resolution with an existing unique match reuses it and never creates', async () => {
    const create = vi.fn()
    const deps = makeDeps({ qbFindByName: async () => [{ id: '900', email: null, syncToken: '0' }], qbCreate: create as any })
    const r1 = await resolveRetailCustomer({ name: 'Repeat' }, deps)
    const r2 = await resolveRetailCustomer({ name: 'Repeat' }, deps)
    expect(r1.qbCustomerId).toBe('900')
    expect(r2.qbCustomerId).toBe('900')
    expect(create).not.toHaveBeenCalled()
  })
})

describe('resolveRetailCustomerIdentity (read-only; safe for Sync)', () => {
  it('placeholder email → not matched by email; ambiguous name → null (needs_review, never a guess)', async () => {
    const r = await resolveRetailCustomerIdentity(MICHAEL, makeDeps({
      qbFindByEmail: async () => [ANGELA_QB],           // would wrongly match if email were used
      qbFindByName: async () => [{ id: '1', email: null, syncToken: '0' }, { id: '2', email: null, syncToken: '0' }],
    }))
    expect(r).toEqual({ qbCustomerId: null, matchedBy: 'none' })
  })
})
