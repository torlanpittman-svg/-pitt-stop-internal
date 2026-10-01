import { afterAll, beforeAll, expect, it, describe, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { getCustomerProfile, getCustomerHistory, getVehicleServiceHistory, redactHistoryForEmployee, searchCustomers } from './customer-profile'

const pg = new PGlite()
afterAll(() => pg.close())

// Subjects
const C1 = '11111111-1111-1111-1111-111111111111' // Jane (name/phone/vehicle fixtures)
const C2 = '22222222-2222-2222-2222-222222222222' // John (a different person)
const A  = '33333333-3333-3333-3333-333333333333' // Alice — PRIOR owner of VX
const B  = '44444444-4444-4444-4444-444444444444' // Bob — CURRENT owner of VX
const S1 = '55555555-5555-5555-5555-555555555555' // shares a phone with S2
const S2 = '66666666-6666-6666-6666-666666666666'
const P1 = '77777777-7777-7777-7777-777777777777' // placeholder email no@no.com

const V1 = 'aaaaaaaa-0000-0000-0000-000000000001' // owned by C1
const V3 = 'cccccccc-0000-0000-0000-000000000003' // owned by nobody in tests
const VX = 'dddddddd-0000-0000-0000-00000000000x'.replace('x', '4') // VX, sold A → B
const VQ = 'eeeeeeee-0000-0000-0000-000000000005' // shared-contact order vehicle (unowned)

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE customers(
      id uuid PRIMARY KEY, display_name text, first_name text, last_name text, company text,
      phone text, normalized_phone text, email text, normalized_email text,
      customer_type text DEFAULT 'retail', source text DEFAULT 'manual', active boolean DEFAULT true);
    CREATE TABLE vehicles(id uuid PRIMARY KEY, year text, make text, model text, color text, vin text,
      license_plate text, created_at timestamptz DEFAULT now());
    CREATE TABLE customer_vehicles(customer_id uuid, vehicle_id uuid, relationship text DEFAULT 'owner',
      last_seen_at timestamptz DEFAULT now());
    CREATE TABLE service_orders(id uuid PRIMARY KEY, order_number text, customer_id uuid, vehicle_id uuid,
      status text, services jsonb, customer_name text, approved_price_cents int, quoted_price_cents int,
      completed_at timestamptz, arrived_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE quick_entry_jobs(service_order_id uuid, customer_phone text, customer_email text);
    CREATE TABLE job_estimates(service_order_id uuid, total_cents int, agreed_price_cents int,
      qb_invoice_number text, qb_status text DEFAULT 'none');

    INSERT INTO customers(id, display_name, normalized_phone, normalized_email) VALUES
      ('${C1}', 'Jane Doe', '5551112222', 'jane@x.com'),
      ('${C2}', 'John Roe', '5559998888', 'john@y.com'),
      ('${A}',  'Alice Prior',  '5553334444', 'alice@x.com'),
      ('${B}',  'Bob Current',  '5554445555', 'bob@x.com'),
      ('${S1}', 'Sam One', '5550000000', 's1@x.com'),
      ('${S2}', 'Sam Two', '5550000000', 's2@x.com'),
      ('${P1}', 'Placeholder Pat', '', 'no@no.com');
    INSERT INTO vehicles(id, year, make, model, vin, license_plate) VALUES
      ('${V1}', '2020', 'Honda', 'Civic', '1HGCV1F30LA123456', 'ABC1234'),
      ('${V3}', '2018', 'Ford', 'F150', NULL, NULL),
      ('${VX}', '2019', 'Toyota', 'Camry', '4T1B11HK5KU999999', NULL),
      ('${VQ}', '2021', 'Kia', 'Soul', NULL, NULL);
    -- C1 owns V1; B currently owns VX (A sold it to B); nobody owns V3 or VQ.
    INSERT INTO customer_vehicles(customer_id, vehicle_id) VALUES ('${C1}', '${V1}'), ('${B}', '${VX}');

    -- O1: C1 linked (vehicle NOT owned) → C1 own 'linked'
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id, status, services, customer_name, approved_price_cents, arrived_at)
      VALUES ('00000000-0000-0000-0000-0000000000a1','SO-1','${C1}','${V3}','ready','["Brakes"]','Jane Doe', 15000, now() - interval '1 day');
    -- O2: on C1's owned vehicle V1, NOT authorized by C1 (no id, no contact) → C1 VEHICLE history
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id, status, services, customer_name, approved_price_cents, arrived_at)
      VALUES ('00000000-0000-0000-0000-0000000000a2','SO-2',NULL,'${V1}','delivered','["Oil"]','Someone Else', 8800, now() - interval '2 day');
    -- O3: exact UNIQUE phone match → C1 own 'contact'
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id, status, customer_name, arrived_at)
      VALUES ('00000000-0000-0000-0000-0000000000a3','SO-3',NULL,'${V3}','arrived','Jane', now() - interval '3 day');
    INSERT INTO quick_entry_jobs(service_order_id, customer_phone) VALUES ('00000000-0000-0000-0000-0000000000a3','(555) 111-2222');
    -- O4: NAME ONLY → excluded everywhere
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id, status, customer_name, arrived_at)
      VALUES ('00000000-0000-0000-0000-0000000000a4','SO-4',NULL,'${V3}','arrived','Jane Doe', now() - interval '4 day');
    -- O5: another customer entirely → excluded from C1
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id, status, customer_name, arrived_at)
      VALUES ('00000000-0000-0000-0000-0000000000a5','SO-5','${C2}','${V3}','arrived','John Roe', now() - interval '5 day');
    INSERT INTO job_estimates(service_order_id, total_cents, qb_invoice_number, qb_status)
      VALUES ('00000000-0000-0000-0000-0000000000a1', 15000, '1042', 'sent');

    -- RO-A: Alice's repair on VX (she authorized + paid), BEFORE she sold VX to Bob.
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id, status, services, customer_name, approved_price_cents, arrived_at)
      VALUES ('00000000-0000-0000-0000-0000000000b1','RO-A','${A}','${VX}','delivered','["Transmission"]','Alice Prior', 99900, now() - interval '30 day');
    INSERT INTO job_estimates(service_order_id, total_cents, qb_invoice_number, qb_status)
      VALUES ('00000000-0000-0000-0000-0000000000b1', 99900, '2001', 'sent');

    -- O-S: order with a SHARED phone (S1 & S2 both have 5550000000); vehicle unowned.
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id, status, customer_name, arrived_at)
      VALUES ('00000000-0000-0000-0000-0000000000c1','O-S',NULL,'${VQ}','arrived','Sam', now() - interval '6 day');
    INSERT INTO quick_entry_jobs(service_order_id, customer_phone) VALUES ('00000000-0000-0000-0000-0000000000c1','555-000-0000');
    -- O-P: order with placeholder email no@no.com.
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id, status, customer_name, arrived_at)
      VALUES ('00000000-0000-0000-0000-0000000000c2','O-P',NULL,'${V3}','arrived','Pat', now() - interval '7 day');
    INSERT INTO quick_entry_jobs(service_order_id, customer_email) VALUES ('00000000-0000-0000-0000-0000000000c2','no@no.com');
  `)
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})

describe('getCustomerProfile', () => {
  it('returns contact + owned vehicles + open job count', async () => {
    const p = await getCustomerProfile(C1)
    expect(p).not.toBeNull()
    expect(p!.displayName).toBe('Jane Doe')
    expect(p!.vehicles.map((v) => v.id)).toEqual([V1])
    expect(p!.openJobCount).toBe(1) // SO-1 linked + 'ready' (non-terminal)
  })
})

describe('own transaction history — only what the customer authorized', () => {
  it('includes linked + unique-contact; excludes name-only, foreign, and vehicle-only', async () => {
    const page = await getCustomerHistory(C1, { limit: 50, offset: 0 })
    expect(page.items.map((i) => i.orderNumber).sort()).toEqual(['SO-1', 'SO-3'])
    expect(page.total).toBe(2)
    expect(page.items.every((i) => i.scope === 'own')).toBe(true)
  })
  it('NEVER matches by name alone (SO-4) and never exposes another customer (SO-5)', async () => {
    const page = await getCustomerHistory(C1, { limit: 50, offset: 0 })
    expect(page.items.find((i) => i.orderNumber === 'SO-4')).toBeUndefined()
    expect(page.items.find((i) => i.orderNumber === 'SO-5')).toBeUndefined()
  })
  it('labels linked vs contact and surfaces amount/invoice on own records', async () => {
    const page = await getCustomerHistory(C1, { limit: 50, offset: 0 })
    const o1 = page.items.find((i) => i.orderNumber === 'SO-1')!
    const o3 = page.items.find((i) => i.orderNumber === 'SO-3')!
    expect(o1.matchedBy).toBe('linked')
    expect(o3.matchedBy).toBe('contact')
    expect(o1.amountCents).toBe(15000)
    expect(o1.invoice).toEqual({ number: '1042', status: 'sent' })
  })
})

describe('vehicle service history — separated and financially redacted', () => {
  it('shows service on owned vehicles the customer did NOT authorize, without money/authorizer', async () => {
    const own = await getCustomerHistory(C1, { limit: 50, offset: 0 })
    expect(own.items.find((i) => i.orderNumber === 'SO-2')).toBeUndefined() // not in OWN

    const veh = await getVehicleServiceHistory(C1, { limit: 50, offset: 0 })
    const o2 = veh.items.find((i) => i.orderNumber === 'SO-2')!
    expect(o2).toBeDefined()
    expect(o2.scope).toBe('vehicle')
    expect(o2.amountCents).toBeNull()      // SO-2 had 8800 — hidden
    expect(o2.invoice).toBeNull()
    expect(o2.authorizedBy).toBeNull()      // "Someone Else" not revealed
    expect(o2.services).toContain('Oil')    // service detail is still useful
  })
})

describe('vehicle changes owners — prior owner financials never leak to the new owner', () => {
  it("Bob's OWN history excludes Alice's repair; it appears only as redacted vehicle service", async () => {
    const own = await getCustomerHistory(B, { limit: 50, offset: 0 })
    expect(own.items.find((i) => i.orderNumber === 'RO-A')).toBeUndefined()

    const veh = await getVehicleServiceHistory(B, { limit: 50, offset: 0 })
    const roA = veh.items.find((i) => i.orderNumber === 'RO-A')!
    expect(roA).toBeDefined()
    expect(roA.amountCents).toBeNull()     // Alice paid $999 — never shown on Bob's profile
    expect(roA.invoice).toBeNull()         // Alice's invoice #2001 — never shown
    expect(roA.authorizedBy).toBeNull()    // Alice's name — never shown
  })
  it("Alice keeps her own transaction (with financials) even though she no longer owns the car", async () => {
    const own = await getCustomerHistory(A, { limit: 50, offset: 0 })
    const roA = own.items.find((i) => i.orderNumber === 'RO-A')!
    expect(roA).toBeDefined()
    expect(roA.amountCents).toBe(99900)
    expect(roA.invoice).toEqual({ number: '2001', status: 'sent' })
    // Alice no longer owns VX, so she has no vehicle-service rows for it.
    const veh = await getVehicleServiceHistory(A, { limit: 50, offset: 0 })
    expect(veh.total).toBe(0)
  })
})

describe('shared / placeholder contacts are not used to attribute work', () => {
  it('a shared phone attributes the order to NEITHER customer', async () => {
    const s1 = await getCustomerHistory(S1, { limit: 50, offset: 0 })
    const s2 = await getCustomerHistory(S2, { limit: 50, offset: 0 })
    expect(s1.items.find((i) => i.orderNumber === 'O-S')).toBeUndefined()
    expect(s2.items.find((i) => i.orderNumber === 'O-S')).toBeUndefined()
  })
  it('a placeholder email (no@no.com) is never treated as identity', async () => {
    const p = await getCustomerHistory(P1, { limit: 50, offset: 0 })
    expect(p.items.find((i) => i.orderNumber === 'O-P')).toBeUndefined()
    expect(p.total).toBe(0)
  })
})

describe('pagination — never silently omits older records', () => {
  it('paginates own history with a correct total and hasMore', async () => {
    const p1 = await getCustomerHistory(C1, { limit: 1, offset: 0 })
    expect(p1.total).toBe(2)
    expect(p1.items).toHaveLength(1)
    expect(p1.hasMore).toBe(true)
    const p2 = await getCustomerHistory(C1, { limit: 1, offset: 1 })
    expect(p2.items).toHaveLength(1)
    expect(p2.hasMore).toBe(false)
    expect(new Set([...p1.items, ...p2.items].map((i) => i.orderNumber)).size).toBe(2)
  })
})

describe('searchCustomers — name, phone, AND owned-vehicle plate/VIN resolve to the customer', () => {
  it('finds a customer by name', async () => {
    const r = await searchCustomers('Jane')
    expect(r.find((x) => x.id === C1)).toBeTruthy()
  })
  it('finds a customer by phone digits', async () => {
    const r = await searchCustomers('555 111 2222')
    expect(r.find((x) => x.id === C1)).toBeTruthy()
  })
  it('finds the OWNING customer by license plate (formatting-insensitive)', async () => {
    const r = await searchCustomers('abc-1234')
    const hit = r.find((x) => x.id === C1)
    expect(hit).toBeTruthy()
    expect(hit!.matchedVia).toBe('vehicle')
  })
  it('finds the OWNING customer by full or partial VIN', async () => {
    expect((await searchCustomers('1HGCV1F30LA123456')).find((x) => x.id === C1)).toBeTruthy()
    expect((await searchCustomers('999999')).find((x) => x.id === B)).toBeTruthy() // VIN suffix → Bob (owns VX)
  })
  it('ignores queries under two characters', async () => {
    expect(await searchCustomers('a')).toEqual([])
  })
})

describe('redactHistoryForEmployee', () => {
  it('strips amounts and invoice links from own records', async () => {
    const page = await getCustomerHistory(C1, { limit: 50, offset: 0 })
    const redacted = redactHistoryForEmployee(page.items)
    expect(redacted.every((i) => i.amountCents === null)).toBe(true)
    expect(redacted.every((i) => i.invoice === null)).toBe(true)
  })
})
