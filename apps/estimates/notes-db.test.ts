/**
 * saveCustomerNotes persistence + audit (PGlite, same pattern as move-to-estimates.test.ts). Verifies the
 * single-CTE write touches only customer_notes/updated_by, keeps multiline verbatim, appends exactly one
 * audit event, is scoped so a mismatched id writes nothing, and is parameterized (SQL metacharacters stored
 * literally, never executed).
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { randomUUID } from 'node:crypto'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { saveCustomerNotes } from './notes-db'

const pg = new PGlite()
afterAll(() => pg.close())

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE job_estimates(id uuid DEFAULT gen_random_uuid(), service_order_id uuid UNIQUE,
      customer_notes text, total_cents int DEFAULT 1234, updated_at timestamptz, updated_by text);
    CREATE TABLE service_order_events(service_order_id uuid, event_type text, employee_name text, note text,
      created_at timestamptz DEFAULT now());
  `)
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})

beforeEach(async () => { await pg.exec(`TRUNCATE job_estimates, service_order_events`) })

async function seed() {
  const orderId = randomUUID()
  const estimateId = randomUUID()
  await pg.query(`INSERT INTO job_estimates(id, service_order_id, customer_notes) VALUES ($1,$2,NULL)`, [estimateId, orderId])
  return { orderId, estimateId }
}
const row = (estimateId: string) => pg.query<{ customer_notes: string | null; updated_by: string | null; total_cents: number }>(
  `SELECT customer_notes, updated_by, total_cents FROM job_estimates WHERE id=$1`, [estimateId]).then((r) => r.rows[0])
const events = (orderId: string) => pg.query<{ event_type: string; employee_name: string; note: string }>(
  `SELECT event_type, employee_name, note FROM service_order_events WHERE service_order_id=$1 ORDER BY created_at`, [orderId]).then((r) => r.rows)

it('persists multiline notes + one audit event, stamps updated_by, leaves pricing untouched', async () => {
  const { orderId, estimateId } = await seed()
  await saveCustomerNotes({ orderId, estimateId, notes: 'Claim number: ABC-123\nAdjuster: Jane', actor: 'Manager' })
  expect(await row(estimateId)).toMatchObject({ customer_notes: 'Claim number: ABC-123\nAdjuster: Jane', updated_by: 'Manager', total_cents: 1234 })
  expect(await events(orderId)).toEqual([{ event_type: 'estimate_customer_notes', employee_name: 'Manager', note: 'Customer notes updated' }])
})

it('clearing notes writes NULL with a distinct cleared audit event', async () => {
  const { orderId, estimateId } = await seed()
  await saveCustomerNotes({ orderId, estimateId, notes: 'Claim: A', actor: 'Alice' })
  await saveCustomerNotes({ orderId, estimateId, notes: '', actor: 'Bob' })
  expect((await row(estimateId)).customer_notes).toBeNull()
  const ev = await events(orderId)
  expect(ev).toHaveLength(2)
  expect(ev[1]).toMatchObject({ note: 'Customer notes cleared', employee_name: 'Bob' })
})

it('updates nothing and writes no event when the id/order pair does not match', async () => {
  const { orderId, estimateId } = await seed()
  await saveCustomerNotes({ orderId, estimateId: randomUUID(), notes: 'nope', actor: 'Alice' })   // wrong estimate id
  await saveCustomerNotes({ orderId: randomUUID(), estimateId, notes: 'nope', actor: 'Alice' })   // wrong order id
  expect((await row(estimateId)).customer_notes).toBeNull()
  expect(await events(orderId)).toHaveLength(0)
})

it('stores SQL metacharacters verbatim (parameterized, never executed)', async () => {
  const { orderId, estimateId } = await seed()
  const nasty = `'); DROP TABLE job_estimates; --`
  await saveCustomerNotes({ orderId, estimateId, notes: nasty, actor: 'Alice' })
  expect((await row(estimateId)).customer_notes).toBe(nasty)
  // The table still exists and still has our row (the injection was not executed).
  expect(await events(orderId)).toHaveLength(1)
})
