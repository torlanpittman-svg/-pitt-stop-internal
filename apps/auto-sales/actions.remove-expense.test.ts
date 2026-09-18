import { describe, it, expect, vi, beforeEach } from 'vitest'

// removeVehicleExpenseAction is MANAGER/ADMIN-gated server-side. These tests prove the gate is enforced
// before any db work, that repeated requests are safe (idempotent passthrough), and that the manager's
// identity is what gets attributed.
const guard = vi.hoisted(() => ({ manager: null as null | { name: string; role: string } }))
vi.mock('@/apps/auth/employee-guard', () => ({
  employeeAuthorized: vi.fn(async () => true),
  authorizedManager: vi.fn(async () => guard.manager),
  // The removal action uses the STRICT, genuinely fail-closed gate (no synthetic dev manager).
  authorizedManagerStrict: vi.fn(async () => guard.manager),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('./db', () => ({
  removeVehicleExpense: vi.fn(async () => ({ ok: true })),
  // exports referenced by the module's static import graph (unused here):
  createAcquisition: vi.fn(), addExpenseEvent: vi.fn(), addReturnRefund: vi.fn(), settleRefund: vi.fn(),
  recordSale: vi.fn(), editSale: vi.fn(), reverseSale: vi.fn(), editAcquisitionPrice: vi.fn(), updateCloseout: vi.fn(),
  resolveVin: vi.fn(), saveReceipt: vi.fn(),
}))

import { removeVehicleExpenseAction } from './actions'
import * as db from './db'
const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>

beforeEach(() => { vi.clearAllMocks(); guard.manager = null })

describe('removeVehicleExpenseAction — server-side manager/admin authorization', () => {
  it('a non-manager is refused and NO removal is attempted', async () => {
    guard.manager = null
    const r = await removeVehicleExpenseAction({ inventoryVehicleId: 'veh-1', eventId: 'exp-1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/manager/i)
    expect(asMock(db.removeVehicleExpense)).not.toHaveBeenCalled()
  })

  it('a manager removes the expense, attributed to their name', async () => {
    guard.manager = { name: 'Darryl', role: 'manager' }
    const r = await removeVehicleExpenseAction({ inventoryVehicleId: 'veh-1', eventId: 'exp-1' })
    expect(r.ok).toBe(true)
    expect(asMock(db.removeVehicleExpense).mock.calls[0][0]).toEqual({ eventId: 'exp-1', actor: 'Darryl' })
  })

  it('repeated requests are safe — the idempotent no-op is passed straight through', async () => {
    guard.manager = { name: 'Darryl', role: 'manager' }
    asMock(db.removeVehicleExpense).mockResolvedValueOnce({ ok: true, alreadyRemoved: true })
    const r = await removeVehicleExpenseAction({ inventoryVehicleId: 'veh-1', eventId: 'exp-1' })
    expect(r).toEqual({ ok: true, alreadyRemoved: true })
  })

  it('rejects a missing expense id before touching the db', async () => {
    guard.manager = { name: 'Darryl', role: 'manager' }
    const r = await removeVehicleExpenseAction({ inventoryVehicleId: 'veh-1', eventId: '' })
    expect(r.ok).toBe(false)
    expect(asMock(db.removeVehicleExpense)).not.toHaveBeenCalled()
  })
})
