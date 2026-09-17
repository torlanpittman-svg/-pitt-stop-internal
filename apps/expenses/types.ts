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
// async pipeline; the current synchronous scan lands on needs_review. ──
//   needs_review = the "Needs attention" queue (an exception a manager should look at, OR a capture the
//                  employee has not yet completed).
//   filed        = an employee (or a manager resolving an exception) completed the OPERATIONAL filing of a
//                  COMPLETE receipt. This is NOT accounting approval / QuickBooks posting — it just means
//                  "operationally captured, categorized, and ready for the accountant package".
//   approved     = LEGACY manager approval (preserved for historical attribution). No longer the routine
//                  path — kept so old records + their approvedBy attribution are never rewritten.
export const RECEIPT_STATUSES = ['uploaded', 'processing', 'needs_review', 'filed', 'approved', 'rejected', 'processing_failed'] as const
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]
export function isReceiptStatus(s: unknown): s is ReceiptStatus {
  return typeof s === 'string' && (RECEIPT_STATUSES as readonly string[]).includes(s)
}
/** The COMPLETE / operational set (employee-filed OR legacy manager-approved). Used by reporting. */
export function isCompleteStatus(s: string): boolean { return s === 'filed' || s === 'approved' }

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

// ── Payment method (how it was paid — the INSTRUMENT). 'unknown' until confirmed; never guessed into a
// real account. This is deliberately SEPARATE from `funding` below (who/whether it was paid): a business
// card and a personal card are both paymentMethod='card', but their funding differs. ──
export const PAYMENT_METHODS = ['cash', 'card', 'check', 'ach', 'other', 'unknown'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export function isPaymentMethod(m: unknown): m is PaymentMethod {
  return typeof m === 'string' && (PAYMENT_METHODS as readonly string[]).includes(m)
}

// ── Funding source (WHO paid / WHETHER paid — kept distinct from the payment instrument so reporting can
// honestly separate cash actually spent from a personal reimbursement owed and an unpaid purchase):
//   business = paid from a business account/drawer (card/cash/check) → real business cash outflow.
//   personal = an employee paid out of pocket → a reimbursement REVIEW is needed (we never create/promise
//              a reimbursement here); NOT business-account cash.
//   unpaid   = not paid yet (e.g. billed / on account) → NOT cash spent; a payment REVIEW is needed (we
//              never create a payable/payment here).
//   unknown  = legacy/incomplete — never inferred into a real account. ──
export const FUNDING_SOURCES = [
  { key: 'business', label: 'Business account' },
  { key: 'personal', label: 'Personal money (reimbursement)' },
  { key: 'unpaid',   label: 'Not paid yet' },
  { key: 'unknown',  label: 'Unknown' },
] as const
export type FundingSource = (typeof FUNDING_SOURCES)[number]['key']
export function isFundingSource(f: unknown): f is FundingSource {
  return typeof f === 'string' && FUNDING_SOURCES.some((s) => s.key === f)
}

// ── Why a receipt is in the "Needs attention" queue (an exception). An ordinary complete filing has NONE
// of these. Stored as an append-only-at-filing array on the row (attention_reasons) + surfaced to the
// manager so the queue explains itself. Never a substitute for the audit log. ──
export const ATTENTION_REASONS = [
  { key: 'missing_business',       label: 'Business not chosen' },
  { key: 'missing_info',           label: 'Missing vendor, date, or total' },
  { key: 'mixed_category',         label: 'More than one category — needs splitting' },
  { key: 'unclear_category',       label: 'Category unclear (“Other / Not sure”)' },
  { key: 'personal_reimbursement', label: 'Paid with personal money — reimbursement review' },
  { key: 'unpaid',                 label: 'Not paid yet — payment review' },
  { key: 'duplicate',              label: 'Possible duplicate' },
  { key: 'unreadable',             label: 'Photo could not be read automatically' },
] as const
export type AttentionReason = (typeof ATTENTION_REASONS)[number]['key']
export function attentionReasonLabel(k: string): string {
  return ATTENTION_REASONS.find((r) => r.key === k)?.label ?? k
}

// OUTSTANDING reasons are real-world items a manager CANNOT close by editing the receipt (the money is
// genuinely owed / unpaid / the purchase spans categories). A manager may ACKNOWLEDGE these — confirm the
// info is reviewed and correct — which moves the receipt out of the primary backlog into the "Outstanding"
// list WITHOUT falsifying funding or category. The rest are FIXABLE by supplying/correcting information, so
// they must be resolved (→ a clean filing), not merely acknowledged.
export const OUTSTANDING_REASONS: readonly AttentionReason[] = ['personal_reimbursement', 'unpaid', 'mixed_category']
export function isOutstandingReason(k: string): k is AttentionReason { return (OUTSTANDING_REASONS as readonly string[]).includes(k) }
/** A receipt can be ACKNOWLEDGED (reviewed-but-outstanding) only when every remaining reason is an
 *  outstanding real-world item — i.e. nothing is merely missing/unclear/duplicate that editing could fix. */
export function canAcknowledgeOutstanding(reasons: readonly string[]): boolean {
  return reasons.length > 0 && reasons.every(isOutstandingReason)
}
/** Short human label for the outstanding action still pending on a clarified receipt. */
export function outstandingKindLabel(reasons: readonly string[]): string {
  const parts: string[] = []
  if (reasons.includes('personal_reimbursement')) parts.push('reimbursement owed')
  if (reasons.includes('unpaid')) parts.push('awaiting payment')
  if (reasons.includes('mixed_category')) parts.push('needs allocation')
  return parts.join(' · ') || 'outstanding'
}

// ── The employee capture flow's Question 2 ("What did you buy?"). The common six are shown first; the
// rest of the operational categories live behind "More categories". Two special choices are NOT single
// categories: 'mixed' (more than one — save + flag, never dump the whole total into one guess) and
// 'unsure' ("Other / Not sure" — save with an optional note). Each concrete key REUSES an existing
// EXPENSE_CATEGORIES key (no parallel category system). ──
export const CAPTURE_PRIMARY_CATEGORIES = [
  { key: 'shop_supplies',   label: 'Detailing supplies' },   // → existing shop-supplies bucket
  { key: 'parts',           label: 'Parts' },
  { key: 'tools_equipment', label: 'Tools & equipment' },
  { key: 'fuel',            label: 'Fuel' },
  { key: 'subcontractor',   label: 'Outside labor' },
] as const
/** The remaining operational categories exposed under "More categories" (excludes the primary six,
 *  'other', and 'uncategorized' which are handled by the special "Other / Not sure" choice). */
export const CAPTURE_MORE_CATEGORIES = EXPENSE_CATEGORIES.filter(
  (c) => !CAPTURE_PRIMARY_CATEGORIES.some((p) => p.key === c.key) && c.key !== 'uncategorized' && c.key !== 'other',
)

/** How the employee answered Q2. 'single' carries a concrete EXPENSE_CATEGORIES key. */
export type CategoryChoice =
  | { kind: 'single'; key: ExpenseCategory }
  | { kind: 'mixed' }
  | { kind: 'unsure' }
export function categoryChoiceFrom(mode: string | null | undefined, key: string | null | undefined): CategoryChoice {
  if (mode === 'mixed') return { kind: 'mixed' }
  if (mode === 'unsure') return { kind: 'unsure' }
  return { kind: 'single', key: isExpenseCategory(key) ? key : 'uncategorized' }
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
  processing_failed: ['needs_review', 'filed', 'rejected'], // manual completion → filed, retry, or reject
  needs_review: ['filed', 'approved', 'rejected'],       // employee/manager files, legacy approve, or reject
  filed: ['needs_review'],                               // manager can reopen a filing to correct it (audited)
  rejected: ['needs_review'],                            // manager can reopen (un-reject) — never silently deleted
  approved: ['needs_review'],                            // manager can reopen a legacy approval to correct it (audited)
}
export function canTransition(from: ReceiptStatus, to: ReceiptStatus): boolean {
  if (from === to) return true // idempotent no-op
  return (TRANSITIONS[from] ?? []).includes(to)
}

// Approval decision (pure). Shared by the DB approve path + tests so the guard + idempotency semantics
// are verified deterministically: already-approved → no-op (idempotent); wrong status / unassigned entity
// / missing-or-zero total → blocked (never approve an unclassified or $0/unknown-total receipt).
export type ApproveDecision = { action: 'approve' } | { action: 'noop_already_approved' } | { action: 'blocked'; error: string }
export function decideApproval(status: ReceiptStatus, entity: string, totalCents: number | null | undefined, receiptDate: string | null | undefined): ApproveDecision {
  if (status === 'approved') return { action: 'noop_already_approved' }
  if (status !== 'needs_review') return { action: 'blocked', error: `Cannot approve from status "${status}".` }
  if (entity === 'unassigned') return { action: 'blocked', error: 'Assign a business (Detail / Auto Sales / Shared) before approving.' }
  if (totalCents === null || totalCents === undefined || totalCents <= 0) return { action: 'blocked', error: 'Enter the receipt total before approving.' }
  // A valid calendar receipt date is required so the approved receipt lands in a month (and is never
  // silently dropped from the accountant package). Missing/invalid → blocked, never coerced to today.
  if (!isBusinessDate(receiptDate)) return { action: 'blocked', error: 'Enter the receipt date before approving.' }
  return { action: 'approve' }
}

// ── Employee (or manager) OPERATIONAL FILING decision (pure). Given the answers to the three questions +
// the confirmed purchase facts, decide whether this is a CLEAN filing (→ 'filed') or an EXCEPTION that a
// manager should look at (→ 'needs_review' with concrete reasons). It NEVER traps the employee: an
// incomplete/mixed/personal/unpaid receipt is still SAVED — just flagged. Key guarantees the caller relies
// on: a mixed or unsure receipt is stored as 'uncategorized' (its whole total is NOT dumped into one guess);
// personal money and unpaid status are surfaced as their own review reasons (never booked as business cash).
export interface FilingAnswers {
  entity: string                         // detail|auto_sales|shared|unassigned
  category: CategoryChoice               // Q2 answer
  funding: FundingSource                 // Q3 answer (business|personal|unpaid|unknown)
  paymentMethod: PaymentMethod | null    // the instrument, when business-funded
  vendor: string | null | undefined
  receiptDate: string | null | undefined // YYYY-MM-DD
  totalCents: number | null | undefined
  duplicate?: boolean                    // an unresolved possible-duplicate flag
}
export interface FilingOutcome {
  status: Extract<ReceiptStatus, 'filed' | 'needs_review'>
  category: ExpenseCategory              // the concrete key to persist ('uncategorized' for mixed/unsure)
  reasons: AttentionReason[]             // empty ⇔ clean filing
  paymentMethod: PaymentMethod | null    // normalized (cleared unless business-funded)
}
export function decideFiling(a: FilingAnswers): FilingOutcome {
  const reasons = new Set<AttentionReason>()

  // Q2 → concrete category. Mixed/unsure never claim a single spending bucket.
  let category: ExpenseCategory = 'uncategorized'
  if (a.category.kind === 'single') category = a.category.key
  else if (a.category.kind === 'mixed') reasons.add('mixed_category')
  else reasons.add('unclear_category')
  if (a.category.kind === 'single' && (category === 'uncategorized' || category === 'other')) reasons.add('unclear_category')

  // Q1 → business must be chosen for a clean filing.
  if (!(a.entity === 'detail' || a.entity === 'auto_sales' || a.entity === 'shared')) reasons.add('missing_business')

  // Q3 → funding. Only business-funding carries a real payment instrument; personal/unpaid are flagged.
  let paymentMethod: PaymentMethod | null = null
  if (a.funding === 'business') {
    paymentMethod = a.paymentMethod && a.paymentMethod !== 'unknown' ? a.paymentMethod : null
    if (!paymentMethod) reasons.add('missing_info')
  } else if (a.funding === 'personal') {
    reasons.add('personal_reimbursement')
  } else if (a.funding === 'unpaid') {
    reasons.add('unpaid')
  } else {
    reasons.add('missing_info') // funding unknown/unanswered
  }

  // Confirmed purchase facts required for a clean filing (never coerce a blank into $0 / today).
  const vendorOk = typeof a.vendor === 'string' && a.vendor.trim().length > 0
  const dateOk = isBusinessDate(a.receiptDate)
  const totalOk = typeof a.totalCents === 'number' && a.totalCents > 0
  if (!vendorOk || !dateOk || !totalOk) reasons.add('missing_info')

  if (a.duplicate) reasons.add('duplicate')

  const list = ATTENTION_REASONS.map((r) => r.key).filter((k) => reasons.has(k)) // stable order
  return { status: list.length === 0 ? 'filed' : 'needs_review', category, reasons: list, paymentMethod }
}

// ── Append-only audit entry. Stored as a JSONB array on the row; NEVER rewritten, only appended. ──
export type AuditAction = 'uploaded' | 'extracted' | 'extraction_failed' | 'reviewed' | 'filed' | 'flagged' | 'clarified' | 'approved' | 'rejected' | 'reopened' | 'retried'
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
