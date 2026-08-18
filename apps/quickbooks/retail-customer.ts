/**
 * Retail QuickBooks customer resolution + caching (P-D3.1).
 *
 * Approved resolution order (avoids duplicate QB customers from formatting differences):
 *   1. cached directory customers.quickbooks_customer_id  (by normalized email → phone → name)
 *   2. QB exact normalized email
 *   3. QB exact DisplayName
 *   4. create QB customer only if no confident match
 * On match/create the QB CustomerRef id is cached back onto the Pitt Stop customer
 * directory (update the matched row, or insert a minimal retail row) so it's reused.
 *
 * (Local phone dedup is handled by the directory's normalized_phone lookup; QBO stores
 * phone as free-form text and is unreliable to query, so we don't phone-match in QB.)
 */
import { getDb } from '@/platform/db'
import { and, eq, sql } from 'drizzle-orm'
import { customers } from '@/apps/directory/schema'
import { queryQBO, qbApiRequest, qboEscape } from './client'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:retail-customer'

export const normEmail = (e?: string | null) => (e ?? '').trim().toLowerCase()
export const normPhone = (p?: string | null) => (p ?? '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
export const normName  = (n?: string | null) => (n ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export interface RetailContact { name: string; email?: string | null; phone?: string | null }
export interface ResolvedCustomer {
  qbCustomerId: string
  created: boolean
  matchedBy: 'directory-cache' | 'qb-email' | 'qb-name' | 'created'
  directoryCustomerId: string | null
  /** The email to put on the invoice BillEmail (null → none; future Send stays blocked). */
  billEmail: string | null
  /** Email reconciliation outcome per the approved policy. */
  emailStatus: 'match' | 'filled_qb_blank' | 'conflict' | 'used_qb' | 'none'
  emailConflict: boolean
}

interface DirRow { id: string; quickbooksCustomerId: string | null }

async function findDirectoryCustomer(c: RetailContact): Promise<DirRow | null> {
  const db = getDb()
  const email = normEmail(c.email), phone = normPhone(c.phone), name = normName(c.name)
  const pick = (rows: { id: string; quickbooksCustomerId: string | null }[]) => rows[0] ?? null
  if (email) { const r = await db.select({ id: customers.id, quickbooksCustomerId: customers.quickbooksCustomerId }).from(customers).where(eq(customers.normalizedEmail, email)).limit(1); if (r[0]) return pick(r) }
  if (phone) { const r = await db.select({ id: customers.id, quickbooksCustomerId: customers.quickbooksCustomerId }).from(customers).where(eq(customers.normalizedPhone, phone)).limit(1); if (r[0]) return pick(r) }
  if (name)  { const r = await db.select({ id: customers.id, quickbooksCustomerId: customers.quickbooksCustomerId }).from(customers).where(sql`lower(${customers.displayName}) = ${name}`).limit(1); if (r[0]) return pick(r) }
  return null
}

interface QbCust { id: string; email: string | null; syncToken: string }
const mapCust = (c: { Id: string; PrimaryEmailAddr?: { Address?: string }; SyncToken: string }): QbCust =>
  ({ id: c.Id, email: c.PrimaryEmailAddr?.Address ?? null, syncToken: c.SyncToken })

async function qbFindByEmail(email: string): Promise<QbCust | null> {
  const res = await queryQBO<{ Customer?: Array<Parameters<typeof mapCust>[0]> }>(`SELECT * FROM Customer WHERE PrimaryEmailAddr = '${qboEscape(email)}'`)
  return res.Customer?.[0] ? mapCust(res.Customer[0]) : null
}
async function qbFindByName(displayName: string): Promise<QbCust | null> {
  const res = await queryQBO<{ Customer?: Array<Parameters<typeof mapCust>[0]> }>(`SELECT * FROM Customer WHERE DisplayName = '${qboEscape(displayName)}'`)
  return res.Customer?.[0] ? mapCust(res.Customer[0]) : null
}
async function qbCreate(c: RetailContact): Promise<QbCust> {
  const body: Record<string, unknown> = { DisplayName: c.name.trim() }
  if (c.email?.trim()) body.PrimaryEmailAddr = { Address: c.email.trim() }
  if (c.phone?.trim()) body.PrimaryPhone = { FreeFormNumber: c.phone.trim() }
  const res = await qbApiRequest<{ Customer: Parameters<typeof mapCust>[0] }>({ method: 'POST', path: '/customer', body })
  return mapCust(res.Customer)
}
/** Sparse-update ONLY the email on an existing QB customer (used to fill a blank). */
async function qbFillEmail(cust: QbCust, email: string): Promise<void> {
  await qbApiRequest({ method: 'POST', path: '/customer', body: { Id: cust.id, SyncToken: cust.syncToken, sparse: true, PrimaryEmailAddr: { Address: email } } })
}

/**
 * Email policy (approved): QB blank + PS email → fill QB; equal → reuse; differ → flag for
 * review (never silently overwrite); PS blank + QB has → use QB; neither → none.
 * Returns the BillEmail to use + the outcome. Only mutates QB in the blank-fill case.
 */
async function reconcileEmail(cust: QbCust, psEmail: string | null): Promise<{ billEmail: string | null; emailStatus: ResolvedCustomer['emailStatus']; emailConflict: boolean }> {
  const ps = normEmail(psEmail), qb = normEmail(cust.email)
  if (ps && !qb) { await qbFillEmail(cust, psEmail!.trim()).catch((e) => logger.warn(APP, 'email_fill_failed', { error: String(e) })); return { billEmail: psEmail!.trim(), emailStatus: 'filled_qb_blank', emailConflict: false } }
  if (ps && qb && ps === qb) return { billEmail: cust.email, emailStatus: 'match', emailConflict: false }
  if (ps && qb && ps !== qb) return { billEmail: psEmail!.trim(), emailStatus: 'conflict', emailConflict: true }
  if (!ps && qb) return { billEmail: cust.email, emailStatus: 'used_qb', emailConflict: false }
  return { billEmail: null, emailStatus: 'none', emailConflict: false }
}

/** Cache the resolved QB id onto the directory (update the matched row, or insert one). */
async function cacheToDirectory(dir: DirRow | null, c: RetailContact, qbId: string): Promise<string> {
  const db = getDb()
  if (dir) {
    await db.update(customers).set({ quickbooksCustomerId: qbId, updatedAt: new Date() }).where(eq(customers.id, dir.id))
    return dir.id
  }
  const [row] = await db.insert(customers).values({
    displayName: c.name.trim(), email: c.email?.trim() || null, normalizedEmail: normEmail(c.email) || null,
    phone: c.phone?.trim() || null, normalizedPhone: normPhone(c.phone) || null,
    customerType: 'retail', source: 'quick_entry', quickbooksCustomerId: qbId,
  }).returning({ id: customers.id })
  return row.id
}

async function qbGetCustomer(id: string): Promise<QbCust | null> {
  const res = await queryQBO<{ Customer?: Array<Parameters<typeof mapCust>[0]> }>(`SELECT * FROM Customer WHERE Id = '${qboEscape(id)}'`)
  return res.Customer?.[0] ? mapCust(res.Customer[0]) : null
}

/**
 * READ-ONLY customer identity resolution for Sync (Phase C). Resolves which EXISTING QB
 * customer the current contact maps to — directory-cache → QB email → QB name — but NEVER
 * creates, renames, merges, or caches. Returns null when no confident match exists (which
 * Sync treats as an identity change → needs_review, never an auto-create). Used to guarantee
 * a Pitt Stop edit can't silently move an existing invoice onto a different QB customer.
 */
export async function resolveRetailCustomerIdentity(c: RetailContact): Promise<{ qbCustomerId: string | null; matchedBy: ResolvedCustomer['matchedBy'] | 'none' }> {
  const dir = await findDirectoryCustomer(c)
  if (dir?.quickbooksCustomerId) return { qbCustomerId: dir.quickbooksCustomerId, matchedBy: 'directory-cache' }
  const psEmail = c.email?.trim() || null
  if (normEmail(psEmail)) { const cust = await qbFindByEmail(normEmail(psEmail)); if (cust) return { qbCustomerId: cust.id, matchedBy: 'qb-email' } }
  const byName = await qbFindByName(c.name.trim())
  if (byName) return { qbCustomerId: byName.id, matchedBy: 'qb-name' }
  return { qbCustomerId: null, matchedBy: 'none' }
}

export async function resolveRetailCustomer(c: RetailContact): Promise<ResolvedCustomer> {
  const psEmail = c.email?.trim() || null
  const dir = await findDirectoryCustomer(c)

  // 1. Directory cache hit → reconcile email against the cached QB customer.
  if (dir?.quickbooksCustomerId) {
    const cust = await qbGetCustomer(dir.quickbooksCustomerId)
    const rec = cust ? await reconcileEmail(cust, psEmail) : { billEmail: psEmail, emailStatus: 'none' as const, emailConflict: false }
    return { qbCustomerId: dir.quickbooksCustomerId, created: false, matchedBy: 'directory-cache', directoryCustomerId: dir.id, ...rec }
  }

  // 2–4. QB email → QB name → create.
  let cust: QbCust | null = null
  let matchedBy: ResolvedCustomer['matchedBy'] = 'created'
  if (normEmail(psEmail)) { cust = await qbFindByEmail(normEmail(psEmail)); if (cust) matchedBy = 'qb-email' }
  if (!cust) { cust = await qbFindByName(c.name.trim()); if (cust) matchedBy = 'qb-name' }
  const created = !cust
  if (!cust) { cust = await qbCreate(c); matchedBy = 'created' }

  const rec = created
    ? { billEmail: psEmail, emailStatus: (psEmail ? 'match' : 'none') as ResolvedCustomer['emailStatus'], emailConflict: false }
    : await reconcileEmail(cust, psEmail)

  const directoryCustomerId = await cacheToDirectory(dir, c, cust.id).catch((e) => {
    logger.warn(APP, 'cache_failed', { error: String(e) }); return dir?.id ?? null
  })
  return { qbCustomerId: cust.id, created, matchedBy, directoryCustomerId, ...rec }
}
