/**
 * Manager "+ Add New Dealer" — adds a row to the EXISTING dealerships table (the same
 * one Dealer Check-In, dealer QB invoicing and the admin dealership page read). No
 * parallel dealer system and no QuickBooks writes: the dealer must already exist as a
 * QuickBooks customer, which is looked up live (read-only) and verified by Id — the
 * mapping is never typed in or guessed.
 *
 * Deps are injected so the rules are unit-testable without a DB or QuickBooks.
 */
import { findPrefixConflict, normalizeDealerPrefix, STANDARD_RATE } from '@/apps/dealer-checkin/rules'
import type { DealershipRow } from './db'

export interface AddDealershipInput {
  qbCustomerId?: string | null
  /** Optional dealer stock prefix. Blank = no prefix (manual pick only, e.g. BMW). */
  stockPrefix?:  string | null
  billingEmail?: string | null
}

export interface AddDealershipDeps {
  listDealerships: () => Promise<DealershipRow[]>
  getCustomerById: (id: string) => Promise<{ id: string; displayName: string; email: string | null; active: boolean } | null>
  createDealership: (row: {
    name: string; stockPrefix: string | null; qbCustomerId: string; qbCustomerName: string
    billingEmail: string | null; taxExempt: boolean; rateDefault: number
  }) => Promise<string>
}

export type AddDealershipResult =
  | { ok: true; created: boolean; dealership: { id: string; name: string; stockPrefix: string | null; qbCustomerId: string } }
  | { ok: false; status: 400 | 409 | 422; error: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function addDealership(input: AddDealershipInput, deps: AddDealershipDeps): Promise<AddDealershipResult> {
  const qbCustomerId = (input.qbCustomerId ?? '').trim()
  if (!/^\d+$/.test(qbCustomerId)) return { ok: false, status: 400, error: 'Choose the dealer\'s QuickBooks customer.' }

  const stockPrefix = normalizeDealerPrefix(input.stockPrefix)
  if (stockPrefix === undefined) return { ok: false, status: 400, error: 'Stock prefix must be 1–10 letters or numbers, or left blank.' }

  const email = (input.billingEmail ?? '').trim()
  if (email && !EMAIL_RE.test(email)) return { ok: false, status: 400, error: 'Billing email is not a valid email address.' }

  const customer = await deps.getCustomerById(qbCustomerId)
  if (!customer) return { ok: false, status: 422, error: 'That QuickBooks customer was not found. Create the dealer in QuickBooks first.' }
  if (!customer.active) return { ok: false, status: 422, error: `${customer.displayName} is inactive in QuickBooks.` }

  const existing = await deps.listDealerships()

  // Idempotent: a double tap / retry for the same customer + prefix returns the existing row.
  const same = existing.find((d) => d.qbCustomerId === customer.id && (d.stockPrefix ?? null) === stockPrefix)
  if (same) {
    return { ok: true, created: false, dealership: { id: same.id, name: same.name, stockPrefix: same.stockPrefix, qbCustomerId: customer.id } }
  }

  const conflict = findPrefixConflict(stockPrefix, { qbCustomerId: customer.id }, existing)
  if (conflict) {
    return { ok: false, status: 409, error: `Prefix ${stockPrefix} overlaps ${conflict.name}'s prefix ${conflict.stockPrefix} and would change how their stock numbers are matched.` }
  }

  const id = await deps.createDealership({
    name:           customer.displayName,
    stockPrefix,
    qbCustomerId:   customer.id,
    qbCustomerName: customer.displayName,
    billingEmail:   email || customer.email || null,
    taxExempt:      true,
    rateDefault:    STANDARD_RATE,
  })
  return { ok: true, created: true, dealership: { id, name: customer.displayName, stockPrefix, qbCustomerId: customer.id } }
}

/** Validate a prefix edit on an existing dealer row (admin page). */
export function checkPrefixEdit(
  id: string,
  raw: string | null,
  dealers: DealershipRow[],
): { ok: true; stockPrefix: string | null } | { ok: false; status: 400 | 404 | 409; error: string } {
  const stockPrefix = normalizeDealerPrefix(raw)
  if (stockPrefix === undefined) return { ok: false, status: 400, error: 'Stock prefix must be 1–10 letters or numbers, or left blank.' }
  const self = dealers.find((d) => d.id === id)
  if (!self) return { ok: false, status: 404, error: 'Dealership not found' }
  const conflict = findPrefixConflict(stockPrefix, { id, qbCustomerId: self.qbCustomerId ?? null }, dealers)
  if (conflict) return { ok: false, status: 409, error: `Prefix ${stockPrefix} overlaps ${conflict.name}'s prefix ${conflict.stockPrefix}.` }
  return { ok: true, stockPrefix }
}
