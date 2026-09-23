import { beforeEach, expect, it, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'
const state = vi.hoisted(() => ({ saved: null as Record<string, unknown> | null, exists: false, writes: [] as { table: string; values: any }[] }))
vi.mock('@/platform/db', () => ({ getDb: () => ({
  select: () => { let table = ''; const q: any = {
    from: (t: any) => { table = getTableName(t); return q }, where: () => q, orderBy: () => q,
    then: (resolve: any) => Promise.resolve(table === 'estimate_intakes' ? (state.exists ? [{}] : []) : (state.saved ? [state.saved] : [])).then(resolve),
    limit: () => Promise.resolve(state.saved ? [state.saved] : []),
  }; return q },
  insert: (t: any) => ({ values: (values: any) => ({ table: getTableName(t), values }) }),
  batch: async (writes: any[]) => { state.writes.push(...writes); state.exists = true },
}) }))
vi.mock('@/apps/settings/db', () => ({ getBusinessConfig: async () => ({ defaultTaxBps: 825 }) }))
vi.mock('@/apps/workflow/estimate-db', () => ({ getEstimateRow: async () => ({ id: 'estimate' }), recomputeEstimate: vi.fn() }))
import { createIntake, intakeInput } from './db'
const input = () => intakeInput.parse({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', customerName: 'Returning Customer', year: '2018', make: 'Jeep', model: 'Wrangler', vin: '1C4HJXDG0JW123456', lines: [{ name: 'Interior detail', priceCents: 30000 }] })
beforeEach(() => { state.saved = null; state.exists = false; state.writes = [] })
it('reuses the VIN match and saves priced services as an unsent estimate, with safe retries', async () => {
  state.saved = { id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', year: '2018', make: 'Jeep', model: 'Wrangler', vin: input().vin }
  await createIntake(input(), 'Manager')
  await createIntake(input(), 'Manager')
  expect(state.writes.filter(w => w.table === 'vehicles')).toHaveLength(0)
  expect(state.writes.filter(w => w.table === 'service_orders')).toEqual([{ table: 'service_orders', values: expect.objectContaining({ vehicleId: state.saved.id, status: 'estimate', source: 'estimate' }) }])
  expect(state.writes.find(w => w.table === 'job_line_items')?.values).toEqual([expect.objectContaining({ name: 'Interior detail', priceCents: 30000 })])
  expect(state.writes.find(w => w.table === 'job_estimates')?.values).toMatchObject({ priceMode: 'itemized', explicitTotalCents: null })
  expect(state.writes.find(w => w.table === 'estimate_intakes')?.values).not.toHaveProperty('sentAt')
})
it('creates a new vehicle only when no saved vehicle matches and preserves work-price override', async () => {
  await createIntake({ ...input(), workPriceCents: 40000 }, 'Manager')
  expect(state.writes.filter(w => w.table === 'vehicles')).toHaveLength(1)
  expect(state.writes.find(w => w.table === 'job_estimates')?.values).toMatchObject({ priceMode: 'explicit_pretax', explicitTotalCents: 40000 })
})
it('rejects a missing selected vehicle before writing', async () => {
  await expect(createIntake({ ...input(), vehicleId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, 'Manager')).rejects.toThrow('Saved vehicle not found')
  expect(state.writes).toHaveLength(0)
})
it('rejects invalid money and accepts an unpriced estimate', () => {
  expect(() => intakeInput.parse({ ...input(), lines: [{ name: 'Detail', priceCents: -1 }] })).toThrow()
  expect(intakeInput.parse({ ...input(), lines: [] }).lines).toEqual([])
})
