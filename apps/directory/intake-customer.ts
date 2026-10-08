/**
 * Promote a Work Board / Quick Entry intake into the canonical customer directory.
 *
 * THE BUG THIS FIXES: Quick Entry used to store the customer only as denormalized text on the
 * service order (`service_orders.customer_name`) and on `quick_entry_jobs`, and left
 * `service_orders.customer_id` NULL. The Customers page (`searchCustomers`) reads ONLY the
 * `customers` table, so a Work Board customer was invisible unless a `customers` row happened to
 * exist for some OTHER reason (an AutoLeap/QB import, or a later QuickBooks invoice whose
 * `cacheToDirectory` inserts one as a side effect). That is why "some customers appear and others
 * don't". This find-or-creates the canonical row at intake and links the vehicle, so every Work
 * Board customer is searchable and their Job attaches to their profile/history going forward.
 *
 * NO DUPLICATES / NO WRONG MERGE: matching mirrors the QB resolver's rule (apps/quickbooks
 * `findDirectoryCustomer`) — a UNIQUE, non-placeholder normalized email, then phone. A value that is
 * a placeholder (no@no.com …) or shared by more than one customer is NOT identity, so we create a
 * fresh row rather than attach to the wrong person. We never match by name alone. Because the stored
 * normalized_email/normalized_phone and the match rule are value-identical to the QB path, a row
 * created here is later REUSED (not duplicated) when the Job is invoiced through QuickBooks.
 */
import { getDb } from '@/platform/db'
import { eq } from 'drizzle-orm'
import { customers, customerVehicles } from './schema'
import { normalizeEmail, normalizePhone, PLACEHOLDER_EMAILS } from './customer-profile'

export interface IntakeContact {
  name: string
  phone?: string | null
  email?: string | null
}

/** A real, non-placeholder email to use as identity, or null. */
export function usableEmail(email?: string | null): string | null {
  const e = normalizeEmail(email)
  if (!e || !e.includes('@')) return null
  if (PLACEHOLDER_EMAILS.has(e)) return null
  return (email ?? '').trim()
}
/** A real, non-placeholder phone to use as identity, or null (<10 digits / all-same-digit = junk). */
export function usablePhone(phone?: string | null): string | null {
  const p = normalizePhone(phone)
  if (p.length < 10) return null
  if (/^(\d)\1+$/.test(p)) return null
  return (phone ?? '').trim()
}

export interface IntakeCustomerLink {
  id: string
  created: boolean
}

/**
 * Find-or-create the canonical directory customer for an intake, and link the vehicle (idempotent).
 * Returns the customer id, or null when there is no usable name (never create a blank identity row).
 * Best-effort by contract: the caller MUST NOT let a directory failure fail Job creation.
 */
export async function findOrCreateIntakeCustomer(
  contact: IntakeContact,
  vehicleId: string,
  source = 'quick_entry',
): Promise<IntakeCustomerLink | null> {
  const name = (contact.name ?? '').trim()
  if (!name) return null

  const db = getDb()
  const email = usableEmail(contact.email)
  const phone = usablePhone(contact.phone)
  const nemail = email ? normalizeEmail(email) : ''
  const nphone = phone ? normalizePhone(phone) : ''

  // Match ONLY on unique, non-placeholder evidence (email → phone). >1 match ⇒ ambiguous ⇒ create new
  // (never silently attach one person's work to another). Never by name alone.
  const sel = () => db.select({ id: customers.id }).from(customers)
  const uniq = (rows: { id: string }[]) => (rows.length === 1 ? rows[0].id : null)
  let id: string | null = null
  if (nemail) id = uniq(await sel().where(eq(customers.normalizedEmail, nemail)).limit(2))
  if (!id && nphone) id = uniq(await sel().where(eq(customers.normalizedPhone, nphone)).limit(2))

  let created = false
  if (!id) {
    const [row] = await db
      .insert(customers)
      .values({
        displayName: name,
        email, normalizedEmail: nemail || null,
        phone, normalizedPhone: nphone || null,
        customerType: 'retail',
        source,
      })
      .returning({ id: customers.id })
    id = row.id
    created = true
  }

  // Link the vehicle (idempotent via customer_vehicles_uniq) so plate/VIN search resolves to the
  // customer and the profile lists this vehicle. A returning customer's re-check-in is a no-op.
  await db
    .insert(customerVehicles)
    .values({ customerId: id, vehicleId, source })
    .onConflictDoNothing({ target: [customerVehicles.customerId, customerVehicles.vehicleId] })

  return { id, created }
}
