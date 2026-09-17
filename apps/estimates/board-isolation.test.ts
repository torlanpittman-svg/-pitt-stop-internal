import { beforeEach, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
const seen = vi.hoisted(() => ({ filters: [] as unknown[] }))
vi.mock('@/platform/db', () => ({ getDb: () => ({ select: () => {
  const query = {
    from: () => query, innerJoin: () => query,
    where: (filter: unknown) => { seen.filters.push(filter); return query },
    orderBy: () => query, limit: async () => [],
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  }
  return query
} }) }))
import { listActiveOrders, findActiveOrderByVehicleId, findActiveOrderByVin, canTransition } from '@/apps/workflow/db'
beforeEach(() => { seen.filters = [] })
for (const [name, read] of [
  ['work board', () => listActiveOrders()],
  ['active vehicle lookup', () => findActiveOrderByVehicleId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')],
  ['active VIN lookup', () => findActiveOrderByVin('1HGCM82633A123456')],
] as const) {
  it(`excludes estimate-only records from ${name}`, async () => {
    await read()
    const query = new PgDialect().sqlToQuery(seen.filters[0] as SQL)
    expect(query.sql.toLowerCase()).toContain('not')
    expect(query.params).toContain('estimate')
    expect(query.params).toContain('cancelled')
    expect(query.params).toContain('delivered')
  })
}
it('cannot start estimate work through ordinary status transitions', () => {
  expect(canTransition('estimate', 'in_progress')).toBe(false)
  expect(canTransition('estimate', 'arrived')).toBe(false)
})
