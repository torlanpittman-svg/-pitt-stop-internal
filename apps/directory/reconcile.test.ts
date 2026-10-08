/**
 * Reconciliation engine coverage on a controlled DEV dataset (PGlite). Verifies the four report
 * buckets (linked / created / ambiguous / unresolved), contact-conflict flagging, potential-duplicate
 * flagging, vehicle preservation, and — critically — IDEMPOTENCY (apply twice makes no new rows and
 * no duplicate vehicle links).
 */
import { afterAll, beforeAll, beforeEach, expect, it, describe, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { planReconciliation, applyReconciliation, reconcileQuickEntryCustomers } from './reconcile'

const pg = new PGlite()
afterAll(() => pg.close())

// Existing directory customers
const EX_DANA = '11111111-1111-1111-1111-111111111111' // unique email + phone
const SH1 = '22222222-2222-2222-2222-222222222222'       // shares a phone with SH2 (ambiguous)
const SH2 = '33333333-3333-3333-3333-333333333333'
const EX_A = '44444444-4444-4444-4444-444444444444'      // owns email X
const EX_B = '55555555-5555-5555-5555-555555555555'      // owns phone Y (conflict case)
const EX_SAMENAME = '66666666-6666-6666-6666-666666666666' // display 'Dup Name', no contact
const EX_BIZ = '77777777-7777-7777-7777-777777777777'      // holds a shared business phone + its own email
const EX_BRYAN = '88888888-8888-8888-8888-888888888888'    // existing Bryan Brown (approved identity match)

// Vehicles for the candidate orders
const Vn = (n: number) => `aaaaaaaa-0000-0000-0000-00000000000${n}`
const VB1 = 'bbbbbbbb-0000-0000-0000-000000000001' // Bryan's BMW (approved link)
const VB2 = 'bbbbbbbb-0000-0000-0000-000000000002' // Martha's RAV4 (name-only create)
const VB3 = 'bbbbbbbb-0000-0000-0000-000000000003' // Caliber's Nissan (business account)

async function reseed() {
  await pg.exec(`
    DROP TABLE IF EXISTS customers, customer_vehicles, vehicles, service_orders, quick_entry_jobs CASCADE;
    CREATE TABLE customers(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name varchar(120), last_name varchar(120), display_name varchar(240), company varchar(240),
      phone varchar(40), normalized_phone varchar(20), email varchar(240), normalized_email varchar(240),
      customer_type varchar(20) NOT NULL DEFAULT 'retail', active boolean NOT NULL DEFAULT true,
      source varchar(20) NOT NULL DEFAULT 'autoleap', source_key varchar(240),
      autoleap_customer_id varchar(120), quickbooks_customer_id varchar(120), autoleap_vehicle_count integer,
      source_values jsonb NOT NULL DEFAULT '{}', created_by_import_batch_id uuid, first_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE customer_vehicles(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, vehicle_id uuid NOT NULL,
      relationship varchar(20) NOT NULL DEFAULT 'owner', source varchar(20) NOT NULL DEFAULT 'autoleap',
      created_by_import_batch_id uuid, first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id, vehicle_id));
    CREATE TABLE vehicles(id uuid PRIMARY KEY, year text, make text, model text, color text, vin text,
      license_plate text, created_at timestamptz DEFAULT now());
    CREATE TABLE service_orders(id uuid PRIMARY KEY, order_number text, source text, status text,
      customer_id uuid, vehicle_id uuid, customer_name text, created_at timestamptz DEFAULT now(),
      billing_customer_id uuid, invoice_recipient_email varchar(240), job_contact_name varchar(200));
    CREATE TABLE quick_entry_jobs(service_order_id uuid, customer_name text, customer_phone text, customer_email text);

    INSERT INTO customers(id, display_name, normalized_email, normalized_phone) VALUES
      ('${EX_DANA}', 'Dana Woody', 'dana@x.com', '9795550640'),
      ('${SH1}', 'Shared One', 's1@x.com', '5550000000'),
      ('${SH2}', 'Shared Two', 's2@x.com', '5550000000'),
      ('${EX_A}', 'Owner A', 'owner@x.com', NULL),
      ('${EX_B}', 'Owner B', NULL, '9995551111'),
      ('${EX_SAMENAME}', 'Dup Name', NULL, NULL),
      ('${EX_BIZ}', 'Tiffany At Biz', 'tiffany@biz.com', '9797751500'),
      ('${EX_BRYAN}', 'Bryan Brown', NULL, '9792193199');
    INSERT INTO vehicles(id) VALUES
      ('${Vn(1)}'),('${Vn(2)}'),('${Vn(3)}'),('${Vn(4)}'),('${Vn(5)}'),('${Vn(6)}'),('${Vn(7)}'),('${Vn(8)}'),('${Vn(9)}'),
      ('${VB1}'),('${VB2}'),('${VB3}');

    -- O1: unique email match → LINK to Dana
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a1','SO-1','quick_entry','ready',NULL,'${Vn(1)}','Dana W.', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000a1','Dana W.',NULL,'dana@x.com');
    -- O2: shared phone (SH1/SH2) → AMBIGUOUS
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a2','SO-2','quick_entry','ready',NULL,'${Vn(2)}','Sam', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000a2','Sam','555-000-0000',NULL);
    -- O3: email→A, phone→B (different) → AMBIGUOUS conflict
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a3','SO-3','quick_entry','ready',NULL,'${Vn(3)}','Clash', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000a3','Clash','999-555-1111','owner@x.com');
    -- O4: name only, no usable contact → UNRESOLVED
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a4','SO-4','quick_entry','ready',NULL,'${Vn(4)}','Nameless Nancy', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000a4','Nameless Nancy',NULL,NULL);
    -- O5 + O6: same NEW person (unique email), two orders/vehicles → CREATE ONE customer, link both vehicles
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a5','SO-5','quick_entry','ready',NULL,'${Vn(5)}','Nora New', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000a5','Nora New','512-555-2222','nora@x.com');
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a6','SO-6','quick_entry','ready',NULL,'${Vn(6)}','Nora New', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000a6','Nora New','512-555-2222','nora@x.com');
    -- O7: new person whose NAME collides with EX_SAMENAME but has a unique phone → CREATE + flag potential dup
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a7','SO-7','quick_entry','ready',NULL,'${Vn(7)}','Dup Name', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000a7','Dup Name','210-555-3333',NULL);
    -- O8: cancelled quick_entry → NOT a candidate
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a8','SO-8','quick_entry','cancelled',NULL,'${Vn(8)}','Gone', now());
    -- O9: shared business line — phone uniquely matches EX_BIZ, but order email differs from EX_BIZ's
    -- email (the Caliber Collision case) → HARD CONFLICT → AMBIGUOUS, never auto-linked.
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000a9','SO-9','quick_entry','ready',NULL,'${Vn(9)}','Biz Co', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000a9','Biz Co','979-775-1500','alicia@biz.com');

    -- APPROVED EXCEPTIONS (real prod order numbers; owner-resolved). These must bypass general rules.
    -- B1: Bryan Brown name-only order → owner-approved LINK to existing EX_BRYAN (phone 9792193199).
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000b1','SO-20260807-0002','quick_entry','ready',NULL,'${VB1}','Bryan Brown', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000b1','Bryan Brown',NULL,NULL);
    -- B2: Martha Cepeda name-only → owner-approved CREATE name-only customer.
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000b2','SO-20260828-0006','quick_entry','ready',NULL,'${VB2}','Martha  Cepeda', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000b2','Martha  Cepeda',NULL,NULL);
    -- B3: Caliber collision (advisor Alicia) → owner-approved BUSINESS account; advisor kept on order.
    INSERT INTO service_orders VALUES ('00000000-0000-0000-0000-0000000000b3','SO-20260806-0003','quick_entry','ready',NULL,'${VB3}','Caliber collision', now());
    INSERT INTO quick_entry_jobs VALUES ('00000000-0000-0000-0000-0000000000b3','Caliber collision','979-775-1500','alicia.balanga@calibercollision.com');
  `)
}

beforeAll(async () => {
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
  await reseed()
})
beforeEach(reseed)

const q = async <T,>(s: string): Promise<T[]> => (await pg.query<T>(s)).rows

describe('planReconciliation — read-only bucketing', () => {
  it('sorts candidates into link / create / ambiguous / unresolved and writes nothing', async () => {
    const before = (await q<{ n: number }>('SELECT count(*)::int n FROM customers'))[0].n
    const r = await planReconciliation()

    expect(r.mode).toBe('dry-run')
    expect(r.candidateOrders).toBe(11) // cancelled SO-8 excluded; 8 general + 3 approved exceptions

    // The 3 approved exceptions are handled in their OWN bucket (not via the general rules).
    expect(r.approved.map((a) => a.orderNumber).sort()).toEqual(['SO-20260806-0003', 'SO-20260807-0002', 'SO-20260828-0006'])

    expect(r.linked.map((l) => l.orderNumber)).toEqual(['SO-1'])
    expect(r.linked[0].customerId).toBe(EX_DANA)

    // SO-9 is a shared-business-line hard conflict → ambiguous (NOT linked to EX_BIZ/Tiffany).
    expect(r.ambiguous.map((a) => a.orderNumber).sort()).toEqual(['SO-2', 'SO-3', 'SO-9'])
    expect(r.ambiguous.find((a) => a.orderNumber === 'SO-9')!.candidateCustomerIds).toEqual([EX_BIZ])
    expect(r.unresolved.map((u) => u.orderNumber)).toEqual(['SO-4'])

    // SO-5 + SO-6 collapse into ONE new customer; SO-7 is a second new customer.
    expect(r.summary.distinctNewCustomers).toBe(2)
    const nora = r.created.find((c) => c.orderNumbers.includes('SO-5'))!
    expect(nora.orderNumbers.sort()).toEqual(['SO-5', 'SO-6'])
    const dup = r.created.find((c) => c.orderNumbers.includes('SO-7'))!
    expect(dup.potentialDuplicateCustomerIds).toContain(EX_SAMENAME)

    // Read-only: no customer rows added.
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM customers'))[0].n).toBe(before)
  })
})

describe('approved historical exceptions — narrow, auditable, no general-rule change', () => {
  it('Bryan Brown: links the BMW order to the EXISTING record (no duplicate, no contact overwrite)', async () => {
    const before = (await q<{ n: number }>('SELECT count(*)::int n FROM customers'))[0].n
    await reconcileQuickEntryCustomers({ apply: true })
    const so = (await q<{ customer_id: string }>(`SELECT customer_id FROM service_orders WHERE order_number='SO-20260807-0002'`))[0]
    expect(so.customer_id).toBe(EX_BRYAN)                           // reused existing record
    // No new Bryan row, and his phone is untouched.
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customers WHERE lower(display_name)='bryan brown'`))[0].n).toBe(1)
    expect((await q<{ normalized_phone: string }>(`SELECT normalized_phone FROM customers WHERE id='${EX_BRYAN}'`))[0].normalized_phone).toBe('9792193199')
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customer_vehicles WHERE customer_id='${EX_BRYAN}' AND vehicle_id='${VB1}'`))[0].n).toBe(1)
    void before
  })

  it('Martha Cepeda: creates a NAME-ONLY customer (phone/email NULL) and links her order + vehicle', async () => {
    await reconcileQuickEntryCustomers({ apply: true })
    const so = (await q<{ customer_id: string }>(`SELECT customer_id FROM service_orders WHERE order_number='SO-20260828-0006'`))[0]
    expect(so.customer_id).toBeTruthy()
    const c = (await q<{ display_name: string; phone: string | null; email: string | null }>(`SELECT display_name, phone, email FROM customers WHERE id='${so.customer_id}'`))[0]
    expect(c.display_name).toBe('Martha Cepeda')
    expect(c.phone).toBeNull()
    expect(c.email).toBeNull()                                      // no placeholder invented
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customer_vehicles WHERE customer_id='${so.customer_id}' AND vehicle_id='${VB2}'`))[0].n).toBe(1)
  })

  it('Caliber Collision: business account billed, advisor kept ON THE ORDER, company email not set to advisor', async () => {
    await reconcileQuickEntryCustomers({ apply: true })
    const so = (await q<{ customer_id: string; billing_customer_id: string; invoice_recipient_email: string; job_contact_name: string }>(
      `SELECT customer_id, billing_customer_id, invoice_recipient_email, job_contact_name FROM service_orders WHERE order_number='SO-20260806-0003'`))[0]
    const biz = (await q<{ display_name: string; customer_type: string; email: string | null }>(`SELECT display_name, customer_type, email FROM customers WHERE id='${so.customer_id}'`))[0]
    expect(biz.display_name).toBe('Caliber Collision')
    expect(biz.customer_type).toBe('business')
    expect(biz.email).toBeNull()                                   // advisor email NOT written onto the company
    expect(so.billing_customer_id).toBe(so.customer_id)            // bill the company
    expect(so.invoice_recipient_email).toBe('alicia.balanga@calibercollision.com') // advisor = recipient, this order only
    expect(so.job_contact_name).toBe('Alicia Balanga')
    // The pre-existing employee profile sharing the company phone is NOT merged/modified.
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customers WHERE id='${EX_BIZ}'`))[0].n).toBe(1)
    // No employee customer row was created for the advisor.
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customers WHERE lower(display_name) LIKE '%balanga%'`))[0].n).toBe(0)
  })

  it('approved exceptions are idempotent (second apply makes no new rows)', async () => {
    await reconcileQuickEntryCustomers({ apply: true })
    const n1 = (await q<{ n: number }>('SELECT count(*)::int n FROM customers'))[0].n
    const cv1 = (await q<{ n: number }>('SELECT count(*)::int n FROM customer_vehicles'))[0].n
    await reconcileQuickEntryCustomers({ apply: true })
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM customers'))[0].n).toBe(n1)
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM customer_vehicles'))[0].n).toBe(cv1)
  })
})

describe('applyReconciliation — safe writes + vehicle preservation', () => {
  it('links SO-1, creates 2 customers, preserves vehicles, never touches ambiguous/unresolved', async () => {
    const r = await reconcileQuickEntryCustomers({ apply: true })
    expect(r.mode).toBe('apply')

    // SO-1 linked to existing Dana + her vehicle connected
    const so1 = (await q<{ customer_id: string }>(`SELECT customer_id FROM service_orders WHERE order_number='SO-1'`))[0]
    expect(so1.customer_id).toBe(EX_DANA)
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customer_vehicles WHERE customer_id='${EX_DANA}' AND vehicle_id='${Vn(1)}'`))[0].n).toBe(1)

    // Nora: one new customer, BOTH her orders linked to it, BOTH vehicles connected
    const noraId = r.created.find((c) => c.orderNumbers.includes('SO-5'))!.customerId!
    expect(noraId).toBeTruthy()
    const noraOrders = await q<{ customer_id: string }>(`SELECT customer_id FROM service_orders WHERE order_number IN ('SO-5','SO-6')`)
    expect(noraOrders.every((o) => o.customer_id === noraId)).toBe(true)
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customer_vehicles WHERE customer_id='${noraId}'`))[0].n).toBe(2)

    // Ambiguous + unresolved orders remain UNLINKED
    const untouched = await q<{ order_number: string; customer_id: string | null }>(
      `SELECT order_number, customer_id FROM service_orders WHERE order_number IN ('SO-2','SO-3','SO-4')`)
    expect(untouched.every((o) => o.customer_id === null)).toBe(true)
  })

  it('is IDEMPOTENT — applying twice creates no new customers and no duplicate vehicle links', async () => {
    await reconcileQuickEntryCustomers({ apply: true })
    const afterFirst = (await q<{ n: number }>('SELECT count(*)::int n FROM customers'))[0].n
    const cvFirst = (await q<{ n: number }>('SELECT count(*)::int n FROM customer_vehicles'))[0].n

    const second = await reconcileQuickEntryCustomers({ apply: true })
    // The only remaining candidates are the un-actionable ambiguous (SO-2, SO-3, SO-9) + unresolved
    // (SO-4); they are correctly left alone, so the second pass links nothing and creates nothing.
    expect(second.candidateOrders).toBe(4)
    expect(second.summary.ordersLinkedToExisting).toBe(0)
    expect(second.summary.distinctNewCustomers).toBe(0)
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM customers'))[0].n).toBe(afterFirst)
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM customer_vehicles'))[0].n).toBe(cvFirst)
  })
})
