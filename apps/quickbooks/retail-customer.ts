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

async function qbFindByEmail(email: string): Promise<string | null> {
  const res = await queryQBO<{ Customer?: Array<{ Id: string }> }>(`SELECT Id FROM Customer WHERE PrimaryEmailAddr = '${qboEscape(email)}'`)
  return res.Customer?.[0]?.Id ?? null
}
async function qbFindByName(displayName: string): Promise<string | null> {
  const res = await queryQBO<{ Customer?: Array<{ Id: string }> }>(`SELECT Id FROM Customer WHERE DisplayName = '${qboEscape(displayName)}'`)
  return res.Customer?.[0]?.Id ?? null
}
async function qbCreate(c: RetailContact): Promise<string> {
  const body: Record<string, unknown> = { DisplayName: c.name.trim() }
  if (c.email?.trim()) body.PrimaryEmailAddr = { Address: c.email.trim() }
  if (c.phone?.trim()) body.PrimaryPhone = { FreeFormNumber: c.phone.trim() }
  const res = await qbApiRequest<{ Customer: { Id: string } }>({ method: 'POST', path: '/customer', body })
  return res.Customer.Id
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

export async function resolveRetailCustomer(c: RetailContact): Promise<ResolvedCustomer> {
  const dir = await findDirectoryCustomer(c)
  if (dir?.quickbooksCustomerId) {
    return { qbCustomerId: dir.quickbooksCustomerId, created: false, matchedBy: 'directory-cache', directoryCustomerId: dir.id }
  }
  const email = normEmail(c.email)
  let qbId: string | null = null
  let matchedBy: ResolvedCustomer['matchedBy'] = 'created'
  if (email) { qbId = await qbFindByEmail(email); if (qbId) matchedBy = 'qb-email' }
  if (!qbId) { qbId = await qbFindByName(c.name.trim()); if (qbId) matchedBy = 'qb-name' }
  const created = !qbId
  if (!qbId) { qbId = await qbCreate(c); matchedBy = 'created' }
  const directoryCustomerId = await cacheToDirectory(dir, c, qbId).catch((e) => {
    logger.warn(APP, 'cache_failed', { error: String(e) }); return dir?.id ?? null
  })
  return { qbCustomerId: qbId, created, matchedBy, directoryCustomerId }
}
