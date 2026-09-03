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
 * DATA-INTEGRITY GUARANTEE (2026-09 fix): an invoice must NEVER silently attach one customer's
 * work to another. So identity evidence is used ONLY when it is confident:
 *   - PLACEHOLDER contact values (e.g. "no@no.com", 0000000000) are NOT identity — they are treated
 *     as absent. (This was the Michael-Feldman→Angela-Brown bug: dozens of customers share the junk
 *     email "no@no.com", so an email match resolved to whoever held it in QB.)
 *   - An evidence value that matches MORE THAN ONE customer is ambiguous → it is not used; the exact
 *     lookups fail CLOSED (throw) rather than pick the first result.
 * decideCustomer() below is pure and unit-tested; resolveRetailCustomer wires it to QB/DB (or to
 * injected deps in tests). There is no module-level mutable state, so no request can inherit another
 * request's CustomerRef.
 */
import { getDb } from '@/platform/db'
import { eq, sql } from 'drizzle-orm'
import { customers } from '@/apps/directory/schema'
import { queryQBO, qbApiRequest, qboEscape } from './client'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:retail-customer'

export const normEmail = (e?: string | null) => (e ?? '').trim().toLowerCase()
export const normPhone = (p?: string | null) => (p ?? '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
export const normName  = (n?: string | null) => (n ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

// ── Placeholder detection — junk contact values that must NEVER be used as identity ──
const PLACEHOLDER_EMAILS = new Set([
  'no@no.com', 'none@none.com', 'na@na.com', 'no@email.com', 'noemail@noemail.com',
  'test@test.com', 'example@example.com', 'n/a', 'none', 'na', 'no',
])
const JUNK_LOCAL = new Set(['no', 'none', 'na', 'nan', 'test', 'example', 'noreply', 'nomail', 'noemail', 'unknown'])
const JUNK_DOMAINS = new Set(['no.com', 'none.com', 'na.com', 'test.com', 'example.com', 'email.com', 'noemail.com', 'unknown.com'])

/** True when an email is missing or a non-identifying placeholder → must be treated as "no email". */
export function isPlaceholderEmail(email?: string | null): boolean {
  const e = normEmail(email)
  if (!e || !e.includes('@')) return true
  if (PLACEHOLDER_EMAILS.has(e)) return true
  const [local, domain] = e.split('@')
  if (JUNK_DOMAINS.has(domain)) return true
  if (JUNK_LOCAL.has(local) && JUNK_LOCAL.has((domain ?? '').split('.')[0])) return true // no@no.*, test@test.* …
  return false
}
/** True when a phone is missing or a non-identifying placeholder (too short / repeated digits). */
export function isPlaceholderPhone(phone?: string | null): boolean {
  const p = normPhone(phone)
  if (p.length < 10) return true
  if (/^(\d)\1+$/.test(p)) return true               // 0000000000, 1111111111 …
  if (p === '1234567890') return true
  return false
}
/** The email to use as identity/BillEmail, or null if it is a placeholder. */
export function usableEmail(email?: string | null): string | null { return isPlaceholderEmail(email) ? null : (email ?? '').trim() }
/** The phone to use as identity, or null if it is a placeholder. */
export function usablePhone(phone?: string | null): string | null { return isPlaceholderPhone(phone) ? null : (phone ?? '').trim() }

export interface RetailContact { name: string; email?: string | null; phone?: string | null }
/** Strip placeholder email/phone so downstream matching/creation never treats junk as identity. */
export function sanitizeContact(c: RetailContact): RetailContact {
  return { name: c.name, email: usableEmail(c.email), phone: usablePhone(c.phone) }
}

export class AmbiguousCustomerError extends Error {
  constructor(message: string) { super(message); this.name = 'AmbiguousCustomerError' }
}

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

/**
 * Directory match by SANITIZED, UNIQUE evidence only. Placeholder email/phone are skipped; any
 * evidence that matches more than one directory row is ambiguous and skipped (never pick the first).
 */
async function findDirectoryCustomer(c: RetailContact): Promise<DirRow | null> {
  const db = getDb()
  const email = usableEmail(c.email) ? normEmail(c.email) : ''
  const phone = usablePhone(c.phone) ? normPhone(c.phone) : ''
  const name = normName(c.name)
  const sel = () => db.select({ id: customers.id, quickbooksCustomerId: customers.quickbooksCustomerId }).from(customers)
  const uniq = (rows: DirRow[]) => (rows.length === 1 ? rows[0] : null)   // >1 ⇒ ambiguous ⇒ not evidence
  if (email) { const u = uniq(await sel().where(eq(customers.normalizedEmail, email)).limit(2)); if (u) return u }
  if (phone) { const u = uniq(await sel().where(eq(customers.normalizedPhone, phone)).limit(2)); if (u) return u }
  if (name)  { const u = uniq(await sel().where(sql`lower(${customers.displayName}) = ${name}`).limit(2)); if (u) return u }
  return null
}

interface QbCust { id: string; email: string | null; syncToken: string }
const mapCust = (c: { Id: string; PrimaryEmailAddr?: { Address?: string }; SyncToken: string }): QbCust =>
  ({ id: c.Id, email: c.PrimaryEmailAddr?.Address ?? null, syncToken: c.SyncToken })

/** ALL QB customers with this exact PrimaryEmailAddr (caller detects ambiguity; never blindly [0]). */
async function qbFindByEmail(email: string): Promise<QbCust[]> {
  const res = await queryQBO<{ Customer?: Array<Parameters<typeof mapCust>[0]> }>(`SELECT * FROM Customer WHERE PrimaryEmailAddr = '${qboEscape(email)}'`)
  return (res.Customer ?? []).map(mapCust)
}
/** ALL QB customers with this exact DisplayName (caller detects ambiguity; never blindly [0]). */
async function qbFindByName(displayName: string): Promise<QbCust[]> {
  const res = await queryQBO<{ Customer?: Array<Parameters<typeof mapCust>[0]> }>(`SELECT * FROM Customer WHERE DisplayName = '${qboEscape(displayName)}'`)
  return (res.Customer ?? []).map(mapCust)
}
async function qbCreate(c: RetailContact): Promise<QbCust> {
  const body: Record<string, unknown> = { DisplayName: c.name.trim() }
  const email = usableEmail(c.email)                     // never persist a placeholder onto a QB customer
  if (email) body.PrimaryEmailAddr = { Address: email }
  if (usablePhone(c.phone)) body.PrimaryPhone = { FreeFormNumber: c.phone!.trim() }
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
  const email = usableEmail(c.email)                     // never store a placeholder as if it were identity
  const [row] = await db.insert(customers).values({
    displayName: c.name.trim(), email, normalizedEmail: normEmail(email) || null,
    phone: usablePhone(c.phone), normalizedPhone: normPhone(usablePhone(c.phone)) || null,
    customerType: 'retail', source: 'quick_entry', quickbooksCustomerId: qbId,
  }).returning({ id: customers.id })
  return row.id
}

async function qbGetCustomer(id: string): Promise<QbCust | null> {
  const res = await queryQBO<{ Customer?: Array<Parameters<typeof mapCust>[0]> }>(`SELECT * FROM Customer WHERE Id = '${qboEscape(id)}'`)
  return res.Customer?.[0] ? mapCust(res.Customer[0]) : null
}

// ── Pure decision core (unit-tested) ─────────────────────────────────────────
export interface CustomerEvidence {
  dirCacheId: string | null      // directory row's cached QB id (confident, unique match only)
  emailUsable: boolean           // a real (non-placeholder) email was supplied
  emailMatchIds: string[]        // QB customer ids with that exact email
  nameMatchIds: string[]         // QB customer ids with that exact DisplayName
}
export type CustomerDecision =
  | { action: 'use'; qbCustomerId: string; matchedBy: 'directory-cache' | 'qb-email' | 'qb-name' }
  | { action: 'create' }
  | { action: 'ambiguous'; reason: string }

/**
 * Deterministic, local, side-effect-free selection. Fails CLOSED on ambiguity; only a UNIQUE match is
 * used; a placeholder email is never evidence (emailUsable=false). Never returns a first-of-many or a
 * fallback customer.
 */
export function decideCustomer(ev: CustomerEvidence): CustomerDecision {
  if (ev.dirCacheId) return { action: 'use', qbCustomerId: ev.dirCacheId, matchedBy: 'directory-cache' }
  if (ev.emailUsable && ev.emailMatchIds.length === 1) return { action: 'use', qbCustomerId: ev.emailMatchIds[0], matchedBy: 'qb-email' }
  if (ev.emailUsable && ev.emailMatchIds.length > 1) return { action: 'ambiguous', reason: `email matches ${ev.emailMatchIds.length} QuickBooks customers` }
  if (ev.nameMatchIds.length === 1) return { action: 'use', qbCustomerId: ev.nameMatchIds[0], matchedBy: 'qb-name' }
  if (ev.nameMatchIds.length > 1) return { action: 'ambiguous', reason: `name matches ${ev.nameMatchIds.length} QuickBooks customers` }
  return { action: 'create' }
}

// Injectable dependencies so the resolver is deterministically unit-testable without QB/DB.
export interface ResolveDeps {
  findDirectory: (c: RetailContact) => Promise<DirRow | null>
  qbFindByEmail: (email: string) => Promise<QbCust[]>
  qbFindByName: (name: string) => Promise<QbCust[]>
  qbCreate: (c: RetailContact) => Promise<QbCust>
  qbGetCustomer: (id: string) => Promise<QbCust | null>
  reconcileEmail: (cust: QbCust, ps: string | null) => Promise<{ billEmail: string | null; emailStatus: ResolvedCustomer['emailStatus']; emailConflict: boolean }>
  cacheToDirectory: (dir: DirRow | null, c: RetailContact, qbId: string) => Promise<string>
}
const defaultDeps: ResolveDeps = { findDirectory: findDirectoryCustomer, qbFindByEmail, qbFindByName, qbCreate, qbGetCustomer, reconcileEmail, cacheToDirectory }

/**
 * READ-ONLY customer identity resolution for Sync (Phase C). Resolves which EXISTING QB customer the
 * current contact maps to — directory-cache → QB email → QB name — but NEVER creates, renames, merges,
 * or caches. Returns null when no CONFIDENT unique match exists (Sync treats null as an identity change
 * → needs_review). Placeholder email is ignored; an ambiguous (>1) match returns null (not confident).
 */
export async function resolveRetailCustomerIdentity(c0: RetailContact, deps: ResolveDeps = defaultDeps): Promise<{ qbCustomerId: string | null; matchedBy: ResolvedCustomer['matchedBy'] | 'none' }> {
  const c = sanitizeContact(c0)
  const dir = await deps.findDirectory(c)
  if (dir?.quickbooksCustomerId) return { qbCustomerId: dir.quickbooksCustomerId, matchedBy: 'directory-cache' }
  const email = normEmail(c.email)
  if (email) {
    const m = await deps.qbFindByEmail(email)
    if (m.length === 1) return { qbCustomerId: m[0].id, matchedBy: 'qb-email' }
    if (m.length > 1) return { qbCustomerId: null, matchedBy: 'none' } // ambiguous → not confident
  }
  const byName = await deps.qbFindByName(c.name.trim())
  if (byName.length === 1) return { qbCustomerId: byName[0].id, matchedBy: 'qb-name' }
  return { qbCustomerId: null, matchedBy: 'none' } // 0 or ambiguous
}

export async function resolveRetailCustomer(c0: RetailContact, deps: ResolveDeps = defaultDeps): Promise<ResolvedCustomer> {
  const c = sanitizeContact(c0)
  const psEmail: string | null = c.email ?? null   // already null if it was a placeholder
  const dir = await deps.findDirectory(c)

  // CASE 1 — directory cache hit → reconcile email against the cached QB customer.
  if (dir?.quickbooksCustomerId) {
    const cust = await deps.qbGetCustomer(dir.quickbooksCustomerId)
    const rec = cust ? await deps.reconcileEmail(cust, psEmail) : { billEmail: psEmail, emailStatus: 'none' as const, emailConflict: false }
    return { qbCustomerId: dir.quickbooksCustomerId, created: false, matchedBy: 'directory-cache', directoryCustomerId: dir.id, ...rec }
  }

  // CASE 2–6 — gather evidence, then decide (fail closed on ambiguity; never pick first-of-many).
  const emailUsable = !!normEmail(psEmail)
  const emailMatches = emailUsable ? await deps.qbFindByEmail(normEmail(psEmail)) : []
  const byId = new Map<string, QbCust>(emailMatches.map((m) => [m.id, m]))
  let nameMatches: QbCust[] = []
  if (!(emailUsable && emailMatches.length >= 1)) {
    nameMatches = await deps.qbFindByName(c.name.trim())
    for (const m of nameMatches) byId.set(m.id, m)
  }
  const decision = decideCustomer({
    dirCacheId: null, emailUsable, emailMatchIds: emailMatches.map((m) => m.id), nameMatchIds: nameMatches.map((m) => m.id),
  })
  if (decision.action === 'ambiguous') {
    throw new AmbiguousCustomerError(`Cannot safely resolve the QuickBooks customer for "${c.name}" (${decision.reason}). Resolve the customer in QuickBooks before invoicing.`)
  }

  let cust: QbCust
  let matchedBy: ResolvedCustomer['matchedBy']
  let created = false
  if (decision.action === 'use') { cust = byId.get(decision.qbCustomerId)!; matchedBy = decision.matchedBy }
  else { cust = await deps.qbCreate(c); matchedBy = 'created'; created = true }   // CASE 3 — create; failure throws (fail closed)

  const rec = created
    ? { billEmail: psEmail, emailStatus: (psEmail ? 'match' : 'none') as ResolvedCustomer['emailStatus'], emailConflict: false }
    : await deps.reconcileEmail(cust, psEmail)

  const directoryCustomerId = await deps.cacheToDirectory(dir, c, cust.id).catch((e) => {
    logger.warn(APP, 'cache_failed', { error: String(e) }); return dir?.id ?? null
  })
  return { qbCustomerId: cust.id, created, matchedBy, directoryCustomerId, ...rec }
}
