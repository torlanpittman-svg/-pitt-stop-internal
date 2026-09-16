/**
 * Business Receipts / Expense Capture — shared vocabulary + PURE, client-safe helpers (no server deps,
 * so the capture UI, the review UI, the AI normalizer and the DB layer all import from one place).
 *
 * This module is the GENERAL business-wide expense-capture path (Pitt Stop Detail AND Auto Sales),
 * distinct from the per-vehicle Auto-Sales receipt capture (apps/auto-sales). A general shop expense
 * does NOT require a vehicle; an expense that belongs to an inventory vehicle MAY optionally reference
 * the canonical inventory record. Nothing here encodes accounting treatment — that stays 'unknown' and
 * is flagged for the accountant. No money movement; no QuickBooks policy.
 */

// ── Review lifecycle (a receipt's status). Transient states (uploaded/processing) exist for a future
// async pipeline; the current synchronous scan lands on needs_review or processing_failed. ──
export const RECEIPT_STATUSES = ['uploaded', 'processing', 'needs_review', 'approved', 'rejected', 'processing_failed'] as const
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]
export function isReceiptStatus(s: unknown): s is ReceiptStatus {
  return typeof s === 'string' && (RECEIPT_STATUSES as readonly string[]).includes(s)
}

// ── Business entity the expense belongs to. 'shared' = overhead split across both; 'unassigned' =
// not yet classified (a manager must set it before approval). No accounting policy is implied. ──
export const BUSINESS_ENTITIES = [
  { key: 'detail', label: 'Detail & Service' },
  { key: 'auto_sales', label: 'Auto Sales' },
  { key: 'shared', label: 'Shared / Overhead' },
  { key: 'unassigned', label: 'Unassigned' },
] as const
export type BusinessEntity = (typeof BUSINESS_ENTITIES)[number]['key']
export function isBusinessEntity(e: unknown): e is BusinessEntity {
  return typeof e === 'string' && BUSINESS_ENTITIES.some((b) => b.key === e)
}

// ── Operational expense categories (NOT a QuickBooks chart of accounts). Kept deliberately coarse and
// operational; the accountant maps these to real accounts later. 'uncategorized' stays flagged. ──
export const EXPENSE_CATEGORIES = [
  { key: 'parts', label: 'Parts & Supplies' },
  { key: 'shop_supplies', label: 'Shop Supplies / Chemicals' },
  { key: 'tools_equipment', label: 'Tools & Equipment' },
  { key: 'fuel', label: 'Fuel' },
  { key: 'vehicle_maintenance', label: 'Vehicle / Fleet Maintenance' },
  { key: 'subcontractor', label: 'Subcontractor / Outside Service' },
  { key: 'office', label: 'Office & Software' },
  { key: 'marketing', label: 'Marketing / Advertising' },
  { key: 'utilities', label: 'Utilities' },
  { key: 'rent', label: 'Rent / Facilities' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'fees', label: 'Bank / Merchant Fees' },
  { key: 'meals', label: 'Meals' },
  { key: 'other', label: 'Other' },
  { key: 'uncategorized', label: 'Uncategorized (needs review)' },
] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]['key']
export function isExpenseCategory(c: unknown): c is ExpenseCategory {
  return typeof c === 'string' && EXPENSE_CATEGORIES.some((e) => e.key === c)
}
/** Map a free-text AI category label onto our category keys; unknown → 'uncategorized' (flagged). */
export function categoryForLabel(label: string | null | undefined): ExpenseCategory {
  const l = (label ?? '').trim().toLowerCase()
  if (!l) return 'uncategorized'
  const exact = EXPENSE_CATEGORIES.find((c) => c.label.toLowerCase() === l || c.key === l)
  if (exact) return exact.key
  // loose keyword mapping — never invents a specific account, only routes to a coarse operational bucket
  if (/part|filter|belt|brake|fluid|oil/.test(l)) return 'parts'
  if (/soap|wax|chemical|detail|towel|supply|supplies/.test(l)) return 'shop_supplies'
  if (/tool|equipment|machine/.test(l)) return 'tools_equipment'
  if (/fuel|gas|diesel/.test(l)) return 'fuel'
  if (/tow|transport|sublet|subcontract/.test(l)) return 'subcontractor'
  if (/office|software|subscription|saas/.test(l)) return 'office'
  if (/market|advert|ad\b|sign/.test(l)) return 'marketing'
  if (/utility|electric|water|internet|phone/.test(l)) return 'utilities'
  if (/rent|lease|facilit/.test(l)) return 'rent'
  if (/insur/.test(l)) return 'insurance'
  if (/fee|charge|interest/.test(l)) return 'fees'
  if (/meal|food|lunch|restaurant/.test(l)) return 'meals'
  return 'other'
}

// ── Payment method (how it was paid). 'unknown' until confirmed; never guessed into a real account. ──
export const PAYMENT_METHODS = ['cash', 'card', 'check', 'ach', 'other', 'unknown'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export function isPaymentMethod(m: unknown): m is PaymentMethod {
  return typeof m === 'string' && (PAYMENT_METHODS as readonly string[]).includes(m)
}

// In-scope cash/card accounts (allowlist; extensible without schema change). Mirrors the Auto-Sales
// account allowlist so the accountant sees consistent references. Personal/holding excluded.
export const ACCOUNT_REFS = [
  { ref: 'unknown', label: 'Unknown / not yet known' },
  { ref: '*2649', label: 'American Momentum *2649 (operating)' },
  { ref: '*5600', label: 'Extraco *5600 (auto sales)' },
  { ref: 'amex', label: 'Pitt Stop business Amex' },
  { ref: 'cash', label: 'Cash drawer / petty cash' },
] as const

// ── AI extraction status (a PROPOSAL, never truth). ──
export type AiStatus = 'pending' | 'extracted' | 'failed' | 'skipped'

// ── QuickBooks sync status — FACTUAL. Never 'synced' unless a real QB object exists. No live mutation
// happens in this module; 'export_ready' means "an approved receipt is available for a future export". ──
export const QB_SYNC_STATUSES = ['none', 'export_ready', 'synced'] as const
export type QbSyncStatus = (typeof QB_SYNC_STATUSES)[number]

// ── Money: integer cents only. ──
/** Parse a dollars value (string/number) to a NON-NEGATIVE integer cents, or null when not parseable.
 *  Never coerces missing/blank to 0 (a missing amount must stay null, not silently become $0.00). */
export function parseCents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : NaN
  if (!Number.isFinite(n)) return null
  return Math.round(Math.abs(n) * 100)
}
export function centsToDollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  return (cents / 100).toFixed(2)
}
export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── Business-date helpers. Membership uses the plain 'YYYY-MM-DD' business date on the receipt, so
// there is NO UTC boundary drift (we never convert a timestamp to a calendar day). ──
export function isBusinessDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s)
}
export function isBusinessMonth(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
}
/** The 'YYYY-MM' business month of a business date, or null. */
export function businessMonthOf(date: string | null | undefined): string | null {
  return isBusinessDate(date) ? date.slice(0, 7) : null
}
/** Does a receipt's business date fall in the given 'YYYY-MM' month? (no timezone involved) */
export function inBusinessMonth(date: string | null | undefined, month: string): boolean {
  return businessMonthOf(date) === month
}

// ── Status machine (pure). Approval/rejection are manager acts; append-only history is kept separately
// (the row's status is the current state, audit_log is the trail). Approve is idempotent at the caller. ──
const TRANSITIONS: Record<ReceiptStatus, ReceiptStatus[]> = {
  uploaded: ['processing', 'needs_review', 'processing_failed'],
  processing: ['needs_review', 'processing_failed'],
  processing_failed: ['needs_review', 'rejected'],       // a successful retry, or reject an unreadable one
  needs_review: ['approved', 'rejected'],                // manager decision
  rejected: ['needs_review'],                            // manager can reopen (un-reject) — never silently deleted
  approved: ['needs_review'],                            // manager can reopen an approval to correct it (audited)
}
export function canTransition(from: ReceiptStatus, to: ReceiptStatus): boolean {
  if (from === to) return true // idempotent no-op
  return (TRANSITIONS[from] ?? []).includes(to)
}

// Approval decision (pure). Shared by the DB approve path + tests so the guard + idempotency semantics
// are verified deterministically: already-approved → no-op (idempotent); wrong status / unassigned entity
// / missing-or-zero total → blocked (never approve an unclassified or $0/unknown-total receipt).
export type ApproveDecision = { action: 'approve' } | { action: 'noop_already_approved' } | { action: 'blocked'; error: string }
export function decideApproval(status: ReceiptStatus, entity: string, totalCents: number | null | undefined): ApproveDecision {
  if (status === 'approved') return { action: 'noop_already_approved' }
  if (status !== 'needs_review') return { action: 'blocked', error: `Cannot approve from status "${status}".` }
  if (entity === 'unassigned') return { action: 'blocked', error: 'Assign a business (Detail / Auto Sales / Shared) before approving.' }
  if (totalCents === null || totalCents === undefined || totalCents <= 0) return { action: 'blocked', error: 'Enter the receipt total before approving.' }
  return { action: 'approve' }
}

// ── Append-only audit entry. Stored as a JSONB array on the row; NEVER rewritten, only appended. ──
export type AuditAction = 'uploaded' | 'extracted' | 'extraction_failed' | 'reviewed' | 'approved' | 'rejected' | 'reopened' | 'retried'
export interface AuditEntry {
  action: AuditAction
  actor: string | null
  at: string           // ISO timestamp
  changes?: Record<string, { from: unknown; to: unknown }>
  note?: string | null
}
export function auditEntry(action: AuditAction, actor: string | null, changes?: AuditEntry['changes'], note?: string | null): AuditEntry {
  const e: AuditEntry = { action, actor: actor ?? null, at: new Date().toISOString() }
  if (changes && Object.keys(changes).length) e.changes = changes
  if (note) e.note = note
  return e
}

/** Compute a field-level change map between the current stored fields and a manager's corrections
 *  (only fields that actually changed appear). Used for the audit trail — pure + deterministic. */
export function diffFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): AuditEntry['changes'] {
  const changes: NonNullable<AuditEntry['changes']> = {}
  for (const k of Object.keys(after)) {
    const b = (before as Record<string, unknown>)[k]
    const a = (after as Record<string, unknown>)[k]
    if (a !== undefined && a !== b) changes[k] = { from: b ?? null, to: a ?? null }
  }
  return Object.keys(changes).length ? changes : undefined
}
