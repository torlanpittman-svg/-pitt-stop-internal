import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/apps/auth/employee-guard', () => ({ employeeAuthorized: vi.fn(), authorizedManager: vi.fn() }))
vi.mock('./db', () => ({ addExpenseEvent: vi.fn() }))

import { revalidatePath } from 'next/cache'
import { employeeAuthorized } from '@/apps/auth/employee-guard'
import { addExpenseEvent } from './db'
import { addExpenseAction } from './actions'

function expense(overrides: Record<string, string> = {}) {
  const fd = new FormData()
  for (const [key, value] of Object.entries({ inventoryVehicleId: 'vehicle-1', category: 'part', amount: '125.45',
    eventDate: '2026-09-25', vendor: 'Parts shop', account: 'unknown', memo: 'Brake pads', ...overrides })) fd.set(key, value)
  return fd
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(employeeAuthorized).mockResolvedValue(true)
  vi.mocked(addExpenseEvent).mockResolvedValue('expense-1')
})

describe('manual vehicle expense', () => {
  it('saves without a receipt and refreshes employee/admin vehicle and inventory views', async () => {
    expect(await addExpenseAction(expense())).toEqual({ ok: true })
    expect(addExpenseEvent).toHaveBeenCalledExactlyOnceWith({ inventoryVehicleId: 'vehicle-1', economicCategory: 'part',
      amountCents: 12545, eventDate: '2026-09-25', vendor: 'Parts shop', paymentAccountRef: 'unknown', memo: 'Brake pads', actor: 'auto-sales' })
    expect(vi.mocked(revalidatePath).mock.calls.map(([path]) => path)).toEqual([
      '/auto-sales/vehicle-1', '/admin/auto-sales/vehicle-1', '/auto-sales', '/admin/auto-sales',
    ])
  })

  it.each(['part', 'recon_labor', 'mechanic', 'bodywork', 'pdr', 'paint', 'transport', 'title_tax', 'registration', 'auction_fee', 'buyer_fee', 'other'])('accepts the manual %s category', async (category) => {
    expect(await addExpenseAction(expense({ category }))).toEqual({ ok: true })
  })

  it.each<Record<string, string>>([
    { amount: '' }, { amount: '0' }, { amount: '-1' }, { amount: '12abc' }, { amount: 'Infinity' }, { amount: '21474836.48' },
    { category: 'invalid' }, { inventoryVehicleId: '' }, { eventDate: '' }, { eventDate: '2026-02-30' },
  ])('reports invalid entries instead of silently completing: %o', async (values) => {
    expect(await addExpenseAction(expense(values))).toEqual({ ok: false, error: expect.any(String) })
    expect(addExpenseEvent).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('reports an expired session without saving', async () => {
    vi.mocked(employeeAuthorized).mockResolvedValue(false)
    expect(await addExpenseAction(expense())).toEqual({ ok: false, error: 'Sign in again to add this expense.' })
    expect(addExpenseEvent).not.toHaveBeenCalled()
  })

  it('reports a database failure without claiming success', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(addExpenseEvent).mockRejectedValue(new Error('database unavailable'))
    try {
      expect(await addExpenseAction(expense())).toEqual({ ok: false, error: expect.stringContaining('Could not save') })
      expect(revalidatePath).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })
})
