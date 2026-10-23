import { describe, it, expect, vi } from 'vitest'
import { addDealership, checkPrefixEdit, type AddDealershipDeps } from './dealership-setup'
import type { DealershipRow } from './db'

const row = (id: string, name: string, stockPrefix: string | null, qbCustomerId: string): DealershipRow =>
  ({ id, name, stockPrefix, qbCustomerId, active: true, createdAt: new Date() })

// Mirrors production: Sterling S/T/K/U + Purdy AP.
const PROD = [
  row('s', 'Sterling Auto Group', 'S', '6'),
  row('t', 'Sterling Auto Group', 'T', '6'),
  row('k', 'Sterling Kia', 'K', '67'),
  row('u', 'Sterling Subaru', 'U', '836'),
  row('ap', 'Purdy Mazda', 'AP', '1281'),
]
const BMW = { id: '167', displayName: 'BMW of College Station', email: 'Mark@BMWofcollegestation.com', active: true }

function deps(over: Partial<AddDealershipDeps> = {}, dealers = PROD) {
  return {
    listDealerships: vi.fn(async () => dealers),
    getCustomerById: vi.fn(async (id: string) => (id === BMW.id ? BMW : null)),
    createDealership: vi.fn(async () => 'new-id'),
    ...over,
  }
}

describe('addDealership', () => {
  it('adds BMW with NO prefix (NULL), mapped to the verified QB customer', async () => {
    const d = deps()
    const r = await addDealership({ qbCustomerId: '167', stockPrefix: '' }, d)
    expect(r).toEqual({ ok: true, created: true, dealership: { id: 'new-id', name: 'BMW of College Station', stockPrefix: null, qbCustomerId: '167' } })
    expect(d.createDealership).toHaveBeenCalledWith({
      name: 'BMW of College Station', stockPrefix: null, qbCustomerId: '167', qbCustomerName: 'BMW of College Station',
      billingEmail: 'Mark@BMWofcollegestation.com', taxExempt: true, rateDefault: 200,
    })
  })
  it('never stores an empty-string prefix', async () => {
    const d = deps()
    await addDealership({ qbCustomerId: '167', stockPrefix: '   ' }, d)
    expect(vi.mocked(d.createDealership).mock.calls[0][0].stockPrefix).toBeNull()
  })
  it('is idempotent: a second tap returns the existing row and writes nothing', async () => {
    const d = deps({}, [...PROD, row('bmw', 'BMW of College Station', null, '167')])
    const r = await addDealership({ qbCustomerId: '167' }, d)
    expect(r).toMatchObject({ ok: true, created: false, dealership: { id: 'bmw' } })
    expect(d.createDealership).not.toHaveBeenCalled()
  })
  it('refuses a prefix that would take over Sterling stocks', async () => {
    const d = deps()
    const r = await addDealership({ qbCustomerId: '167', stockPrefix: 'S' }, d)
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(d.createDealership).not.toHaveBeenCalled()
  })
  it('requires an existing, active QuickBooks customer (no QB writes, no guessing)', async () => {
    expect(await addDealership({ qbCustomerId: '' }, deps())).toMatchObject({ ok: false, status: 400 })
    expect(await addDealership({ qbCustomerId: '999' }, deps())).toMatchObject({ ok: false, status: 422 })
    const inactive = deps({ getCustomerById: vi.fn(async () => ({ ...BMW, active: false })) })
    expect(await addDealership({ qbCustomerId: '167' }, inactive)).toMatchObject({ ok: false, status: 422 })
  })
  it('rejects invalid prefix and email', async () => {
    expect(await addDealership({ qbCustomerId: '167', stockPrefix: 'B-1' }, deps())).toMatchObject({ ok: false, status: 400 })
    expect(await addDealership({ qbCustomerId: '167', billingEmail: 'nope' }, deps())).toMatchObject({ ok: false, status: 400 })
  })
})

describe('checkPrefixEdit', () => {
  it('lets a dealer clear its prefix (→ NULL) or keep its own', () => {
    expect(checkPrefixEdit('ap', '', PROD)).toEqual({ ok: true, stockPrefix: null })
    expect(checkPrefixEdit('ap', 'ap', PROD)).toEqual({ ok: true, stockPrefix: 'AP' })
  })
  it('allows Sterling Auto Group rows to share overlap within the same QB customer', () => {
    expect(checkPrefixEdit('t', 'S', PROD)).toEqual({ ok: true, stockPrefix: 'S' })
  })
  it('refuses overlap with a different dealer', () => {
    expect(checkPrefixEdit('ap', 'K1', PROD)).toMatchObject({ ok: false, status: 409 })
    expect(checkPrefixEdit('missing', 'Z', PROD)).toMatchObject({ ok: false, status: 404 })
  })
})
