/**
 * Pure decision logic for attaching / recovering a QuickBooks dealer invoice on
 * an EXISTING Work Board job (no I/O — trivially unit-testable, same spirit as
 * rules.ts). The orchestration in attach-invoice.ts composes these.
 */
import type { QBEnvironment } from '@/apps/quickbooks/config'
import { matchDealershipByStock, normalizeStock } from './rules'

/**
 * Environment guard. A production Work Board job must only ever be linked to a
 * PRODUCTION QuickBooks invoice — never a sandbox one. Our jobs live in the
 * production database, so linking anything written against sandbox QB would
 * attach a fake invoice number to a real job. Refuse unless the active QB
 * environment is production (the test-only override exists so the sandbox
 * behaviour itself can be exercised in unit tests).
 */
export function canLinkInvoice(
  env: QBEnvironment,
  allowNonProduction = false,
): { ok: boolean; reason?: string } {
  if (env === 'production') return { ok: true }
  if (allowNonProduction) return { ok: true }
  return {
    ok: false,
    reason: `Refusing to link a ${env} QuickBooks invoice to a production job. Set QUICKBOOKS_ENVIRONMENT=production to invoice real jobs.`,
  }
}

/**
 * Pull the stock number out of a dealer Job's notes, which the check-in / board
 * flows write as "Stock: <X> | ...". Returns null when absent.
 */
export function parseStockFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null
  const m = notes.match(/Stock:\s*([A-Za-z0-9][A-Za-z0-9-]*)/i)
  const v = m?.[1]?.trim()
  return v && v.toLowerCase() !== 'n' && v.toLowerCase() !== 'na' ? v : null
}

/**
 * Resolve the dealership for a Job: prefer the stock-prefix match (identical to
 * normal intake), fall back to an exact customer-name match (the Work Board card
 * title is the dealer name). Returns null when neither resolves.
 */
export function resolveDealerForOrder<T extends { stockPrefix: string; name: string }>(
  opts: { stock: string | null | undefined; customerName: string | null | undefined },
  dealers: T[],
): T | null {
  const byStock = matchDealershipByStock(opts.stock, dealers)
  if (byStock) return byStock
  const name = (opts.customerName ?? '').trim().toLowerCase()
  if (!name) return null
  return dealers.find((d) => d.name.trim().toLowerCase() === name) ?? null
}

export interface InvoiceLineView {
  id: string
  docNumber: string | null
  descriptions: string[]
}

/**
 * Find an invoice that already carries this stock number on a line — the single
 * idempotency key shared by duplicate-detection AND partial-failure recovery. If
 * a prior attempt wrote the QB line but failed to persist the DB link, a retry
 * finds it here and links to it instead of charging the dealer twice.
 */
export function findStockLineInvoice(
  stock: string | null | undefined,
  invoices: InvoiceLineView[],
): InvoiceLineView | null {
  const norm = normalizeStock(stock)
  if (!norm) return null
  const token = `#${norm}`
  for (const inv of invoices) {
    if (inv.descriptions.some((d) => d.toUpperCase().includes(token))) return inv
  }
  return null
}

export type InvoiceLinkStatus = 'none' | 'pending' | 'queued' | 'linked' | 'failed'

/**
 * Display status for a Job's dealer invoice, derived from its scan row.
 * - no scan            → 'none'    (never attempted; e.g. a board-only entry)
 * - synced + number    → 'linked'
 * - queued             → 'queued'  (QB was unavailable; safe to retry)
 * - error              → 'failed'  (safe to retry)
 * - anything else      → 'pending'
 */
export function mapInvoiceStatus(
  scan: { qbInvoiceNumber: string | null; qbSyncStatus: string | null } | null | undefined,
): InvoiceLinkStatus {
  if (!scan) return 'none'
  if (scan.qbSyncStatus === 'synced' && scan.qbInvoiceNumber) return 'linked'
  if (scan.qbSyncStatus === 'queued') return 'queued'
  if (scan.qbSyncStatus === 'error') return 'failed'
  return 'pending'
}

/** Which write a resolved target implies. */
export function decideAttachAction(hasAppendable: boolean): 'appended' | 'created' {
  return hasAppendable ? 'appended' : 'created'
}
