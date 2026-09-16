/**
 * Business Receipts — read models + writes. Facts only; no accounting policy, no money movement, no
 * QuickBooks mutation. The pure decision logic (status machine, field diff, audit entries, month
 * membership, cents parsing) lives in ./types; this layer only orchestrates it over the database.
 *
 * Append-only audit: audit_log is concatenated with `|| ...::jsonb` so a new entry is appended
 * atomically and existing entries are never rewritten. Approval is idempotent (a conditional update
 * that only fires when the row is not already approved).
 */
import { and, desc, eq, ne, sql, inArray } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { businessReceipts } from './schema'
import {
  auditEntry, decideApproval, diffFields, inBusinessMonth, isBusinessEntity, isExpenseCategory, isPaymentMethod,
  type AuditEntry, type BusinessEntity, type ExpenseCategory, type PaymentMethod, type ReceiptStatus,
} from './types'

export type ReceiptRow = typeof businessReceipts.$inferSelect

/** SQL fragment that appends one audit entry to the append-only JSONB array (never rewrites history). */
function appendAudit(entry: AuditEntry) {
  return sql`${businessReceipts.auditLog} || ${JSON.stringify([entry])}::jsonb`
}

// ── Create (on upload) ────────────────────────────────────────────────────────
export interface CreateReceiptInput {
  storage: 'blob_public' | 'blob_private' | 'none'; storageRef: string | null
  filename?: string | null; contentType?: string | null; imageHash: string; byteSize?: number | null
  aiStatus: 'extracted' | 'failed'; aiModel: string | null; aiRaw: unknown; aiExtracted: unknown; confidence: unknown
  uploadedBy: string | null
  // seed proposal fields (from the AI extraction) so the review screen is pre-filled — all overridable
  vendor?: string | null; receiptDate?: string | null; subtotalCents?: number | null; taxCents?: number | null
  totalCents?: number | null; category?: ExpenseCategory; paymentMethod?: string | null; paymentLast4?: string | null
  inventoryVehicleId?: string | null
}
/** A prior, non-rejected receipt with the same content hash (Blob reuse + duplicate warning). */
export async function findReceiptByHash(hash: string): Promise<ReceiptRow | null> {
  const [d] = await getDb().select().from(businessReceipts).where(eq(businessReceipts.imageHash, hash)).orderBy(desc(businessReceipts.createdAt)).limit(1)
  return d ?? null
}
/** Create the receipt row on upload. Status lands on needs_review (extracted or failed → manager reviews).
 *  The image is preserved even when AI fails, so a receipt is never stranded. */
export async function createReceipt(input: CreateReceiptInput): Promise<string> {
  const status: ReceiptStatus = 'needs_review'
  const category: ExpenseCategory = input.category && isExpenseCategory(input.category) ? input.category : 'uncategorized'
  const audit = [
    auditEntry('uploaded', input.uploadedBy),
    input.aiStatus === 'extracted' ? auditEntry('extracted', 'system', undefined, input.aiModel ?? undefined) : auditEntry('extraction_failed', 'system'),
  ]
  const [row] = await getDb().insert(businessReceipts).values({
    status, entity: 'unassigned', category,
    vendor: input.vendor ?? null, receiptDate: input.receiptDate ?? null,
    subtotalCents: input.subtotalCents ?? null, taxCents: input.taxCents ?? null, totalCents: input.totalCents ?? null,
    paymentMethod: input.paymentMethod && isPaymentMethod(input.paymentMethod) ? input.paymentMethod : null,
    paymentLast4: input.paymentLast4 ?? null,
    inventoryVehicleId: input.inventoryVehicleId ?? null,
    storage: input.storage, storageRef: input.storageRef, filename: input.filename ?? null, contentType: input.contentType ?? null,
    imageHash: input.imageHash, byteSize: input.byteSize ?? null,
    aiStatus: input.aiStatus, aiModel: input.aiModel, aiRaw: input.aiRaw as object, aiExtracted: input.aiExtracted as object, confidence: input.confidence as object,
    uploadedBy: input.uploadedBy, auditLog: audit as unknown as object,
  }).returning({ id: businessReceipts.id })
  return row.id
}

// ── Read models ────────────────────────────────────────────────────────────────
export async function getReceipt(id: string): Promise<ReceiptRow | null> {
  const [r] = await getDb().select().from(businessReceipts).where(eq(businessReceipts.id, id)).limit(1)
  return r ?? null
}
/** The review queue — receipts in the given statuses (default: everything needing attention), newest first. */
export async function listReceipts(statuses: ReceiptStatus[] = ['needs_review', 'processing_failed']): Promise<ReceiptRow[]> {
  if (statuses.length === 0) return []
  return getDb().select().from(businessReceipts).where(inArray(businessReceipts.status, statuses)).orderBy(desc(businessReceipts.createdAt))
}
export interface QueueCounts { needs_review: number; approved: number; rejected: number; processing_failed: number }
/** Counts by status for the queue header (surfaces incomplete/failed/unreviewed separately). */
export async function queueCounts(): Promise<QueueCounts> {
  const rows = await getDb().select({ status: businessReceipts.status, n: sql<number>`count(*)::int` }).from(businessReceipts).groupBy(businessReceipts.status)
  const c: QueueCounts = { needs_review: 0, approved: 0, rejected: 0, processing_failed: 0 }
  for (const r of rows) if (r.status in c) (c as unknown as Record<string, number>)[r.status] = Number(r.n)
  return c
}

// ── Manager review + corrections ────────────────────────────────────────────────
export interface ReviewFields {
  entity?: BusinessEntity; category?: ExpenseCategory; vendor?: string | null; receiptDate?: string | null
  subtotalCents?: number | null; taxCents?: number | null; totalCents?: number | null
  paymentMethod?: PaymentMethod | null; accountRef?: string | null; paymentLast4?: string | null
  memo?: string | null; inventoryVehicleId?: string | null
}
/** Only keep the review fields that are set + valid — never silently coerces (undefined = "unchanged"). */
function sanitizeReview(f: ReviewFields): Record<string, unknown> {
  const set: Record<string, unknown> = {}
  if (f.entity !== undefined && isBusinessEntity(f.entity)) set.entity = f.entity
  if (f.category !== undefined && isExpenseCategory(f.category)) set.category = f.category
  if (f.vendor !== undefined) set.vendor = f.vendor || null
  if (f.receiptDate !== undefined) set.receiptDate = f.receiptDate || null
  if (f.subtotalCents !== undefined) set.subtotalCents = f.subtotalCents
  if (f.taxCents !== undefined) set.taxCents = f.taxCents
  if (f.totalCents !== undefined) set.totalCents = f.totalCents
  if (f.paymentMethod !== undefined) set.paymentMethod = f.paymentMethod && isPaymentMethod(f.paymentMethod) ? f.paymentMethod : null
  if (f.accountRef !== undefined) set.accountRef = f.accountRef || null
  if (f.paymentLast4 !== undefined) set.paymentLast4 = f.paymentLast4 || null
  if (f.memo !== undefined) set.memo = f.memo || null
  if (f.inventoryVehicleId !== undefined) set.inventoryVehicleId = f.inventoryVehicleId || null
  return set
}

/** Save manager corrections WITHOUT approving (stays needs_review). Appends an audited field diff. */
export async function saveReview(id: string, fields: ReviewFields, actor: string | null): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  const set = sanitizeReview(fields)
  const changes = diffFields(before as Record<string, unknown>, set)
  await db.update(businessReceipts).set({
    ...set, reviewedBy: actor, reviewedAt: new Date(), updatedAt: new Date(),
    auditLog: appendAudit(auditEntry('reviewed', actor, changes)),
  }).where(eq(businessReceipts.id, id))
  return { ok: true }
}

/**
 * Approve a receipt — IDEMPOTENT. Applies any final corrections, then atomically transitions the row to
 * 'approved' ONLY when it is not already approved (a double-click / retry cannot approve twice or append a
 * duplicate approval). Guards: an entity must be assigned and a total must be present (never approve an
 * unclassified or $0/unknown-total receipt). Sets qb_sync_status='export_ready' (NOT 'synced' — no live QB
 * write happens here). Category may remain 'uncategorized' (stays flagged for the accountant).
 */
export async function approveReceipt(id: string, fields: ReviewFields, actor: string | null): Promise<{ ok: boolean; error?: string; alreadyApproved?: boolean }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  const set = sanitizeReview(fields)
  const entity = (set.entity ?? before.entity) as string
  const total = (set.totalCents !== undefined ? set.totalCents : before.totalCents) as number | null
  const decision = decideApproval(before.status as ReceiptStatus, entity, total)
  if (decision.action === 'noop_already_approved') return { ok: true, alreadyApproved: true }
  if (decision.action === 'blocked') return { ok: false, error: decision.error }
  const changes = diffFields(before as Record<string, unknown>, set)
  const claimed = await db.update(businessReceipts).set({
    ...set, status: 'approved', approvedBy: actor, approvedAt: new Date(),
    reviewedBy: before.reviewedBy ?? actor, reviewedAt: before.reviewedAt ?? new Date(),
    qbSyncStatus: 'export_ready', updatedAt: new Date(),
    auditLog: appendAudit(auditEntry('approved', actor, changes)),
  }).where(and(eq(businessReceipts.id, id), ne(businessReceipts.status, 'approved'))).returning({ id: businessReceipts.id })
  if (claimed.length === 0) return { ok: true, alreadyApproved: true } // lost the race → already approved
  return { ok: true }
}

/** Reject a receipt (unreadable / not a business expense / duplicate). Never deletes the row or image. */
export async function rejectReceipt(id: string, reason: string | null, actor: string | null): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  if (before.status === 'rejected') return { ok: true }
  if (!['needs_review', 'processing_failed'].includes(before.status)) return { ok: false, error: `Cannot reject from status "${before.status}".` }
  await db.update(businessReceipts).set({
    status: 'rejected', rejectedReason: reason || null, reviewedBy: actor, reviewedAt: new Date(),
    qbSyncStatus: 'none', updatedAt: new Date(), auditLog: appendAudit(auditEntry('rejected', actor, undefined, reason)),
  }).where(eq(businessReceipts.id, id))
  return { ok: true }
}

/** Reopen an approved/rejected receipt back to needs_review (audited). Clears the approval + export flag. */
export async function reopenReceipt(id: string, actor: string | null): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  if (before.status === 'needs_review') return { ok: true }
  if (!['approved', 'rejected'].includes(before.status)) return { ok: false, error: `Cannot reopen from status "${before.status}".` }
  await db.update(businessReceipts).set({
    status: 'needs_review', approvedBy: null, approvedAt: null, rejectedReason: null,
    qbSyncStatus: 'none', updatedAt: new Date(), auditLog: appendAudit(auditEntry('reopened', actor)),
  }).where(eq(businessReceipts.id, id))
  return { ok: true }
}

// ── Retry extraction (re-run AI on the already-stored image; NEVER creates a duplicate receipt) ──────
export interface RetryExtractionUpdate {
  aiStatus: 'extracted' | 'failed'; aiModel: string | null; aiRaw: unknown; aiExtracted: unknown; confidence: unknown
  vendor?: string | null; receiptDate?: string | null; subtotalCents?: number | null; taxCents?: number | null
  totalCents?: number | null; category?: ExpenseCategory; paymentMethod?: string | null; paymentLast4?: string | null
}
/** Apply a re-extraction to an EXISTING receipt (retry). Only pre-fills a proposal field when the manager
 *  has not already set a value (never clobbers a correction). Status stays needs_review; no new row. */
export async function applyRetryExtraction(id: string, u: RetryExtractionUpdate, actor: string | null): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  const set: Record<string, unknown> = {
    aiStatus: u.aiStatus, aiModel: u.aiModel, aiRaw: u.aiRaw as object, aiExtracted: u.aiExtracted as object, confidence: u.confidence as object,
    status: 'needs_review', updatedAt: new Date(),
  }
  // Fill empty proposal fields only (respect prior manager edits + reviewed state).
  if (!before.vendor && u.vendor) set.vendor = u.vendor
  if (!before.receiptDate && u.receiptDate) set.receiptDate = u.receiptDate
  if (before.subtotalCents == null && u.subtotalCents != null) set.subtotalCents = u.subtotalCents
  if (before.taxCents == null && u.taxCents != null) set.taxCents = u.taxCents
  if (before.totalCents == null && u.totalCents != null) set.totalCents = u.totalCents
  if (before.category === 'uncategorized' && u.category && u.category !== 'uncategorized') set.category = u.category
  if (!before.paymentMethod && u.paymentMethod && isPaymentMethod(u.paymentMethod)) set.paymentMethod = u.paymentMethod
  if (!before.paymentLast4 && u.paymentLast4) set.paymentLast4 = u.paymentLast4
  await db.update(businessReceipts).set({ ...set, auditLog: appendAudit(auditEntry('retried', actor, undefined, u.aiStatus)) }).where(eq(businessReceipts.id, id))
  return { ok: true }
}

// ── Reporting / accountant-package readiness (internal; nothing is "booked" or "synced") ──────────────
export interface MonthlyExpenseReport {
  month: string
  approvedCount: number
  approvedTotalCents: number
  byEntity: Record<string, { count: number; totalCents: number }>
  byCategory: Record<string, { count: number; totalCents: number }>
  uncategorizedCount: number            // approved but still 'uncategorized' → accountant attention
  // attention buckets (surfaced separately; NOT part of the approved totals)
  needsReviewCount: number
  processingFailedCount: number
  rejectedCount: number
  approved: ReceiptRow[]                 // original-document references + provenance preserved
}
/**
 * Approved receipts for a business month (membership by the plain 'YYYY-MM-DD' receipt date → no UTC
 * drift), plus the attention buckets. This is the clean internal data layer the future accountant
 * package consumes. NOTHING here is labeled booked/posted/synced — approved means "manager-approved,
 * export-ready", not "in QuickBooks".
 */
export async function monthlyExpenseReport(month: string): Promise<MonthlyExpenseReport> {
  const db = getDb()
  const rows = await db.select().from(businessReceipts)
  const approved = rows.filter((r) => r.status === 'approved' && inBusinessMonth(r.receiptDate, month))
  const byEntity: MonthlyExpenseReport['byEntity'] = {}
  const byCategory: MonthlyExpenseReport['byCategory'] = {}
  let approvedTotalCents = 0, uncategorizedCount = 0
  for (const r of approved) {
    const amt = r.totalCents ?? 0
    approvedTotalCents += amt
    ;(byEntity[r.entity] ??= { count: 0, totalCents: 0 })
    byEntity[r.entity].count++; byEntity[r.entity].totalCents += amt
    ;(byCategory[r.category] ??= { count: 0, totalCents: 0 })
    byCategory[r.category].count++; byCategory[r.category].totalCents += amt
    if (r.category === 'uncategorized') uncategorizedCount++
  }
  // Attention buckets are month-scoped by receipt date where known, else always surfaced (undated → shown).
  const inMonthOrUndated = (r: ReceiptRow) => r.receiptDate == null || inBusinessMonth(r.receiptDate, month)
  return {
    month, approvedCount: approved.length, approvedTotalCents, byEntity, byCategory, uncategorizedCount,
    needsReviewCount: rows.filter((r) => r.status === 'needs_review' && inMonthOrUndated(r)).length,
    processingFailedCount: rows.filter((r) => r.status === 'processing_failed' && inMonthOrUndated(r)).length,
    rejectedCount: rows.filter((r) => r.status === 'rejected' && inBusinessMonth(r.receiptDate, month)).length,
    approved,
  }
}
