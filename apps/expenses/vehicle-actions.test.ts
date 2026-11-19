import { describe, it, expect, vi, beforeEach } from 'vitest'

// ACTION-LAYER authorization for "Assign to Auto Sales Vehicle". authz, the write path and the cache are mocked;
// this proves WHO may do what: a shared-PIN employee can pick a vehicle while filing their own new receipt and
// can look up what is already on a vehicle, but can never assign / move / remove a vehicle on an existing receipt.
vi.mock('./authz', () => ({ receiptManager: vi.fn(), receiptUploader: vi.fn(), canFileReceipt: vi.fn(() => true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('./vehicle-link', () => ({
  setReceiptVehicle: vi.fn(async () => ({ ok: true, inventoryVehicleId: 'veh-1', previousVehicleId: null })),
  vehicleExpenseCandidates: vi.fn(async () => [{ eventId: 'e1', label: 'Part · $10.00', date: '2026-11-01', vendor: null, amountCents: 1000, likely: true }]),
}))
vi.mock('./job-expenses', () => ({ allocateReceipt: vi.fn(async () => ({ ok: true })), isUuid: () => true }))
vi.mock('./db', () => ({
  getReceipt: vi.fn(async () => ({ id: 'r1', uploadedByKey: null, funding: 'unknown', paymentMethod: null })),
  fileReceipt: vi.fn(async () => ({ ok: true, status: 'filed', reasons: [] })),
  inventoryVehicleExists: vi.fn(async () => true),
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
  RATE_LIMITS: { file: { limit: 60, windowMs: 600000 } },
}))

import { receiptManager, receiptUploader } from './authz'
import { setReceiptVehicle, vehicleExpenseCandidates } from './vehicle-link'
import { assignReceiptVehicleAction, unassignReceiptVehicleAction, vehicleExpenseCandidatesAction } from './vehicle-actions'
import { fileReceiptAction } from './actions'
import * as db from './db'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const sharedPinEmployee = { actor: null, name: 'Shop device' }               // shared PIN: no individual identity
const manager = { key: 'darryl', name: 'Darryl', role: 'manager' }
const FILE = { id: 'r1', token: 'tok', entity: 'auto_sales', category: 'parts', categoryMode: 'single', paymentChoice: 'extraco_check', vendor: 'NAPA', receiptDate: '2026-11-18', total: '25.00' }

beforeEach(() => {
  vi.clearAllMocks()
  asMock(receiptManager).mockResolvedValue(null)
  asMock(receiptUploader).mockResolvedValue(sharedPinEmployee)
  asMock(db.fileReceipt).mockResolvedValue({ ok: true, status: 'filed', reasons: [] })
  asMock(db.inventoryVehicleExists).mockResolvedValue(true)
  asMock(setReceiptVehicle).mockResolvedValue({ ok: true, inventoryVehicleId: 'veh-1', previousVehicleId: null })
})

describe('shared-PIN employee', () => {
  it('CAN assign a vehicle while filing a receipt they just captured', async () => {
    const r = await fileReceiptAction({ ...FILE, inventoryVehicleId: 'veh-1' })
    expect(r).toMatchObject({ ok: true, status: 'filed', vehicleLinked: true })
    expect(asMock(setReceiptVehicle)).toHaveBeenCalledWith({ receiptId: 'r1', inventoryVehicleId: 'veh-1', matchEventId: null }, { name: 'Shop device', key: null })
    // The vehicle is never written by the filing itself — only by the one assignment path.
    expect('inventoryVehicleId' in asMock(db.fileReceipt).mock.calls[0][1]).toBe(false)
  })

  it('CAN say the purchase is already on the vehicle (matched, counted once)', async () => {
    await fileReceiptAction({ ...FILE, inventoryVehicleId: 'veh-1', vehicleMatchEventId: 'e1' })
    expect(asMock(setReceiptVehicle).mock.calls[0][0]).toEqual({ receiptId: 'r1', inventoryVehicleId: 'veh-1', matchEventId: 'e1' })
  })

  it('CAN look up what is already entered on a vehicle (needed to answer that question)', async () => {
    const r = await vehicleExpenseCandidatesAction({ inventoryVehicleId: 'veh-1', total: '10.00', date: '2026-11-01' })
    expect(r.ok).toBe(true)
    expect(asMock(vehicleExpenseCandidates)).toHaveBeenCalledWith('veh-1', { amountCents: 1000, date: '2026-11-01', receiptId: null })
  })

  it('CANNOT assign, move or remove the vehicle on an existing receipt', async () => {
    expect(await assignReceiptVehicleAction({ receiptId: 'r1', inventoryVehicleId: 'veh-1' })).toMatchObject({ ok: false, error: expect.stringMatching(/Manager sign-in required/) })
    expect(await unassignReceiptVehicleAction({ receiptId: 'r1' })).toMatchObject({ ok: false, error: expect.stringMatching(/Manager sign-in required/) })
    expect(asMock(setReceiptVehicle)).not.toHaveBeenCalled()
  })

  it('CANNOT re-point an already-filed receipt by submitting the filing again', async () => {
    asMock(db.fileReceipt).mockResolvedValue({ ok: true, alreadyFiled: true, status: 'filed', reasons: [] })
    const r = await fileReceiptAction({ ...FILE, inventoryVehicleId: 'veh-2' })
    expect(r.ok).toBe(true)
    expect(asMock(setReceiptVehicle)).not.toHaveBeenCalled()
  })

  it('cannot put one receipt on a customer job AND a vehicle, or on a vehicle that does not exist (nothing is filed)', async () => {
    expect((await fileReceiptAction({ ...FILE, inventoryVehicleId: 'veh-1', serviceOrderId: 'job-1' })).ok).toBe(false)
    asMock(db.inventoryVehicleExists).mockResolvedValue(false)
    expect((await fileReceiptAction({ ...FILE, inventoryVehicleId: 'veh-x' })).ok).toBe(false)
    expect(asMock(db.fileReceipt)).not.toHaveBeenCalled()
  })

  it('a refused assignment never un-saves the receipt — it is reported', async () => {
    asMock(setReceiptVehicle).mockResolvedValue({ ok: false, error: 'This receipt is attached to a customer job.' })
    expect(await fileReceiptAction({ ...FILE, inventoryVehicleId: 'veh-1' })).toMatchObject({ ok: true, vehicleLinked: false, vehicleLinkError: expect.stringMatching(/customer job/) })
  })

  it('filing with no vehicle never touches the assignment path', async () => {
    expect((await fileReceiptAction(FILE)).ok).toBe(true)
    expect(asMock(setReceiptVehicle)).not.toHaveBeenCalled()
  })
})

describe('anonymous', () => {
  it('gets nothing: no lookup, no filing, no assignment', async () => {
    asMock(receiptUploader).mockResolvedValue(null)
    expect(await vehicleExpenseCandidatesAction({ inventoryVehicleId: 'veh-1' })).toEqual({ ok: false, candidates: [] })
    expect((await fileReceiptAction({ ...FILE, inventoryVehicleId: 'veh-1' })).ok).toBe(false)
    expect((await assignReceiptVehicleAction({ receiptId: 'r1', inventoryVehicleId: 'veh-1' })).ok).toBe(false)
    expect(asMock(vehicleExpenseCandidates)).not.toHaveBeenCalled()
    expect(asMock(setReceiptVehicle)).not.toHaveBeenCalled()
  })
})

describe('manager', () => {
  it('can assign and remove on an existing receipt, attributed to the real manager', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    expect((await assignReceiptVehicleAction({ receiptId: 'r1', inventoryVehicleId: 'veh-1', matchEventId: 'e1' })).ok).toBe(true)
    expect(asMock(setReceiptVehicle)).toHaveBeenLastCalledWith({ receiptId: 'r1', inventoryVehicleId: 'veh-1', matchEventId: 'e1' }, { name: 'Darryl', key: 'darryl' })
    expect((await unassignReceiptVehicleAction({ receiptId: 'r1' })).ok).toBe(true)
    expect(asMock(setReceiptVehicle)).toHaveBeenLastCalledWith({ receiptId: 'r1', inventoryVehicleId: null }, { name: 'Darryl', key: 'darryl' })
  })
})
