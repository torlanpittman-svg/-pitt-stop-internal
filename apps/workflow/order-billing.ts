/**
 * Read/write the occasional third-party billing fields on a work order (migration 0049). These
 * decide WHO the QB invoice is billed to and sent to — WITHOUT changing the vehicle owner or the
 * service customer's history (that stays on serviceOrders.customerId / customer_vehicles, which
 * this never touches). Ordinary jobs leave all three NULL. See apps/quickbooks/invoice-party.ts.
 */
import { getDb } from '@/platform/db'
import { eq } from 'drizzle-orm'
import { serviceOrders } from './schema'
import { customers } from '@/apps/directory/schema'

export interface OrderBilling {
  billingCustomerId: string | null
  billingCustomerName: string | null
  invoiceRecipientEmail: string | null
  jobContactName: string | null
}

const clean = (s?: string | null): string | null => {
  const t = (s ?? '').trim()
  return t === '' ? null : t
}

export async function getOrderBilling(orderId: string): Promise<OrderBilling | null> {
  const db = getDb()
  const [o] = await db.select({
    billingCustomerId: serviceOrders.billingCustomerId,
    invoiceRecipientEmail: serviceOrders.invoiceRecipientEmail,
    jobContactName: serviceOrders.jobContactName,
  }).from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  if (!o) return null
  let billingCustomerName: string | null = null
  if (o.billingCustomerId) {
    const [c] = await db.select({ name: customers.displayName }).from(customers).where(eq(customers.id, o.billingCustomerId)).limit(1)
    billingCustomerName = c?.name ?? null
  }
  return {
    billingCustomerId: o.billingCustomerId ?? null,
    billingCustomerName,
    invoiceRecipientEmail: o.invoiceRecipientEmail ?? null,
    jobContactName: o.jobContactName ?? null,
  }
}

/**
 * Set (or clear, with all-null input) the third-party billing fields. Fail-closed: a named billing
 * customer MUST exist in the directory, and a recipient email must be well-formed. NEVER writes
 * customer_id or customer_vehicles — vehicle ownership and service history are untouched.
 */
export async function setOrderBilling(
  orderId: string,
  input: { billingCustomerId?: string | null; invoiceRecipientEmail?: string | null; jobContactName?: string | null },
): Promise<{ ok: true; billing: OrderBilling } | { ok: false; error: string }> {
  const db = getDb()
  const billingCustomerId = clean(input.billingCustomerId)
  const invoiceRecipientEmail = clean(input.invoiceRecipientEmail)
  const jobContactName = clean(input.jobContactName)

  if (billingCustomerId) {
    const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, billingCustomerId)).limit(1)
    if (!c) return { ok: false, error: 'That billing customer was not found in the directory.' }
  }
  if (invoiceRecipientEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invoiceRecipientEmail)) {
    return { ok: false, error: 'Enter a valid invoice recipient email.' }
  }

  const [row] = await db.update(serviceOrders)
    .set({ billingCustomerId, invoiceRecipientEmail, jobContactName, updatedAt: new Date() })
    .where(eq(serviceOrders.id, orderId))
    .returning({ id: serviceOrders.id })
  if (!row) return { ok: false, error: 'Order not found.' }

  const billing = await getOrderBilling(orderId)
  return { ok: true, billing: billing! }
}
