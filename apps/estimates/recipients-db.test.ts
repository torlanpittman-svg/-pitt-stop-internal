/**
 * saveSavedRecipients persistence + audit (PGlite, same pattern as notes-db.test.ts). Verifies the single
 * CTE write touches only estimate_intakes.saved_recipients, keeps NULL vs [] vs a list distinct, preserves
 * order, appends exactly one audit event, is scoped so a mismatched order id writes nothing, and is
 * parameterized (address text stored literally, never executed).
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { saveSavedRecipients } from './recipients-db'

const pg = new PGlite()
afterAll(() => pg.close())

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE estimate_intakes(order_id uuid PRIMARY KEY, qb_estimate_id text);
    CREATE TABLE service_order_events(service_order_id uuid, event_type text, employee_name text, note text,
      created_at timestamptz DEFAULT now());
  `)
  const migration = readFileSync('drizzle/migrations/manual/0065_estimate_saved_recipients.sql', 'utf8')
  await pg.exec(migration)
  await pg.exec(migration) // Idempotent additive migration, exercised against the existing table.
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})

beforeEach(async () => { await pg.exec(`TRUNCATE estimate_intakes, service_order_events`) })

async function seed() {
  const orderId = randomUUID()
  await pg.query(`INSERT INTO estimate_intakes(order_id, saved_recipients, qb_estimate_id) VALUES ($1, NULL, 'qb-1')`, [orderId])
  return orderId
}
const row = (orderId: string) => pg.query<{ saved_recipients: string[] | null; qb_estimate_id: string | null }>(
  `SELECT saved_recipients, qb_estimate_id FROM estimate_intakes WHERE order_id=$1`, [orderId]).then((r) => r.rows[0])
const events = (orderId: string) => pg.query<{ event_type: string; employee_name: string; note: string }>(
  `SELECT event_type, employee_name, note FROM service_order_events WHERE service_order_id=$1 ORDER BY created_at`, [orderId]).then((r) => r.rows)

it('starts NULL (legacy), then persists a list IN ORDER with one audit event, leaving other columns untouched', async () => {
  const orderId = await seed()
  expect((await row(orderId)).saved_recipients).toBeNull()
  await saveSavedRecipients({ orderId, recipients: ['a@x.com', 'b@x.com'], actor: 'Manager' })
  const r = await row(orderId)
  expect(r.saved_recipients).toEqual(['a@x.com', 'b@x.com'])
  expect(r.qb_estimate_id).toBe('qb-1')   // QB linkage untouched
  expect(await events(orderId)).toEqual([{ event_type: 'estimate_saved_recipients', employee_name: 'Manager', note: 'Saved estimate recipients (2)' }])
})

it('round-trips an update then an explicit clear ([]), distinct from the legacy NULL, with distinct audit notes', async () => {
  const orderId = await seed()
  await saveSavedRecipients({ orderId, recipients: ['a@x.com'], actor: 'Alice' })
  await saveSavedRecipients({ orderId, recipients: [], actor: 'Bob' })
  const r = await row(orderId)
  expect(r.saved_recipients).toEqual([])        // explicitly cleared — an empty array, NOT null
  expect(r.saved_recipients).not.toBeNull()
  const ev = await events(orderId)
  expect(ev).toHaveLength(2)
  expect(ev[1]).toMatchObject({ note: 'Saved estimate recipients cleared', employee_name: 'Bob' })
})

it('updates nothing and writes no event when the order id does not match', async () => {
  const orderId = await seed()
  await saveSavedRecipients({ orderId: randomUUID(), recipients: ['x@x.com'], actor: 'Alice' })
  expect((await row(orderId)).saved_recipients).toBeNull()
  expect(await events(orderId)).toHaveLength(0)
})

it('stores address text with SQL metacharacters verbatim (parameterized, never executed)', async () => {
  const orderId = await seed()
  const nasty = `a@x.com'); DROP TABLE estimate_intakes; --`
  await saveSavedRecipients({ orderId, recipients: [nasty, 'b@x.com'], actor: 'Alice' })
  expect((await row(orderId)).saved_recipients).toEqual([nasty, 'b@x.com'])
  expect(await events(orderId)).toHaveLength(1)   // table still exists; injection not executed
})
