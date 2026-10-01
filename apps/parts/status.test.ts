import { expect, it, describe } from 'vitest'
import {
  canMarkOrdered,
  deriveReceivedStatus,
  applyReceipt,
  applyReturn,
  outstandingQuantity,
  isPartWaiting,
  orderHasWaitingParts,
  type PartState,
} from './status'

function part(over: Partial<PartState> = {}): PartState {
  return { status: 'needed', quantity: 4, receivedQuantity: 0, returnedQuantity: 0, ...over }
}

describe('canMarkOrdered — a part is only ordered with real evidence', () => {
  it('rejects when neither supplier nor confirmation present', () => {
    expect(canMarkOrdered({})).toBe(false)
    expect(canMarkOrdered({ supplier: '   ', supplierOrderNumber: '' })).toBe(false)
  })
  it('accepts with a supplier', () => {
    expect(canMarkOrdered({ supplier: 'NAPA' })).toBe(true)
  })
  it('accepts with a confirmation number', () => {
    expect(canMarkOrdered({ supplierOrderNumber: 'ABC-123' })).toBe(true)
  })
})

describe('deriveReceivedStatus', () => {
  it('full → received', () => expect(deriveReceivedStatus(4, 4)).toBe('received'))
  it('over → received (clamped upstream)', () => expect(deriveReceivedStatus(4, 9)).toBe('received'))
  it('partial → partially_received', () => expect(deriveReceivedStatus(4, 1)).toBe('partially_received'))
  it('none → ordered', () => expect(deriveReceivedStatus(4, 0)).toBe('ordered'))
})

describe('applyReceipt — clamps and transitions', () => {
  it('partial delivery → partially_received', () => {
    const r = applyReceipt(part({ status: 'ordered' }), 1)
    expect(r).toEqual({ receivedQuantity: 1, status: 'partially_received' })
  })
  it('accumulates to full → received', () => {
    const r = applyReceipt(part({ status: 'partially_received', receivedQuantity: 3 }), 1)
    expect(r).toEqual({ receivedQuantity: 4, status: 'received' })
  })
  it('clamps over-receipt to quantity', () => {
    const r = applyReceipt(part({ status: 'ordered' }), 99)
    expect(r.receivedQuantity).toBe(4)
    expect(r.status).toBe('received')
  })
  it('cancelled is terminal — receiving is a no-op', () => {
    const r = applyReceipt(part({ status: 'cancelled', receivedQuantity: 0 }), 2)
    expect(r).toEqual({ receivedQuantity: 0, status: 'cancelled' })
  })
})

describe('applyReturn', () => {
  it('accumulates returns, clamped to quantity', () => {
    expect(applyReturn(part({ returnedQuantity: 1 }), 2).returnedQuantity).toBe(3)
    expect(applyReturn(part({ returnedQuantity: 3 }), 5).returnedQuantity).toBe(4)
  })
  it('ignores negative return amounts', () => {
    expect(applyReturn(part({ returnedQuantity: 1 }), -5).returnedQuantity).toBe(1)
  })
})

describe('outstandingQuantity', () => {
  it('is quantity minus received for an in-flight part', () => {
    expect(outstandingQuantity(part({ status: 'ordered', receivedQuantity: 1 }))).toBe(3)
  })
  it('is zero when received or cancelled', () => {
    expect(outstandingQuantity(part({ status: 'received', receivedQuantity: 4 }))).toBe(0)
    expect(outstandingQuantity(part({ status: 'cancelled' }))).toBe(0)
  })
})

describe('waiting signal', () => {
  it('needed/ordered/partially are waiting; received/cancelled are not', () => {
    expect(isPartWaiting('needed')).toBe(true)
    expect(isPartWaiting('ordered')).toBe(true)
    expect(isPartWaiting('partially_received')).toBe(true)
    expect(isPartWaiting('received')).toBe(false)
    expect(isPartWaiting('cancelled')).toBe(false)
  })
  it('order with any outstanding part is waiting', () => {
    expect(orderHasWaitingParts([{ status: 'received' }, { status: 'ordered' }])).toBe(true)
    expect(orderHasWaitingParts([{ status: 'received' }, { status: 'cancelled' }])).toBe(false)
    expect(orderHasWaitingParts([])).toBe(false)
  })
})
