import { afterAll, beforeAll, beforeEach, expect, it, describe, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { randomUUID } from 'node:crypto'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
// The estimate/invoice path is already covered by its own tests; here we assert the parts↔billing
// orchestration (idempotency, sell-price guard, link) around it.
const estimateMocks = vi.hoisted(() => ({
  getOrCreateEstimate: vi.fn(),
  addService: vi.fn(),
  addLine: vi.fn(),
  recomputeEstimate: vi.fn(),
  flagQbSyncNeededIfInvoiced: vi.fn(),
}))
vi.mock('@/apps/workflow/estimate-db', () => estimateMocks)
import { getDb } from '@/platform/db'
import {
  addPart, markOrdered, receivePart, recordReturn, cancelPart,
  listPartsForOrder, ordersWithWaitingParts, billPart,
} from './db'

const pg = new PGlite()
afterAll(() => pg.close())

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE job_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_estimate_id uuid, title text);
    CREATE TABLE job_line_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_service_id uuid);
    CREATE TABLE job_parts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_order_id uuid NOT NULL,
      job_line_item_id uuid,
      description text NOT NULL,
      part_number text, brand text, supplier text, provider text, provider_ref text,
      quantity numeric(10,2) NOT NULL DEFAULT 1,
      unit_cost_cents int, sell_price_cents int,
      status varchar(24) NOT NULL DEFAULT 'needed',
      supplier_order_number text, ordered_at timestamptz, expected_arrival date,
      received_quantity numeric(10,2) NOT NULL DEFAULT 0,
      is_core boolean NOT NULL DEFAULT false, core_credit_cents int,
      returned_quantity numeric(10,2) NOT NULL DEFAULT 0, return_credit_cents int,
      notes text, created_by text, updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `)
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})

const EST = '00000000-0000-0000-0000-0000000e5100'
const SVC = '00000000-0000-0000-0000-00000005e5c0'
beforeEach(async () => {
  await pg.exec('DELETE FROM job_parts; DELETE FROM job_line_items; DELETE FROM job_services;')
  estimateMocks.getOrCreateEstimate.mockClear().mockResolvedValue({ id: EST })
  estimateMocks.addService.mockClear().mockResolvedValue({ id: SVC })
  // addLine inserts a real row so listPartsForOrder's "billed" join reflects a live line.
  estimateMocks.addLine.mockClear().mockImplementation(async () => {
    const r = await pg.query<{ id: string }>(`INSERT INTO job_line_items(job_service_id) VALUES ('${SVC}') RETURNING id`)
    return { id: r.rows[0].id }
  })
  estimateMocks.recomputeEstimate.mockClear().mockResolvedValue(undefined)
  estimateMocks.flagQbSyncNeededIfInvoiced.mockClear().mockResolvedValue(false)
})

const ORDER = randomUUID()

describe('addPart', () => {
  it('always starts as "needed" — saving never implies an order', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Brake pads', quantity: 2, unitCostCents: 3000, actor: 'Tony' })
    expect(p.status).toBe('needed')
    expect(p.quantity).toBe(2)
    expect(p.waiting).toBe(true)
    expect(p.supplierOrderNumber).toBeNull()
  })
})

describe('markOrdered — fail closed without evidence', () => {
  it('refuses to mark ordered with no supplier and no confirmation', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Rotor' })
    const r = await markOrdered(p.id, {})
    expect(r.ok).toBe(false)
  })
  it('marks ordered when a supplier is given', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Rotor' })
    const r = await markOrdered(p.id, { supplier: "O'Reilly", expectedArrival: '2026-10-05' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.part.status).toBe('ordered')
      expect(r.part.supplier).toBe("O'Reilly")
      expect(r.part.expectedArrival).toBe('2026-10-05')
    }
  })
})

describe('receive — partial then full', () => {
  it('transitions ordered → partially_received → received', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Filter', quantity: 3 })
    await markOrdered(p.id, { supplierOrderNumber: 'CONF-9' })
    const r1 = await receivePart(p.id, 1)
    expect(r1.ok && r1.part.status).toBe('partially_received')
    expect(r1.ok && r1.part.outstandingQuantity).toBe(2)
    const r2 = await receivePart(p.id, 2)
    expect(r2.ok && r2.part.status).toBe('received')
    expect(r2.ok && r2.part.outstandingQuantity).toBe(0)
  })
  it('rejects non-positive receive quantity', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'X' })
    await markOrdered(p.id, { supplier: 'NAPA' })
    const r = await receivePart(p.id, 0)
    expect(r.ok).toBe(false)
  })
})

describe('returns & core credit', () => {
  it('records returned quantity and accumulates credits', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Alternator', quantity: 1 })
    await markOrdered(p.id, { supplier: 'Dealer' })
    await receivePart(p.id, 1)
    const r = await recordReturn(p.id, { returnQty: 1, returnCreditCents: 5000, isCore: true, coreCreditCents: 2500 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.part.returnedQuantity).toBe(1)
      expect(r.part.returnCreditCents).toBe(5000)
      expect(r.part.coreCreditCents).toBe(2500)
      expect(r.part.isCore).toBe(true)
    }
  })
})

describe('cancel is terminal for the waiting signal', () => {
  it('cancelled parts never count as waiting', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Hose' })
    await cancelPart(p.id)
    const parts = await listPartsForOrder(ORDER)
    expect(parts[0].status).toBe('cancelled')
    expect(parts[0].waiting).toBe(false)
  })
})

describe('parts ↔ billing — explicit, idempotent, no missing/duplicate charge', () => {
  it('refuses to bill without a sell price (prevents a $0 / missing charge)', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Pump', unitCostCents: 4000 })
    const r = await billPart(p.id)
    expect(r.ok).toBe(false)
    expect(estimateMocks.addLine).not.toHaveBeenCalled()
  })

  it('creates exactly one invoice line and links the part', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Pump', partNumber: 'P-9', quantity: 2, unitCostCents: 4000, sellPriceCents: 6000 })
    const r = await billPart(p.id, 'Tony')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.part.billed).toBe(true)
    expect(estimateMocks.addLine).toHaveBeenCalledTimes(1)
    const [, lineInput] = estimateMocks.addLine.mock.calls[0]
    expect(lineInput).toMatchObject({ type: 'part', priceCents: 6000, qty: 2, taxCategory: 'repair_parts' })
    // The part is now linked to a live line.
    const parts = await listPartsForOrder(ORDER)
    expect(parts[0].billed).toBe(true)
  })

  it('is idempotent — billing an already-billed part makes no second line', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Pump', sellPriceCents: 6000 })
    await billPart(p.id)
    estimateMocks.addLine.mockClear()
    const again = await billPart(p.id)
    expect(again.ok).toBe(true)
    expect(estimateMocks.addLine).not.toHaveBeenCalled()
  })

  it('a part whose invoice line was deleted reads unbilled again (no silently-missing charge)', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Pump', sellPriceCents: 6000 })
    await billPart(p.id)
    await pg.exec('DELETE FROM job_line_items;') // line removed on the estimate side
    const parts = await listPartsForOrder(ORDER)
    expect(parts[0].billed).toBe(false)
  })
})

describe('outstanding returns / core credits stay visible after receiving', () => {
  it('a core charge remains flagged outstanding even once the part is received', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Battery', quantity: 1, isCore: true })
    await markOrdered(p.id, { supplier: 'NAPA' })
    await receivePart(p.id, 1)
    const parts = await listPartsForOrder(ORDER)
    expect(parts[0].status).toBe('received')
    expect(parts[0].creditOutstanding).toBe(true) // core deposit not yet credited back
  })
  it('clears once the core credit is recorded', async () => {
    const p = await addPart({ serviceOrderId: ORDER, description: 'Battery', quantity: 1, isCore: true })
    await markOrdered(p.id, { supplier: 'NAPA' })
    await receivePart(p.id, 1)
    await recordReturn(p.id, { returnQty: 0, isCore: true, coreCreditCents: 1500 })
    const parts = await listPartsForOrder(ORDER)
    expect(parts[0].creditOutstanding).toBe(false)
  })
})

describe('ordersWithWaitingParts — Work Board indicator source', () => {
  it('flags only orders with an outstanding part', async () => {
    const other = randomUUID()
    const waiting = await addPart({ serviceOrderId: ORDER, description: 'A' })
    await markOrdered(waiting.id, { supplier: 'NAPA' })      // ordered → waiting
    const done = await addPart({ serviceOrderId: other, description: 'B', quantity: 1 })
    await markOrdered(done.id, { supplier: 'NAPA' })
    await receivePart(done.id, 1)                             // received → not waiting
    const set = await ordersWithWaitingParts([ORDER, other])
    expect(set.has(ORDER)).toBe(true)
    expect(set.has(other)).toBe(false)
  })
})
