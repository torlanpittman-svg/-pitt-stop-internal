/**
 * setOrderBilling: writes ONLY the third-party billing fields; validates the payer exists and the
 * recipient email is well-formed; and — the key invariant — never touches the vehicle owner or the
 * service customer's history (customer_id / customer_vehicles).
 */
import { afterAll, beforeAll, beforeEach, expect, it, describe, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { getOrderBilling, setOrderBilling } from './order-billing'

const pg = new PGlite()
afterAll(() => pg.close())

const RESIDENT = '11111111-1111-1111-1111-111111111111'
const PAYER = '22222222-2222-2222-2222-222222222222'
const ORDER = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const VEHICLE = 'bbbbbbbb-0000-0000-0000-0000000000b1'

async function reseed() {
  await pg.exec(`
    DROP TABLE IF EXISTS customers, customer_vehicles, service_orders CASCADE;
    CREATE TABLE customers(id uuid PRIMARY KEY, display_name varchar(240), phone varchar(40), email varchar(240),
      customer_type varchar(20) DEFAULT 'retail', active boolean DEFAULT true);
    CREATE TABLE customer_vehicles(customer_id uuid, vehicle_id uuid, UNIQUE(customer_id, vehicle_id));
    CREATE TABLE service_orders(id uuid PRIMARY KEY, order_number text, customer_id uuid, vehicle_id uuid,
      billing_customer_id uuid, invoice_recipient_email varchar(240), job_contact_name varchar(200),
      updated_at timestamptz DEFAULT now());
    INSERT INTO customers(id, display_name, email) VALUES
      ('${RESIDENT}', 'Jordan Resident', 'jordan@home.com'),
      ('${PAYER}', 'Acme Construction', 'ap@acme.com');
    INSERT INTO customer_vehicles(customer_id, vehicle_id) VALUES ('${RESIDENT}', '${VEHICLE}');
    INSERT INTO service_orders(id, order_number, customer_id, vehicle_id) VALUES
      ('${ORDER}', 'SO-X', '${RESIDENT}', '${VEHICLE}');
  `)
}

beforeAll(async () => { vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>); await reseed() })
beforeEach(reseed)
const q = async <T,>(s: string): Promise<T[]> => (await pg.query<T>(s)).rows

describe('setOrderBilling', () => {
  it('sets the payer + recipient WITHOUT changing vehicle owner or service history', async () => {
    const res = await setOrderBilling(ORDER, { billingCustomerId: PAYER, invoiceRecipientEmail: 'rep@acme.com', jobContactName: 'Pat Rep' })
    expect(res.ok).toBe(true)

    const o = (await q<{ customer_id: string; billing_customer_id: string; invoice_recipient_email: string; job_contact_name: string }>(
      `SELECT customer_id, billing_customer_id, invoice_recipient_email, job_contact_name FROM service_orders WHERE id='${ORDER}'`))[0]
    expect(o.billing_customer_id).toBe(PAYER)
    expect(o.invoice_recipient_email).toBe('rep@acme.com')
    expect(o.job_contact_name).toBe('Pat Rep')
    // INVARIANT: the resident still owns the vehicle + the history.
    expect(o.customer_id).toBe(RESIDENT)
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customer_vehicles WHERE customer_id='${RESIDENT}' AND vehicle_id='${VEHICLE}'`))[0].n).toBe(1)
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM customer_vehicles WHERE customer_id='${PAYER}'`))[0].n).toBe(0)
    // The payer's own email is NOT altered.
    expect((await q<{ email: string }>(`SELECT email FROM customers WHERE id='${PAYER}'`))[0].email).toBe('ap@acme.com')
  })

  it('refuses a billing customer that does not exist (fail closed)', async () => {
    const res = await setOrderBilling(ORDER, { billingCustomerId: '99999999-9999-9999-9999-999999999999' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not found/i)
  })

  it('refuses a malformed recipient email', async () => {
    const res = await setOrderBilling(ORDER, { billingCustomerId: PAYER, invoiceRecipientEmail: 'not-an-email' })
    expect(res.ok).toBe(false)
  })

  it('clears the override with all-null input (back to billing the service customer)', async () => {
    await setOrderBilling(ORDER, { billingCustomerId: PAYER, invoiceRecipientEmail: 'rep@acme.com' })
    const res = await setOrderBilling(ORDER, { billingCustomerId: null, invoiceRecipientEmail: null, jobContactName: null })
    expect(res.ok).toBe(true)
    const b = await getOrderBilling(ORDER)
    expect(b).toEqual({ billingCustomerId: null, billingCustomerName: null, invoiceRecipientEmail: null, jobContactName: null })
  })

  it('getOrderBilling resolves the payer display name', async () => {
    await setOrderBilling(ORDER, { billingCustomerId: PAYER })
    const b = await getOrderBilling(ORDER)
    expect(b?.billingCustomerName).toBe('Acme Construction')
  })
})
