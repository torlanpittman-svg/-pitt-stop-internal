import { describe, it, expect, vi } from 'vitest'
import {
  decideCustomer, isPlaceholderEmail, isPlaceholderPhone, sanitizeContact,
  resolveRetailCustomer, resolveRetailCustomerIdentity, AmbiguousCustomerError,
  findRetailCustomerCandidates, persistRetailCustomerChoice,
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

// ── Ambiguity surfaces the colliding QB customers so a manager can pick (Kristin Young bug) ──
describe('ambiguity carries candidates for the manager picker', () => {
  it('email collision → AmbiguousCustomerError carries the colliding QB customers (not a guess)', async () => {
    const two = [
      { id: '10', email: 'k@x.com', syncToken: '0', displayName: 'Kristin Young', phone: '9794464676', active: true },
      { id: '11', email: 'k@x.com', syncToken: '0', displayName: 'John White', phone: '9794464676', active: true },
    ]
    const err = await resolveRetailCustomer({ name: 'Kristin Young', email: 'k@x.com' }, makeDeps({ qbFindByEmail: async () => two })).catch((e) => e)
    expect(err).toBeInstanceOf(AmbiguousCustomerError)
    expect((err as AmbiguousCustomerError).candidates.map((c) => c.id)).toEqual(['10', '11'])
    expect((err as AmbiguousCustomerError).candidates[0]).toMatchObject({ id: '10', displayName: 'Kristin Young', email: 'k@x.com', phone: '9794464676', active: true })
  })
  it('name collision → candidates come from the name matches', async () => {
    const err = await resolveRetailCustomer({ name: 'John White' }, makeDeps({ qbFindByName: async () => [
      { id: 'a', email: null, syncToken: '0', displayName: 'John White' },
      { id: 'b', email: null, syncToken: '0', displayName: 'John White' },
    ] })).catch((e) => e)
    expect(err).toBeInstanceOf(AmbiguousCustomerError)
    expect((err as AmbiguousCustomerError).candidates.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('findRetailCustomerCandidates (read-only picker source)', () => {
  it('returns email + name matches as candidate projections', async () => {
    const r = await findRetailCustomerCandidates({ name: 'Kristin Young', email: 'k@x.com' }, makeDeps({
      qbFindByEmail: async () => [{ id: '10', email: 'k@x.com', syncToken: '0', displayName: 'Kristin Young', phone: '9794464676', active: true }],
      qbFindByName: async () => [{ id: '11', email: null, syncToken: '0', displayName: 'Kristin Young' }],
    }))
    expect(r.emailMatches).toEqual([{ id: '10', displayName: 'Kristin Young', email: 'k@x.com', phone: '9794464676', active: true }])
    expect(r.nameMatches.map((c) => c.id)).toEqual(['11'])
  })
  it('placeholder email is never queried by email', async () => {
    const emailSpy = vi.fn(async () => [ANGELA_QB])
    const r = await findRetailCustomerCandidates(MICHAEL, makeDeps({ qbFindByEmail: emailSpy, qbFindByName: async () => [] }))
    expect(emailSpy).not.toHaveBeenCalled()
    expect(r.emailMatches).toEqual([])
  })
})

describe('persistRetailCustomerChoice (manager override → directory cache)', () => {
  it('validates the id against QB, then caches it onto the SAME directory row resolve would match', async () => {
    const dir = { id: 'dir-9', quickbooksCustomerId: null }
    const cache = vi.fn(async () => 'dir-9')
    const get = vi.fn(async (id: string) => ({ id, email: 'k@x.com', syncToken: '0', displayName: 'Kristin Young' }))
    const r = await persistRetailCustomerChoice(
      { name: 'Kristin Young', email: 'k@x.com', phone: '9794464676' }, '10',
      makeDeps({ findDirectory: async () => dir, qbGetCustomer: get, cacheToDirectory: cache }),
    )
    expect(get).toHaveBeenCalledWith('10')
    expect(cache).toHaveBeenCalledWith(dir, expect.objectContaining({ name: 'Kristin Young' }), '10')
    expect(r).toMatchObject({ qbCustomerId: '10', displayName: 'Kristin Young', directoryCustomerId: 'dir-9' })
  })
  it('refuses an id that is not a real QB customer (never fabricates a mapping)', async () => {
    await expect(persistRetailCustomerChoice({ name: 'X' }, '999', makeDeps({ qbGetCustomer: async () => null })))
      .rejects.toThrow(/was not found/)
  })
  it('requires a non-empty id', async () => {
    await expect(persistRetailCustomerChoice({ name: 'X' }, '   ', makeDeps())).rejects.toThrow(/required/)
  })

  it('END-TO-END (Kristin Young): after a manager picks, the next resolve uses directory-cache and never hits the ambiguous email search', async () => {
    const row = { id: 'dir-k', quickbooksCustomerId: null as string | null }  // in-memory directory row, starts unlinked
    const emailSearch = vi.fn(async () => [
      { id: '10', email: 'k@x.com', syncToken: '0', displayName: 'Kristin Young' },
      { id: '11', email: 'k@x.com', syncToken: '0', displayName: 'John White' },   // the collision
    ])
    const deps = makeDeps({
      findDirectory: async () => row,
      qbFindByEmail: emailSearch,
      qbGetCustomer: async (id) => ({ id, email: 'k@x.com', syncToken: '0', displayName: 'Kristin Young' }),
      cacheToDirectory: async (_dir, _c, qbId) => { row.quickbooksCustomerId = qbId; return row.id },
      reconcileEmail: async (cust) => ({ billEmail: cust.email, emailStatus: 'match', emailConflict: false }),
    })
    const contact: RetailContact = { name: 'Kristin Young', email: 'k@x.com', phone: '9794464676' }
    // 1) Before: email matches 2 → fails closed (the reported error).
    await expect(resolveRetailCustomer(contact, deps)).rejects.toBeInstanceOf(AmbiguousCustomerError)
    // 2) Manager picks QB #10 → persisted to the directory cache.
    await persistRetailCustomerChoice(contact, '10', deps)
    expect(row.quickbooksCustomerId).toBe('10')
    emailSearch.mockClear()
    // 3) After: resolves via directory-cache; the ambiguous email search is never consulted again.
    const r = await resolveRetailCustomer(contact, deps)
    expect(r).toMatchObject({ qbCustomerId: '10', matchedBy: 'directory-cache', created: false })
    expect(emailSearch).not.toHaveBeenCalled()
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
