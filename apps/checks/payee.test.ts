import { vi, describe, it, expect, beforeEach } from 'vitest'

// The shared QuickBooks client is mocked — nothing here reaches QuickBooks.
const h = vi.hoisted(() => ({ query: vi.fn(), request: vi.fn() }))
vi.mock('@/apps/quickbooks/client', () => ({ queryQBO: h.query, qbApiRequest: h.request, qboEscape: (s: string) => s.replace(/'/g, "\\'") }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import {
  decidePayee, previewPayee, resolvePayee, searchPayees, isDuplicateNameError,
  AmbiguousPayeeError, PayeeBlockedError, PayeeExistsError, PayeeLookupError, PayeeNotFoundError, type QbPayee,
} from './payee'

const p = (type: QbPayee['type'], id: string, displayName: string, active = true): QbPayee => ({ id, type, displayName, active })
type Row = { Id: string; DisplayName: string; Active?: boolean }
type Lists = Partial<Record<'Vendor' | 'Employee' | 'Customer', Row[]>>

/** Fake QuickBooks: answers each list query from `lists`, in the shape queryQBO returns. */
function qbHolds(lists: Lists) {
  h.query.mockImplementation(async (q: string) => {
    const type = /FROM (\w+)/.exec(q)![1] as keyof Lists
    return lists[type] ? { [type]: lists[type] } : {}
  })
}
// The real 6240 text QuickBooks returned for "Anthony Pittman" on 2026-10-16.
const DUPLICATE_6240 = new Error('QuickBooks API /vendor failed (400): {"Fault":{"Error":[{"Message":"Duplicate Name Exists Error","Detail":"The name supplied already exists. : Another customer, vendor or employee is already using this name. Please use a different name.","code":"6240"}],"type":"ValidationFault"}}')

beforeEach(() => {
  h.query.mockReset()
  h.request.mockReset().mockResolvedValue({ Vendor: { Id: 'NEW1', DisplayName: 'Brand New LLC', Active: true } })
})

describe('decidePayee — exact names only, fail-closed', () => {
  it('uses the one existing VENDOR', () => {
    expect(decidePayee('Thompson Derrig', [p('Vendor', '7', 'Thompson Derrig')])).toEqual({ action: 'use', payee: p('Vendor', '7', 'Thompson Derrig') })
  })
  it('uses the one existing EMPLOYEE (payroll to an employee)', () => {
    expect(decidePayee('Anthony Pittman', [p('Employee', '400000021', 'Anthony Pittman')])).toMatchObject({ action: 'use', payee: { id: '400000021', type: 'Employee' } })
  })
  it('uses the one existing CUSTOMER (refund / reimbursement)', () => {
    expect(decidePayee('Sharon Pittman', [p('Customer', '1113', 'Sharon Pittman')])).toMatchObject({ action: 'use', payee: { id: '1113', type: 'Customer' } })
  })
  it('matches through extra spaces and capitalization differences', () => {
    expect(decidePayee('  anthony    PITTMAN ', [p('Employee', '400000021', 'Anthony Pittman')])).toMatchObject({ action: 'use', payee: { id: '400000021' } })
  })
  it('creates only when nothing has the exact name (near names never count)', () => {
    expect(decidePayee('Brand New LLC', [])).toEqual({ action: 'create' })
    expect(decidePayee('Anthony Pittman', [p('Vendor', '1', 'Anthony Pittman Jr'), p('Customer', '2', 'Anthony Pittmann')])).toEqual({ action: 'create' })
  })
  it('more than one active exact match (any lists) → ambiguous, never picks the first', () => {
    const d = decidePayee('Acme', [p('Vendor', '1', 'Acme'), p('Customer', '2', 'ACME')])
    expect(d.action).toBe('ambiguous')
    if (d.action === 'ambiguous') expect(d.matches.map((m) => m.type)).toEqual(['Vendor', 'Customer'])
  })
  it('an active match wins over an inactive one with the same name', () => {
    expect(decidePayee('Acme', [p('Vendor', '1', 'Acme', false), p('Employee', '2', 'Acme')])).toMatchObject({ action: 'use', payee: { id: '2' } })
  })
  it('an inactive record renamed "(deleted)" by QuickBooks never matches the typed name', () => {
    expect(decidePayee('Darryl Pittman', [p('Vendor', '28', 'Darryl Pittman (deleted)', false)])).toEqual({ action: 'create' })
  })
  it('only an INACTIVE record has the exact name → blocked with a plain-language fix, never create', () => {
    const d = decidePayee('Old Guy', [p('Employee', '9', 'Old Guy', false)])
    expect(d.action).toBe('blocked')
    if (d.action === 'blocked') expect(d.reason).toMatch(/INACTIVE employee.*make that employee active again/)
  })
})

describe('searchPayees — searches Vendors, Employees AND Customers', () => {
  it('queries all three lists with the normalized name', async () => {
    qbHolds({})
    await searchPayees('  Anthony   Pittman ')
    const queries = h.query.mock.calls.map((c) => c[0] as string)
    expect(queries).toHaveLength(3)
    for (const t of ['Vendor', 'Employee', 'Customer']) {
      expect(queries).toContain(`SELECT * FROM ${t} WHERE DisplayName LIKE 'Anthony Pittman%' MAXRESULTS 100`)
    }
  })
  it('escapes quotes in the name', async () => {
    qbHolds({})
    await searchPayees("O'Reilly Auto Parts")
    expect(h.query.mock.calls[0][0]).toContain("LIKE 'O\\'Reilly Auto Parts%'")
  })
  it('a failed lookup on ANY list is a lookup failure — never a partial "not found"', async () => {
    h.query.mockImplementation(async (q: string) => { if (q.includes('FROM Employee')) throw new Error('QuickBooks API /query failed (503)'); return {} })
    await expect(searchPayees('Anthony Pittman')).rejects.toBeInstanceOf(PayeeLookupError)
  })
})

describe('previewPayee — the review card states', () => {
  it('Anthony Pittman (an employee, not a vendor) → existing payee found, as the employee', async () => {
    qbHolds({ Vendor: [{ Id: '9', DisplayName: 'Torlan.Pittman' }], Employee: [{ Id: '400000021', DisplayName: 'Anthony Pittman', Active: true }] })
    expect(await previewPayee('Anthony Pittman')).toEqual({ decision: 'use', payee: p('Employee', '400000021', 'Anthony Pittman') })
  })
  it('brand-new payee → create (needs confirmation)', async () => {
    qbHolds({})
    expect(await previewPayee('Brand New LLC')).toEqual({ decision: 'create' })
  })
  it('lookup failure surfaces as an error, not "create"', async () => {
    h.query.mockRejectedValue(new Error('network down'))
    await expect(previewPayee('Anthony Pittman')).rejects.toBeInstanceOf(PayeeLookupError)
  })
})

describe('resolvePayee — vendor creation only when nothing has the name, and only when confirmed', () => {
  it('existing employee resolves WITHOUT creating a vendor, even if create was ticked', async () => {
    qbHolds({ Employee: [{ Id: '400000021', DisplayName: 'Anthony Pittman' }] })
    expect(await resolvePayee('Anthony Pittman', { allowCreate: true })).toEqual(p('Employee', '400000021', 'Anthony Pittman'))
    expect(h.request).not.toHaveBeenCalled()
  })
  it('existing vendor / customer resolve without creating', async () => {
    qbHolds({ Vendor: [{ Id: '1411', DisplayName: 'Thomas Blanchard' }] })
    expect(await resolvePayee('thomas blanchard')).toMatchObject({ id: '1411', type: 'Vendor' })
    qbHolds({ Customer: [{ Id: '1113', DisplayName: 'Sharon Pittman' }] })
    expect(await resolvePayee('Sharon Pittman')).toMatchObject({ id: '1113', type: 'Customer' })
    expect(h.request).not.toHaveBeenCalled()
  })
  it('brand-new payee WITHOUT confirmation → PayeeNotFoundError, nothing created', async () => {
    qbHolds({})
    await expect(resolvePayee('Brand New LLC')).rejects.toBeInstanceOf(PayeeNotFoundError)
    expect(h.request).not.toHaveBeenCalled()
  })
  it('brand-new payee WITH confirmation → creates exactly one vendor with the cleaned-up name', async () => {
    qbHolds({})
    expect(await resolvePayee('  Brand   New LLC ', { allowCreate: true })).toEqual(p('Vendor', 'NEW1', 'Brand New LLC'))
    expect(h.request).toHaveBeenCalledTimes(1)
    expect(h.request.mock.calls[0][0]).toMatchObject({ method: 'POST', path: '/vendor', body: { DisplayName: 'Brand New LLC' } })
  })
  it('duplicate display name → ambiguous error, nothing created', async () => {
    qbHolds({ Vendor: [{ Id: '1', DisplayName: 'Acme' }], Customer: [{ Id: '2', DisplayName: 'Acme' }] })
    await expect(resolvePayee('Acme', { allowCreate: true })).rejects.toBeInstanceOf(AmbiguousPayeeError)
    expect(h.request).not.toHaveBeenCalled()
  })
  it('inactive-only name → blocked, nothing created', async () => {
    qbHolds({ Vendor: [{ Id: '5', DisplayName: 'Old Supplier', Active: false }] })
    await expect(resolvePayee('Old Supplier', { allowCreate: true })).rejects.toBeInstanceOf(PayeeBlockedError)
    expect(h.request).not.toHaveBeenCalled()
  })
  it('lookup failure → PayeeLookupError and NEVER a vendor create', async () => {
    h.query.mockRejectedValue(new Error('QuickBooks API /query failed (500)'))
    await expect(resolvePayee('Anthony Pittman', { allowCreate: true })).rejects.toBeInstanceOf(PayeeLookupError)
    expect(h.request).not.toHaveBeenCalled()
  })

  describe('QuickBooks 6240 Duplicate Name on a confirmed create', () => {
    it('recognizes the 6240 error text', () => {
      expect(isDuplicateNameError(DUPLICATE_6240)).toBe(true)
      expect(isDuplicateNameError(new Error('QuickBooks API /vendor failed (400): code 2010'))).toBe(false)
    })
    it('re-queries, finds the owner, and hands it back for confirmation — exactly ONE create attempt, no renamed vendor', async () => {
      // First lookup misses (e.g. the record appeared after the review screen loaded); the re-query finds it.
      qbHolds({ Employee: [{ Id: '400000021', DisplayName: 'Anthony Pittman' }] })
      h.query.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({})
      h.request.mockRejectedValue(DUPLICATE_6240)
      const err = await resolvePayee('Anthony Pittman', { allowCreate: true }).catch((e) => e)
      expect(err).toBeInstanceOf(PayeeExistsError)
      expect((err as PayeeExistsError).payee).toEqual(p('Employee', '400000021', 'Anthony Pittman'))
      expect(h.request).toHaveBeenCalledTimes(1)
    })
    it('name taken by something the app cannot see → blocked with guidance, one create attempt only', async () => {
      qbHolds({})
      h.request.mockRejectedValue(DUPLICATE_6240)
      const err = await resolvePayee('Mystery Name', { allowCreate: true }).catch((e) => e)
      expect(err).toBeInstanceOf(PayeeBlockedError)
      expect((err as Error).message).toMatch(/Other names/)
      expect(h.request).toHaveBeenCalledTimes(1)
    })
    it('a non-6240 create failure is passed through unchanged (not disguised as a name conflict)', async () => {
      qbHolds({})
      const boom = new Error('QuickBooks API /vendor failed (500): server error')
      h.request.mockRejectedValue(boom)
      await expect(resolvePayee('Brand New LLC', { allowCreate: true })).rejects.toBe(boom)
    })
  })

  describe('explicit pick (id + type) from the review screen', () => {
    it('verifies the record in the RIGHT list and uses it', async () => {
      qbHolds({ Employee: [{ Id: '400000021', DisplayName: 'Anthony Pittman' }] })
      expect(await resolvePayee('Anthony Pittman', { payeeId: '400000021', payeeType: 'Employee' })).toEqual(p('Employee', '400000021', 'Anthony Pittman'))
      expect(h.query.mock.calls[0][0]).toBe("SELECT * FROM Employee WHERE Id = '400000021'")
    })
    it('refuses a pick that is no longer active (QuickBooks then hides it) or comes back inactive', async () => {
      qbHolds({})
      await expect(resolvePayee('X', { payeeId: '1', payeeType: 'Customer' })).rejects.toBeInstanceOf(PayeeBlockedError)
      qbHolds({ Vendor: [{ Id: '1', DisplayName: 'X', Active: false }] })
      await expect(resolvePayee('X', { payeeId: '1', payeeType: 'Vendor' })).rejects.toBeInstanceOf(PayeeBlockedError)
    })
  })
})

