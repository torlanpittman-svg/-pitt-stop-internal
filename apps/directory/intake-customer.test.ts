/**
 * Regression coverage for the Work Board / Quick Entry → customer directory promotion bug:
 * intake customers used to be invisible on /customers because no canonical `customers` row was
 * created. These tests lock in: a new intake becomes searchable, a returning customer is REUSED
 * (never duplicated), placeholder/ambiguous contacts never merge two people, and the vehicle link
 * is idempotent.
 */
import { afterAll, beforeAll, beforeEach, expect, it, describe, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { findOrCreateIntakeCustomer } from './intake-customer'
import { searchCustomers } from './customer-profile'

const pg = new PGlite()
afterAll(() => pg.close())

const V1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const V2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const V3 = 'aaaaaaaa-0000-0000-0000-000000000003'
const EXISTING = '11111111-1111-1111-1111-111111111111' // pre-seeded, has unique email + phone
const SH1 = '22222222-2222-2222-2222-222222222222'       // shares a phone with SH2
const SH2 = '33333333-3333-3333-3333-333333333333'

async function reseed() {
  await pg.exec(`
    DROP TABLE IF EXISTS customers, customer_vehicles, vehicles CASCADE;
    CREATE TABLE customers(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name varchar(120), last_name varchar(120), display_name varchar(240), company varchar(240),
      phone varchar(40), normalized_phone varchar(20), email varchar(240), normalized_email varchar(240),
      customer_type varchar(20) NOT NULL DEFAULT 'retail',
      active boolean NOT NULL DEFAULT true,
      source varchar(20) NOT NULL DEFAULT 'autoleap',
      source_key varchar(240),
      autoleap_customer_id varchar(120),
      quickbooks_customer_id varchar(120),
      autoleap_vehicle_count integer,
      source_values jsonb NOT NULL DEFAULT '{}',
      created_by_import_batch_id uuid,
      first_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE customer_vehicles(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL, vehicle_id uuid NOT NULL,
      relationship varchar(20) NOT NULL DEFAULT 'owner',
      source varchar(20) NOT NULL DEFAULT 'autoleap',
      created_by_import_batch_id uuid,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(customer_id, vehicle_id));
    CREATE TABLE vehicles(id uuid PRIMARY KEY, year text, make text, model text, color text,
      vin text, license_plate text, created_at timestamptz DEFAULT now());

    INSERT INTO customers(id, display_name, phone, normalized_phone, email, normalized_email, source) VALUES
      ('${EXISTING}', 'Dana Woody', '(979) 555-0640', '9795550640', 'dana@x.com', 'dana@x.com', 'autoleap'),
      ('${SH1}', 'Shared One', '555-000-0000', '5550000000', 's1@x.com', 's1@x.com', 'autoleap'),
      ('${SH2}', 'Shared Two', '555-000-0000', '5550000000', 's2@x.com', 's2@x.com', 'autoleap');
    INSERT INTO vehicles(id, year, make, model, vin, license_plate) VALUES
      ('${V1}', '2020', 'Honda', 'Civic', '1HGCV1F30LA123456', 'ABC1234'),
      ('${V2}', '2019', 'Toyota', 'Camry', '4T1B11HK5KU999999', 'XYZ9999'),
      ('${V3}', '2018', 'Ford', 'F150', NULL, NULL);
  `)
}

beforeAll(async () => {
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
  await reseed()
})
beforeEach(reseed)

async function countCustomers(): Promise<number> {
  const r = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM customers')
  return r.rows[0].n
}

describe('findOrCreateIntakeCustomer — Work Board customer persistence', () => {
  it('creates a canonical, searchable customer for a brand-new intake', async () => {
    const link = await findOrCreateIntakeCustomer({ name: 'Douglas Moralize', phone: '979-555-1212', email: 'doug@x.com' }, V1)
    expect(link).not.toBeNull()
    expect(link!.created).toBe(true)

    const hits = await searchCustomers('Moralize')
    expect(hits.find((h) => h.id === link!.id)).toBeTruthy()
    // searchable by phone digits too
    expect((await searchCustomers('9795551212')).find((h) => h.id === link!.id)).toBeTruthy()
  })

  it('links the vehicle so plate/VIN search resolves to the customer', async () => {
    const link = await findOrCreateIntakeCustomer({ name: 'Chad Brantley', phone: '979-555-7777', email: null }, V1)
    const hit = (await searchCustomers('ABC1234')).find((h) => h.id === link!.id)
    expect(hit).toBeTruthy()
    expect(hit!.matchedVia).toBe('vehicle')
  })

  it('REUSES an existing customer by unique email — never duplicates', async () => {
    const before = await countCustomers()
    const link = await findOrCreateIntakeCustomer({ name: 'Dana W.', email: 'dana@x.com', phone: '000' }, V2)
    expect(link!.id).toBe(EXISTING)
    expect(link!.created).toBe(false)
    expect(await countCustomers()).toBe(before) // no new row
  })

  it('REUSES an existing customer by unique phone when email is absent', async () => {
    const before = await countCustomers()
    const link = await findOrCreateIntakeCustomer({ name: 'Dana Different Name', phone: '(979) 555-0640' }, V2)
    expect(link!.id).toBe(EXISTING)
    expect(await countCustomers()).toBe(before)
  })

  it('does NOT merge on a placeholder email (no@no.com) — creates a distinct row', async () => {
    const before = await countCustomers()
    const link = await findOrCreateIntakeCustomer({ name: 'George Bond', email: 'no@no.com' }, V3)
    expect(link!.created).toBe(true)
    expect(await countCustomers()).toBe(before + 1)
  })

  it('does NOT merge on a phone shared by >1 customer (ambiguous) — creates a distinct row', async () => {
    const before = await countCustomers()
    const link = await findOrCreateIntakeCustomer({ name: 'Someone New', phone: '555-000-0000' }, V3)
    expect(link!.created).toBe(true)
    expect(link!.id).not.toBe(SH1)
    expect(link!.id).not.toBe(SH2)
    expect(await countCustomers()).toBe(before + 1)
  })

  it('never merges by name alone (no contact) — a second same-named intake stays distinct', async () => {
    const before = await countCustomers()
    const a = await findOrCreateIntakeCustomer({ name: 'John Smith' }, V1)
    const b = await findOrCreateIntakeCustomer({ name: 'John Smith' }, V2)
    expect(a!.id).not.toBe(b!.id)
    expect(await countCustomers()).toBe(before + 2)
  })

  it('returns null for a blank name (never creates an empty identity row)', async () => {
    const before = await countCustomers()
    expect(await findOrCreateIntakeCustomer({ name: '   ' }, V1)).toBeNull()
    expect(await countCustomers()).toBe(before)
  })

  it('is idempotent on re-check-in: same customer + vehicle does not duplicate the vehicle link', async () => {
    const a = await findOrCreateIntakeCustomer({ name: 'Repeat Rita', email: 'rita@x.com' }, V1)
    const b = await findOrCreateIntakeCustomer({ name: 'Repeat Rita', email: 'rita@x.com' }, V1)
    expect(b!.id).toBe(a!.id)
    const r = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM customer_vehicles WHERE customer_id = '${a!.id}' AND vehicle_id = '${V1}'`,
    )
    expect(r.rows[0].n).toBe(1)
  })
})
