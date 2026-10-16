/**
 * QuickBooks PAYEE resolution for check-writing — fail-closed, so a check is never booked against the
 * wrong payee, a lookup failure is never mistaken for "no such payee", and a vendor is never created for
 * a name QuickBooks already holds.
 *
 * A QBO Purchase (PaymentType=Check) EntityRef may be a Vendor, an Employee, or a Customer (this company
 * already has checks paid to all three). QBO also enforces DisplayName uniqueness ACROSS those lists, so a
 * vendor-only search reports "no such payee" for an employee (e.g. payroll to an employee) and the
 * follow-up vendor create fails with 6240 "Duplicate Name Exists". We therefore search all three lists
 * and keep the exact entity id + type. (Only ACTIVE records are searched: QuickBooks renames a record it
 * makes inactive to "Name (deleted)", which frees the name — so an inactive record can neither match a
 * typed name exactly nor cause a 6240.)
 *
 * Resolution for a typed payee name (exact after trim/whitespace-collapse/case-fold — never fuzzy):
 *   1. exactly ONE active match (any type)      → use it
 *   2. more than one active match              → ambiguous → the manager picks; never pick the first
 *   3. only INACTIVE matches (defensive)       → blocked (reactivate in QuickBooks); never create
 *   4. no match at all                          → create a new Vendor ONLY on explicit confirmation
 *   any lookup failure                          → PayeeLookupError (never treated as "not found")
 *
 * If a confirmed create still hits 6240 (the name exists somewhere we could not see), we never retry
 * the create or alter the name: we re-query, and either hand the existing payee back for confirmation or
 * explain the conflict.
 */
import { queryQBO, qbApiRequest, qboEscape } from '@/apps/quickbooks/client'
import { logger } from '@/platform/logger'

const APP = 'checks:payee'

export const PAYEE_TYPES = ['Vendor', 'Employee', 'Customer'] as const
export type PayeeType = (typeof PAYEE_TYPES)[number]
export const isPayeeType = (t: unknown): t is PayeeType => PAYEE_TYPES.includes(t as PayeeType)

export interface QbPayee { id: string; type: PayeeType; displayName: string; active: boolean }

/** Plain-language names for the UI and error messages. */
export const payeeTypeLabel = (t: PayeeType) => ({ Vendor: 'vendor', Employee: 'employee', Customer: 'customer' })[t]

export const normalizePayeeName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

// ── Errors (each maps to one clear UI state) ──────────────────────────────────

export class PayeeLookupError extends Error {
  constructor(public cause: unknown) {
    super('Could not reach QuickBooks to look up this payee. Nothing was recorded — try again in a moment.')
    this.name = 'PayeeLookupError'
  }
}

export class AmbiguousPayeeError extends Error {
  constructor(public matches: QbPayee[]) {
    super(`This name matches ${matches.length} QuickBooks records. Pick the right one before writing the check.`)
    this.name = 'AmbiguousPayeeError'
  }
}

export class PayeeNotFoundError extends Error {
  constructor(name: string) { super(`“${name}” is not in QuickBooks yet. Confirm creating a new vendor to continue.`); this.name = 'PayeeNotFoundError' }
}

/** The name is taken in QuickBooks by something a check cannot be written to (as-is). */
export class PayeeBlockedError extends Error {
  constructor(message: string, public conflicts: QbPayee[]) { super(message); this.name = 'PayeeBlockedError' }
}

/** A confirmed vendor create found the payee already exists — re-confirm with the existing record. */
export class PayeeExistsError extends Error {
  constructor(public payee: QbPayee) {
    super(`“${payee.displayName}” already exists in QuickBooks as a ${payeeTypeLabel(payee.type)}. No new vendor was created — review and record the check to that existing ${payeeTypeLabel(payee.type)}.`)
    this.name = 'PayeeExistsError'
  }
}

// ── QuickBooks reads ──────────────────────────────────────────────────────────

type QbNameRow = { Id: string; DisplayName?: string; Active?: boolean }
const mapRow = (type: PayeeType) => (r: QbNameRow): QbPayee => ({ id: r.Id, type, displayName: r.DisplayName ?? '', active: r.Active !== false })

/**
 * Every active Vendor/Employee/Customer whose DisplayName starts with `name` (QuickBooks LIKE is
 * case-insensitive); decidePayee() then keeps only exact-after-normalization names. ANY failed list query
 * throws PayeeLookupError — a partial answer could otherwise look like "not found" and create a duplicate.
 */
export async function searchPayees(name: string): Promise<QbPayee[]> {
  const q = qboEscape(name.trim().replace(/\s+/g, ' '))
  try {
    const lists = await Promise.all(PAYEE_TYPES.map(async (type) => {
      const res = await queryQBO<Record<string, QbNameRow[] | undefined>>(
        `SELECT * FROM ${type} WHERE DisplayName LIKE '${q}%' MAXRESULTS 100`,
      )
      return (res[type] ?? []).map(mapRow(type))
    }))
    return lists.flat()
  } catch (e) {
    logger.error(APP, 'payee.lookup_failed', { error: String((e as Error)?.message ?? e) })
    throw new PayeeLookupError(e)
  }
}

/** One specific ACTIVE QuickBooks record by id + type (an explicit pick from the review screen). */
export async function getPayee(id: string, type: PayeeType): Promise<QbPayee | null> {
  try {
    const res = await queryQBO<Record<string, QbNameRow[] | undefined>>(
      `SELECT * FROM ${type} WHERE Id = '${qboEscape(id)}'`,
    )
    const row = res[type]?.[0]
    return row ? mapRow(type)(row) : null
  } catch (e) {
    throw new PayeeLookupError(e)
  }
}

/** The only QuickBooks mutation here; called solely after the manager confirms "create new vendor". */
export async function createVendor(name: string): Promise<QbPayee> {
  const res = await qbApiRequest<{ Vendor: QbNameRow }>({ method: 'POST', path: '/vendor', body: { DisplayName: name.trim().replace(/\s+/g, ' ') } })
  logger.info(APP, 'vendor.created', { id: res.Vendor.Id, name: res.Vendor.DisplayName })
  return mapRow('Vendor')(res.Vendor)
}

/** QBO error 6240 "Duplicate Name Exists". */
export const isDuplicateNameError = (e: unknown) => /\b6240\b|Duplicate Name Exists/i.test(String((e as Error)?.message ?? e))

// ── Pure decision core (unit-tested) ─────────────────────────────────────────

export type PayeeDecision =
  | { action: 'use'; payee: QbPayee }
  | { action: 'ambiguous'; matches: QbPayee[] }
  | { action: 'blocked'; reason: string; conflicts: QbPayee[] }
  | { action: 'create' }

const inactiveMessage = (p: QbPayee) =>
  `“${p.displayName}” is already in QuickBooks as an INACTIVE ${payeeTypeLabel(p.type)}, so a check can’t be written to it and a new vendor with the same name can’t be created. ` +
  `In QuickBooks, make that ${payeeTypeLabel(p.type)} active again, then come back and review this check.`

/** Deterministic: only exact-normalized names count; fuzzy/near names never select or block anything. */
export function decidePayee(name: string, found: QbPayee[]): PayeeDecision {
  const exact = found.filter((p) => normalizePayeeName(p.displayName) === normalizePayeeName(name))
  const active = exact.filter((p) => p.active)
  if (active.length === 1) return { action: 'use', payee: active[0] }
  if (active.length > 1) return { action: 'ambiguous', matches: active }
  if (exact.length > 0) return { action: 'blocked', reason: inactiveMessage(exact[0]), conflicts: exact }
  return { action: 'create' }
}

// ── Preview (read-only) + resolve ─────────────────────────────────────────────

export type PayeePreview =
  | { decision: 'use'; payee: QbPayee }
  | { decision: 'ambiguous'; matches: QbPayee[] }
  | { decision: 'blocked'; message: string; conflicts: QbPayee[] }
  | { decision: 'create' }

/** READ-ONLY: what WOULD happen for this payee, for the review card. Never mutates QuickBooks.
 *  Throws PayeeLookupError if QuickBooks could not be searched. */
export async function previewPayee(name: string): Promise<PayeePreview> {
  const d = decidePayee(name, await searchPayees(name))
  if (d.action === 'use') return { decision: 'use', payee: d.payee }
  if (d.action === 'ambiguous') return { decision: 'ambiguous', matches: d.matches }
  if (d.action === 'blocked') return { decision: 'blocked', message: d.reason, conflicts: d.conflicts }
  return { decision: 'create' }
}

export interface ResolvePayeeOptions {
  /** An explicit pick from the review screen (id + type) — verified, never trusted blindly. */
  payeeId?: string | null
  payeeType?: PayeeType | null
  /** Manager confirmed creating a NEW vendor (only honored when nothing exists under this name). */
  allowCreate?: boolean
}

/** Resolve the payee to a QuickBooks entity usable as a check's EntityRef, failing closed. */
export async function resolvePayee(name: string, opts: ResolvePayeeOptions = {}): Promise<QbPayee> {
  if (opts.payeeId) {
    const type = opts.payeeType ?? 'Vendor'
    const p = await getPayee(opts.payeeId, type)
    if (!p) throw new PayeeBlockedError(`The selected QuickBooks ${payeeTypeLabel(type)} is no longer active in QuickBooks. Go back and review the payee again.`, [])
    if (!p.active) throw new PayeeBlockedError(inactiveMessage(p), [p])
    return p
  }

  const d = decidePayee(name, await searchPayees(name))
  if (d.action === 'use') return d.payee
  if (d.action === 'ambiguous') throw new AmbiguousPayeeError(d.matches)
  if (d.action === 'blocked') throw new PayeeBlockedError(d.reason, d.conflicts)
  if (!opts.allowCreate) throw new PayeeNotFoundError(name.trim())

  try {
    return await createVendor(name)
  } catch (e) {
    if (!isDuplicateNameError(e)) throw e
    // 6240: QuickBooks holds this name somewhere. Never retry the create or alter the name — find who owns it.
    logger.warn(APP, 'vendor.create_duplicate_name', { name: name.trim() })
    const again = decidePayee(name, await searchPayees(name))
    if (again.action === 'use') throw new PayeeExistsError(again.payee)
    if (again.action === 'ambiguous') throw new AmbiguousPayeeError(again.matches)
    if (again.action === 'blocked') throw new PayeeBlockedError(again.reason, again.conflicts)
    throw new PayeeBlockedError(
      `QuickBooks says the name “${name.trim()}” is already in use, but it is not on the Vendors, Employees or Customers list the app can see ` +
      `(it may be on QuickBooks’ “Other names” list, or be a sub-customer or project). No vendor was created and nothing was recorded. ` +
      `Search for the name in QuickBooks and either rename that record or add this payee there as a vendor, then review this check again.`,
      [],
    )
  }
}
