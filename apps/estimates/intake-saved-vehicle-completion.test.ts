/**
 * REGRESSION (Codex review of 89fef12): details typed to complete a SAVED vehicle were discarded —
 * createIntake recorded the saved row as-is. Now the completed values are stored on the estimate/intake
 * AND filled onto the same vehicle row (guarded per field, audited), with no duplicate vehicle and the
 * VIN and existing valid fields preserved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'

type Write = { table: string; kind: 'insert' | 'update'; values: Record<string, unknown>; where?: unknown }
type Table = Parameters<typeof getTableName>[0]
const state = vi.hoisted(() => ({ saved: null as Record<string, unknown> | null, exists: false, writes: [] as { table: string; kind: string; values: Record<string, unknown>; where?: unknown }[] }))
vi.mock('@/platform/db', () => ({ getDb: () => ({
  select: () => {
    let table = ''
    const rows = () => table === 'estimate_intakes' ? (state.exists ? [{}] : []) : table === 'service_catalog' || table === 'service_aliases' ? [] : (state.saved ? [state.saved] : [])
    const q = {
      from: (t: Table) => { table = getTableName(t); return q }, where: () => q, orderBy: () => q,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
      limit: () => Promise.resolve(state.saved ? [state.saved] : []),
    }
    return q
  },
  insert: (t: Table) => ({ values: (values: Record<string, unknown>): Write => ({ table: getTableName(t), kind: 'insert', values }) }),
  update: (t: Table) => ({ set: (values: Record<string, unknown>) => ({ where: (where: unknown): Write => ({ table: getTableName(t), kind: 'update', values, where }) }) }),
  batch: async (writes: Write[]) => { state.writes.push(...writes); state.exists = true },
}) }))
vi.mock('@/apps/settings/db', () => ({ getBusinessConfig: async () => ({ defaultTaxBps: 825 }) }))
vi.mock('@/apps/workflow/estimate-db', () => ({ getEstimateRow: async () => ({ id: 'estimate' }), recomputeEstimate: vi.fn() }))
import { createIntake, intakeInput } from './db'

const SAVED_ID = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const VIN = '1GT12SEG4GF221480'
const input = (over: Partial<ReturnType<typeof intakeInput.parse>> = {}) => intakeInput.parse({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', customerName: 'Brian Returning',
  year: '2019', make: 'GMC', model: 'Sierra', vehicleId: SAVED_ID, lines: [], ...over })
// Flatten a drizzle SQL template to its literal text (parameters elided) for assertions on the guard.
const sqlText = (v: unknown): string => {
  const chunks = (v as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks.map((c) => (c && typeof c === 'object' && 'value' in c && Array.isArray((c as { value: unknown }).value) ? ((c as { value: string[] }).value).join('') : '')).join('')
}
beforeEach(() => { state.saved = null; state.exists = false; state.writes = [] })

describe('createIntake with a saved vehicle that needs completing', () => {
  it('saved make/model but no year: keeps the vehicle id and VIN, records the completed vehicle, fills the row in place, audits it', async () => {
    state.saved = { id: SAVED_ID, year: null, make: 'GMC', model: 'Sierra', vin: VIN }
    await createIntake(input({ make: 'Chevrolet', model: 'Silverado' }), 'Manager')   // typed make/model must NOT replace what is on file
    expect(state.writes.filter((w) => w.table === 'vehicles' && w.kind === 'insert')).toHaveLength(0)       // no duplicate vehicle
    expect(state.writes.find((w) => w.table === 'service_orders')?.values).toMatchObject({ vehicleId: SAVED_ID })
    expect(state.writes.find((w) => w.table === 'quick_entry_jobs')?.values).toMatchObject({ vehicleId: SAVED_ID, year: '2019', make: 'GMC', model: 'Sierra', vin: VIN })
    const upd = state.writes.find((w) => w.table === 'vehicles' && w.kind === 'update')
    expect(upd).toBeTruthy()
    expect(Object.keys(upd!.values).sort()).toEqual(['make', 'model', 'year'])   // VIN never part of the write
    // Guarded SQL: a field that is already valid on the row wins over the typed value.
    expect(sqlText(upd!.values.year)).toContain('CASE WHEN')
    expect(sqlText(upd!.values.make)).toContain('COALESCE(NULLIF(btrim(')
    const audit = state.writes.find((w) => w.table === 'service_order_events' && w.values.eventType === 'vehicle_corrected')
    expect(audit?.values).toMatchObject({ employeeName: 'Manager' })
    expect(JSON.parse(String(audit!.values.note))).toMatchObject({ changed: ['year'], old: { year: null }, new: { year: '2019' } })
  })
  it('missing make and model: the completed values are stored on the intake and filled on the row', async () => {
    state.saved = { id: SAVED_ID, year: '2016', make: null, model: '', vin: VIN }
    await createIntake(input({ year: '2019', make: 'GMC', model: 'Sierra' }), 'Manager')
    expect(state.writes.find((w) => w.table === 'quick_entry_jobs')?.values).toMatchObject({ year: '2016', make: 'GMC', model: 'Sierra', vin: VIN })   // valid saved year kept
    const audit = state.writes.find((w) => w.table === 'service_order_events' && w.values.eventType === 'vehicle_corrected')
    expect(JSON.parse(String(audit!.values.note)).changed).toEqual(['make', 'model'])
  })
  it('a nonempty invalid saved year is corrected, not kept', async () => {
    state.saved = { id: SAVED_ID, year: '19', make: 'GMC', model: 'Sierra', vin: null }
    await createIntake(input(), 'Manager')
    expect(state.writes.find((w) => w.table === 'quick_entry_jobs')?.values).toMatchObject({ year: '2019', vin: null })
    expect(JSON.parse(String(state.writes.find((w) => w.table === 'service_order_events' && w.values.eventType === 'vehicle_corrected')!.values.note))).toMatchObject({ old: { year: '19' }, new: { year: '2019' } })
  })
  it('a complete saved vehicle gets no write and no audit event, and the intake records what is on file', async () => {
    state.saved = { id: SAVED_ID, year: '2016', make: 'GMC', model: 'Sierra', vin: VIN }
    await createIntake(input({ year: '2019', make: 'Ford', model: 'F-150' }), 'Manager')
    expect(state.writes.filter((w) => w.table === 'vehicles')).toHaveLength(0)
    expect(state.writes.filter((w) => w.table === 'service_order_events').map((w) => w.values.eventType)).toEqual(['estimate_intake'])
    expect(state.writes.find((w) => w.table === 'quick_entry_jobs')?.values).toMatchObject({ year: '2016', make: 'GMC', model: 'Sierra', vin: VIN })
  })
})
