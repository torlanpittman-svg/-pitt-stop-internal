/**
 * Business Receipts — read models + writes. Facts only; no accounting policy, no money movement, no
 * QuickBooks mutation. The pure decision logic (status machine, field diff, audit entries, month
 * membership, cents parsing) lives in ./types; this layer only orchestrates it over the database.
 *
 * Append-only audit: audit_log is concatenated with `|| ...::jsonb` so a new entry is appended
 * atomically and existing entries are never rewritten. Approval is idempotent (a conditional update
 * that only fires when the row is not already approved).
 */
import { and, desc, eq, ne, or, sql, inArray, lt } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { getDb } from '@/platform/db'
import { inventoryVehicles } from '@/apps/auto-sales/schema'
import { vehicles } from '@/apps/workflow/schema'
import { businessReceipts, expenseRateCounters } from './schema'
import {
  auditEntry, decideApproval, decideFiling, diffFields, inBusinessMonth, isBusinessEntity, isCompleteStatus,
  isExpenseCategory, isFundingSource, isPaymentMethod,
  type AttentionReason, type AuditEntry, type BusinessEntity, type CategoryChoice, type ExpenseCategory,
  type FundingSource, type PaymentMethod, type ReceiptStatus,
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
  uploadedBy: string | null; uploadedByKey?: string | null
  // seed proposal fields (from the AI extraction) so the review screen is pre-filled — all overridable
  vendor?: string | null; receiptDate?: string | null; subtotalCents?: number | null; taxCents?: number | null
  totalCents?: number | null; category?: ExpenseCategory; paymentMethod?: string | null; paymentLast4?: string | null
  inventoryVehicleId?: string | null
}
/** A prior, non-rejected receipt with the same content hash — used to return the EXISTING active receipt
 *  id when a concurrent duplicate insert loses the unique race. Its metadata is never returned to an employee. */
export async function findActiveReceiptByHash(hash: string): Promise<ReceiptRow | null> {
  const [d] = await getDb().select().from(businessReceipts)
    .where(and(eq(businessReceipts.imageHash, hash), ne(businessReceipts.status, 'rejected')))
    .orderBy(desc(businessReceipts.createdAt)).limit(1)
  return d ?? null
}

/** ANY prior receipt (incl. rejected) with the same content hash + a stored private image. Used ONLY to
 *  REUSE the immutable Blob pathname for identical bytes (never re-uploading), avoiding a put-conflict on a
 *  re-upload after rejection. Returns just the pathname — never any receipt metadata. */
export async function storedPathnameForHash(hash: string): Promise<string | null> {
  const [d] = await getDb().select({ storage: businessReceipts.storage, ref: businessReceipts.storageRef })
    .from(businessReceipts)
    .where(and(eq(businessReceipts.imageHash, hash), eq(businessReceipts.storage, 'blob_private')))
    .orderBy(desc(businessReceipts.createdAt)).limit(1)
  return d?.ref ?? null
}

/** True for a Postgres unique-violation (23505). Drizzle wraps the driver error, so check the error, its
 *  `.cause`, and the message text (covers neon-http, pglite, and node-postgres shapes). */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown }
  if (e?.code === '23505' || e?.cause?.code === '23505') return true
  const text = `${String(e?.message ?? '')} ${String((e?.cause as { message?: unknown })?.message ?? '')} ${String(err)}`
  return /duplicate key value|unique constraint|23505/i.test(text)
}

/**
 * Create the receipt row on upload — DB-idempotent. A partial UNIQUE index on image_hash (WHERE status
 * <> 'rejected') means two concurrent identical uploads cannot both insert: the loser hits a unique
 * violation and we return the EXISTING active receipt's id with duplicate=true (no second row → no second
 * expense). A re-upload after a rejection is allowed (rejected rows are excluded from the index). Status
 * lands on needs_review; the image is preserved even when AI failed, so a receipt is never stranded.
 */
export async function createReceipt(input: CreateReceiptInput): Promise<{ id: string; duplicate: boolean }> {
  const status: ReceiptStatus = 'needs_review'
  const category: ExpenseCategory = input.category && isExpenseCategory(input.category) ? input.category : 'uncategorized'
  const audit = [
    auditEntry('uploaded', input.uploadedBy),
    input.aiStatus === 'extracted' ? auditEntry('extracted', 'system', undefined, input.aiModel ?? undefined) : auditEntry('extraction_failed', 'system'),
  ]
  try {
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
      uploadedBy: input.uploadedBy, uploadedByKey: input.uploadedByKey ?? null, auditLog: audit as unknown as object,
    }).returning({ id: businessReceipts.id })
    return { id: row.id, duplicate: false }
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findActiveReceiptByHash(input.imageHash)
      if (existing) return { id: existing.id, duplicate: true }
    }
    throw err
  }
}

/** Does this canonical inventory-vehicle id exist? App-level guard so an arbitrary/nonexistent id can
 *  never be attached to a receipt at review/approve time (the FK is the DB-level backstop). */
export async function inventoryVehicleExists(id: string): Promise<boolean> {
  if (!id) return false
  const [row] = await getDb().select({ id: inventoryVehicles.id }).from(inventoryVehicles).where(eq(inventoryVehicles.id, id)).limit(1)
  return !!row
}

export interface VehiclePickerOption { id: string; label: string }
/** Active inventory vehicles for the review-screen vehicle selector (id + a short human label). */
export async function listInventoryVehiclesForPicker(): Promise<VehiclePickerOption[]> {
  const rows = await getDb()
    .select({ id: inventoryVehicles.id, stock: inventoryVehicles.stockNumber, year: vehicles.year, make: vehicles.make, model: vehicles.model, vin: vehicles.vin })
    .from(inventoryVehicles).innerJoin(vehicles, eq(inventoryVehicles.vehicleId, vehicles.id))
    .orderBy(desc(inventoryVehicles.createdAt))
  return rows.map((r) => {
    const ymm = [r.year, r.make, r.model].filter(Boolean).join(' ')
    const tail = r.vin ? ` · ${r.vin.slice(-6)}` : ''
    return { id: r.id, label: `${r.stock ? r.stock + ' — ' : ''}${ymm || 'Vehicle'}${tail}` }
  })
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
export interface QueueCounts { needs_review: number; filed: number; approved: number; rejected: number; processing: number; processing_failed: number }
/** Counts by status for the queue header (surfaces incomplete/failed/unreviewed separately). */
export async function queueCounts(): Promise<QueueCounts> {
  const rows = await getDb().select({ status: businessReceipts.status, n: sql<number>`count(*)::int` }).from(businessReceipts).groupBy(businessReceipts.status)
  const c: QueueCounts = { needs_review: 0, filed: 0, approved: 0, rejected: 0, processing: 0, processing_failed: 0 }
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

// States from which a manager may still edit/correct a receipt (before a decision).
const EDITABLE_FROM: ReceiptStatus[] = ['needs_review', 'processing_failed']

/**
 * Save manager corrections WITHOUT approving (stays in its current review state). ATOMIC + optimistic:
 * the UPDATE only fires while the row is still editable (needs_review/processing_failed), so a correction
 * can never overwrite a row that was concurrently approved/rejected/locked-for-processing. Appends an
 * audited field diff. Returns conflict=true when the row moved on under a concurrent request.
 */
export async function saveReview(id: string, fields: ReviewFields, actor: string | null): Promise<{ ok: boolean; error?: string; conflict?: boolean }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  const set = sanitizeReview(fields)
  const changes = diffFields(before as Record<string, unknown>, set)
  const done = await db.update(businessReceipts).set({
    ...set, reviewedBy: actor, reviewedAt: new Date(), updatedAt: new Date(),
    auditLog: appendAudit(auditEntry('reviewed', actor, changes)),
  }).where(and(eq(businessReceipts.id, id), inArray(businessReceipts.status, EDITABLE_FROM))).returning({ id: businessReceipts.id })
  if (done.length === 0) return { ok: false, conflict: true, error: 'This receipt was just updated by someone else — refresh and try again.' }
  return { ok: true }
}

/**
 * Approve a receipt — IDEMPOTENT + ATOMIC. Applies any final corrections, then transitions the row to
 * 'approved' ONLY when it is still 'needs_review' (a double-click / retry / concurrent reject cannot
 * approve twice, append a duplicate approval, or clobber a newer status). Guards (pure decideApproval):
 * entity assigned, a positive total, and a VALID receipt date are all required — never approve an
 * unclassified, $0/unknown-total, or undated receipt. Sets qb_sync_status='export_ready' (NOT 'synced'
 * — no live QB write). Category may remain 'uncategorized' (stays flagged for the accountant).
 */
export async function approveReceipt(id: string, fields: ReviewFields, actor: string | null): Promise<{ ok: boolean; error?: string; alreadyApproved?: boolean }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  const set = sanitizeReview(fields)
  const entity = (set.entity ?? before.entity) as string
  const total = (set.totalCents !== undefined ? set.totalCents : before.totalCents) as number | null
  const date = (set.receiptDate !== undefined ? set.receiptDate : before.receiptDate) as string | null
  const decision = decideApproval(before.status as ReceiptStatus, entity, total, date)
  if (decision.action === 'noop_already_approved') return { ok: true, alreadyApproved: true }
  if (decision.action === 'blocked') return { ok: false, error: decision.error }
  const changes = diffFields(before as Record<string, unknown>, set)
  const claimed = await db.update(businessReceipts).set({
    ...set, status: 'approved', approvedBy: actor, approvedAt: new Date(),
    reviewedBy: before.reviewedBy ?? actor, reviewedAt: before.reviewedAt ?? new Date(),
    qbSyncStatus: 'export_ready', updatedAt: new Date(),
    auditLog: appendAudit(auditEntry('approved', actor, changes)),
  }).where(and(eq(businessReceipts.id, id), eq(businessReceipts.status, 'needs_review'))).returning({ id: businessReceipts.id })
  if (claimed.length === 0) {
    // Lost the race: re-read to distinguish already-approved (idempotent) from a concurrent move.
    const cur = await getReceipt(id)
    if (cur?.status === 'approved') return { ok: true, alreadyApproved: true }
    return { ok: false, error: 'This receipt was just updated by someone else — refresh and try again.' }
  }
  return { ok: true }
}

// ── Operational filing (employee self-file OR manager exception-resolution) ───────────────────────────
export interface FileReceiptInput {
  entity: BusinessEntity
  category: CategoryChoice
  funding: FundingSource
  paymentMethod: PaymentMethod | null
  vendor: string | null
  receiptDate: string | null
  totalCents: number | null
  subtotalCents?: number | null       // optional (manager card supplies these; capture flow does not)
  taxCents?: number | null
  memo?: string | null                // undefined = leave unchanged
  filingNote?: string | null
  inventoryVehicleId?: string | null  // undefined = unchanged; '' handled by the caller → null
}
export interface FileReceiptResult {
  ok: boolean; error?: string; conflict?: boolean; alreadyFiled?: boolean
  status?: 'filed' | 'needs_review'; reasons?: AttentionReason[]
}
export interface FilingActor { name: string | null; key: string | null }

/**
 * Finalize a receipt's OPERATIONAL FILING — the employee-safe terminal action (also used by a manager
 * resolving an exception). ATOMIC + guarded: the UPDATE only fires while the row is still editable
 * (needs_review/processing_failed), so it can never overwrite a concurrently approved/rejected/processing
 * row. The pure decideFiling() decides CLEAN (→ 'filed') vs EXCEPTION (→ stays 'needs_review' with concrete
 * attention_reasons). The employee's confirmed vendor/date/total are AUTHORITATIVE (written explicitly, over
 * any AI proposal) — and because a 'filed' row is not an editable state, a late AI retry can never claim or
 * overwrite it. Filing is NOT approval: filed_by/at record the ACTUAL person; approved_by is untouched.
 * Idempotent: a double-submit that finds the row already 'filed' is a no-op success.
 */
export async function fileReceipt(id: string, input: FileReceiptInput, actor: FilingActor, opts?: { duplicate?: boolean }): Promise<FileReceiptResult> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  if (before.status === 'filed') return { ok: true, alreadyFiled: true, status: 'filed', reasons: [] }
  if (!EDITABLE_FROM.includes(before.status as ReceiptStatus)) {
    return { ok: false, conflict: true, error: `This receipt is now "${before.status}" — refresh and try again.` }
  }
  const decision = decideFiling({
    entity: input.entity, category: input.category, funding: input.funding, paymentMethod: input.paymentMethod,
    vendor: input.vendor, receiptDate: input.receiptDate, totalCents: input.totalCents, duplicate: opts?.duplicate,
  })
  const now = new Date()
  const set: Record<string, unknown> = {
    entity: isBusinessEntity(input.entity) ? input.entity : 'unassigned',
    category: decision.category,
    funding: isFundingSource(input.funding) ? input.funding : 'unknown',
    paymentMethod: decision.paymentMethod,
    vendor: input.vendor || null,
    receiptDate: input.receiptDate || null,
    totalCents: input.totalCents ?? null,
    attentionReasons: JSON.stringify(decision.reasons),
    updatedAt: now,
  }
  if (input.subtotalCents !== undefined) set.subtotalCents = input.subtotalCents
  if (input.taxCents !== undefined) set.taxCents = input.taxCents
  if (input.memo !== undefined) set.memo = input.memo || null
  if (input.filingNote !== undefined) set.filingNote = input.filingNote || null
  if (input.inventoryVehicleId !== undefined) set.inventoryVehicleId = input.inventoryVehicleId || null

  if (decision.status === 'filed') {
    set.status = 'filed'; set.filedBy = actor.name; set.filedByKey = actor.key; set.filedAt = now
    set.qbSyncStatus = 'export_ready' // complete + export-ready for the accountant package — NOT posted to QB
  } else {
    set.status = 'needs_review'; set.qbSyncStatus = 'none'
    // An exception is NOT a filing — clear any stale filing attribution but keep the answers we captured.
    set.filedBy = null; set.filedByKey = null; set.filedAt = null
  }
  const action = decision.status === 'filed' ? 'filed' : 'flagged'
  const note = decision.status === 'filed' ? null : decision.reasons.join(', ')
  const done = await db.update(businessReceipts)
    .set({ ...set, auditLog: appendAudit(auditEntry(action, actor.name, undefined, note)) })
    .where(and(eq(businessReceipts.id, id), inArray(businessReceipts.status, EDITABLE_FROM)))
    .returning({ id: businessReceipts.id })
  if (done.length === 0) {
    const cur = await getReceipt(id)
    if (cur?.status === 'filed') return { ok: true, alreadyFiled: true, status: 'filed', reasons: [] }
    return { ok: false, conflict: true, error: `This receipt was just updated by someone else — refresh and try again.` }
  }
  return { ok: true, status: decision.status, reasons: decision.reasons }
}

/** Reject a receipt — ATOMIC. Only fires while still editable (needs_review/processing_failed), so it
 *  cannot overwrite a concurrent approval. Idempotent if already rejected. Never deletes the row/image. */
export async function rejectReceipt(id: string, reason: string | null, actor: string | null): Promise<{ ok: boolean; error?: string; conflict?: boolean }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  if (before.status === 'rejected') return { ok: true }
  const done = await db.update(businessReceipts).set({
    status: 'rejected', rejectedReason: reason || null, reviewedBy: actor, reviewedAt: new Date(),
    qbSyncStatus: 'none', updatedAt: new Date(), auditLog: appendAudit(auditEntry('rejected', actor, undefined, reason)),
  }).where(and(eq(businessReceipts.id, id), inArray(businessReceipts.status, EDITABLE_FROM))).returning({ id: businessReceipts.id })
  if (done.length === 0) {
    const cur = await getReceipt(id)
    if (cur?.status === 'rejected') return { ok: true }
    return { ok: false, conflict: true, error: `This receipt is now "${cur?.status ?? 'gone'}" — refresh and try again.` }
  }
  return { ok: true }
}

/** Reopen a filed/approved/rejected receipt back to needs_review — ATOMIC (only from those terminal states).
 *  Clears filing + approval + export flag so it can be corrected. Idempotent if already in review. */
export async function reopenReceipt(id: string, actor: string | null): Promise<{ ok: boolean; error?: string; conflict?: boolean }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  if (before.status === 'needs_review') return { ok: true }
  const done = await db.update(businessReceipts).set({
    status: 'needs_review', approvedBy: null, approvedAt: null, filedBy: null, filedByKey: null, filedAt: null,
    rejectedReason: null, qbSyncStatus: 'none', updatedAt: new Date(), auditLog: appendAudit(auditEntry('reopened', actor)),
  }).where(and(eq(businessReceipts.id, id), inArray(businessReceipts.status, ['filed', 'approved', 'rejected']))).returning({ id: businessReceipts.id })
  if (done.length === 0) {
    const cur = await getReceipt(id)
    if (cur?.status === 'needs_review') return { ok: true }
    return { ok: false, conflict: true, error: `This receipt is now "${cur?.status ?? 'gone'}" — refresh and try again.` }
  }
  return { ok: true }
}

// ── Retry extraction (re-run AI on the already-stored image; DURABLE per-receipt lock) ────────────────
// Stale-lock recovery window: a 'processing' claim older than this may be re-claimed (a crashed retry).
const RETRY_STALE_MS = 3 * 60 * 1000

/**
 * Atomically CLAIM a receipt for re-extraction by moving it to 'processing'. Only succeeds from an
 * editable state (needs_review/processing_failed) OR from a STALE 'processing' claim (crash recovery).
 * This is the durable, cross-instance guard against concurrent/repeated AI calls for the same receipt:
 * a second concurrent retry loses the claim and is told it is busy. Returns the claimed row (for its
 * stored image reference) or a reason it could not claim.
 */
export async function claimRetryExtraction(id: string): Promise<{ ok: true; row: ReceiptRow; token: string } | { ok: false; error: string; busy?: boolean }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  if (before.storage !== 'blob_private' || !before.storageRef) return { ok: false, error: 'No stored image to re-read.' }
  const token = randomUUID()
  const staleCutoff = new Date(Date.now() - RETRY_STALE_MS)
  // Atomic claim: a fresh token is written with the 'processing' status. Any prior in-flight attempt now
  // holds a DIFFERENT token, so its late completion/release (guarded by token) will no-op.
  const claimed = await db.update(businessReceipts)
    .set({ status: 'processing', processingToken: token, updatedAt: new Date() })
    .where(and(
      eq(businessReceipts.id, id),
      or(
        inArray(businessReceipts.status, EDITABLE_FROM),
        and(eq(businessReceipts.status, 'processing'), sql`${businessReceipts.updatedAt} < ${staleCutoff}`),
      ),
    ))
    .returning({ id: businessReceipts.id })
  if (claimed.length === 0) return { ok: false, busy: true, error: 'This receipt is already being re-read — try again in a moment.' }
  return { ok: true, row: before, token }
}

/** Release a claim WITHOUT applying a result (blob/AI error) — restores the row to needs_review. Guarded
 *  by status='processing' AND the owned token, so a stale attempt cannot release a newer attempt's lock. */
export async function releaseRetryClaim(id: string, token: string): Promise<void> {
  await getDb().update(businessReceipts)
    .set({ status: 'needs_review', processingToken: null, updatedAt: new Date() })
    .where(and(eq(businessReceipts.id, id), eq(businessReceipts.status, 'processing'), eq(businessReceipts.processingToken, token)))
}

export interface RetryExtractionUpdate {
  aiStatus: 'extracted' | 'failed'; aiModel: string | null; aiRaw: unknown; aiExtracted: unknown; confidence: unknown
  vendor?: string | null; receiptDate?: string | null; subtotalCents?: number | null; taxCents?: number | null
  totalCents?: number | null; category?: ExpenseCategory; paymentMethod?: string | null; paymentLast4?: string | null
}
/**
 * Apply a re-extraction result to a receipt WE HOLD THE PROCESSING LOCK ON. Guarded WHERE status =
 * 'processing', so a LATE result (the receipt was reopened/approved/rejected after a stale reclaim, or
 * the lock was lost) is DROPPED — never overwriting a newer status or a manager correction. Only pre-fills
 * EMPTY proposal fields (never clobbers a manager edit); ai_raw is refreshed for the new proposal. Returns
 * the row to needs_review. No new row, no expense.
 */
export async function applyRetryExtraction(id: string, token: string, u: RetryExtractionUpdate, actor: string | null): Promise<{ ok: boolean; error?: string; stale?: boolean }> {
  const db = getDb()
  const before = await getReceipt(id)
  if (!before) return { ok: false, error: 'Receipt not found.' }
  // Ownership check: only THIS attempt (matching token) while still processing may write. A stale attempt
  // whose token was superseded — or a receipt already moved on by a manager — is a no-op.
  if (before.status !== 'processing' || before.processingToken !== token) return { ok: false, stale: true, error: 'This extraction attempt is no longer current.' }
  const set: Record<string, unknown> = {
    aiStatus: u.aiStatus, aiModel: u.aiModel, aiRaw: u.aiRaw as object, aiExtracted: u.aiExtracted as object, confidence: u.confidence as object,
    status: 'needs_review', processingToken: null, updatedAt: new Date(),
  }
  // Fill empty proposal fields only (respect prior manager edits).
  if (!before.vendor && u.vendor) set.vendor = u.vendor
  if (!before.receiptDate && u.receiptDate) set.receiptDate = u.receiptDate
  if (before.subtotalCents == null && u.subtotalCents != null) set.subtotalCents = u.subtotalCents
  if (before.taxCents == null && u.taxCents != null) set.taxCents = u.taxCents
  if (before.totalCents == null && u.totalCents != null) set.totalCents = u.totalCents
  if (before.category === 'uncategorized' && u.category && u.category !== 'uncategorized') set.category = u.category
  if (!before.paymentMethod && u.paymentMethod && isPaymentMethod(u.paymentMethod)) set.paymentMethod = u.paymentMethod
  if (!before.paymentLast4 && u.paymentLast4) set.paymentLast4 = u.paymentLast4
  const done = await db.update(businessReceipts)
    .set({ ...set, auditLog: appendAudit(auditEntry('retried', actor, undefined, u.aiStatus)) })
    .where(and(eq(businessReceipts.id, id), eq(businessReceipts.status, 'processing'), eq(businessReceipts.processingToken, token)))
    .returning({ id: businessReceipts.id })
  if (done.length === 0) return { ok: false, stale: true, error: 'This extraction attempt is no longer current.' }
  return { ok: true }
}

// ── Durable, server-enforced rate limiting (cross-instance; distinct from the extraction lock) ────────
// Concrete limits (scope · window). Tuned generously for real shop use; they cap abuse/runaway AI cost.
export const RATE_LIMITS = {
  upload:         { limit: 60, windowMs: 10 * 60_000 },  // 60 uploads / 10 min per actor
  extractActor:   { limit: 30, windowMs: 10 * 60_000 },  // 30 AI extraction attempts / 10 min per actor
  extractReceipt: { limit: 10, windowMs: 60 * 60_000 },  // 10 AI extraction attempts / hour per receipt
  file:           { limit: 120, windowMs: 10 * 60_000 }, // 120 filing submits / 10 min per actor-or-device
} as const

export interface RateResult { ok: boolean; retryAfterSec?: number }
/**
 * Consume one unit from a fixed-window rate bucket — ATOMIC. A single statement both increments the
 * (bucket, window_start) counter AND enforces the cap:
 *
 *   INSERT ... VALUES (bucket, wStart, 1)
 *   ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < limit
 *   RETURNING count
 *
 * The ON CONFLICT DO UPDATE takes a ROW LOCK on the counter row, so concurrent independent connections
 * serialize on it and cannot both pass the check — exactly `limit` succeed per window. A row is returned
 * only when admitted (first-in-window insert, or an under-limit increment); an empty result means the cap
 * is reached → reject. A rejected attempt does NOT consume budget (the guarded UPDATE is a no-op). Prior
 * windows for this bucket are pruned opportunistically (bounded, O(few) per call). Callers bucket by the
 * SERVER-VERIFIED actor (never a forwarded header alone).
 *
 * Fixed window (aligned to the epoch): bursts of up to `limit` can occur on either side of a boundary
 * (≤ 2× across the boundary) — a standard, well-understood trade-off for atomicity without interactive
 * transactions (the Neon HTTP driver has none). retry-after points at the next window boundary.
 */
export async function consumeRateLimit(bucket: string, limit: number, windowMs: number): Promise<RateResult> {
  const db = getDb()
  const now = Date.now()
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs)
  const res = await db.execute(sql`
    INSERT INTO ${expenseRateCounters} (bucket, window_start, count)
    VALUES (${bucket}, ${windowStart.toISOString()}::timestamptz, 1)
    ON CONFLICT (bucket, window_start)
    DO UPDATE SET count = ${expenseRateCounters.count} + 1
    WHERE ${expenseRateCounters.count} < ${limit}
    RETURNING count
  `)
  const admitted = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])
  const ok = Array.isArray(admitted) && admitted.length > 0
  if (ok) {
    // Opportunistic bounded prune of this bucket's earlier windows (keeps the table small).
    await db.delete(expenseRateCounters).where(and(eq(expenseRateCounters.bucket, bucket), lt(expenseRateCounters.windowStart, windowStart))).catch(() => {})
    return { ok: true }
  }
  const retryAfterSec = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000))
  return { ok: false, retryAfterSec }
}

// ── Reporting / accountant-package readiness (internal; nothing is "booked" or "synced") ──────────────
export interface MonthlyExpenseReport {
  month: string
  // The COMPLETE / operational set for the month = employee-FILED ∪ legacy-APPROVED receipts.
  completeCount: number
  purchasesTotalCents: number           // what was BOUGHT (every complete receipt counted exactly once)
  filedCount: number                    // employee/manager operational filings (new path)
  approvedCount: number                 // LEGACY manager approvals (preserved; approved-only)
  approvedTotalCents: number            // LEGACY approved amount only (back-compat)
  byEntity: Record<string, { count: number; totalCents: number }>    // over the complete set
  byCategory: Record<string, { count: number; totalCents: number }>  // over the complete set
  // Funding split of the complete set — purchases are NOT the same as cash actually paid. Each complete
  // receipt lands in exactly ONE bucket (no double counting); the four sum to purchasesTotalCents.
  businessCashOutflowCents: number      // funding='business' → real business-account cash spent
  personalReimbursableCents: number     // funding='personal' → owed to an employee, NOT business cash
  unpaidCents: number                   // funding='unpaid'   → not yet cash spent
  unknownFundingCents: number           // funding='unknown'  → legacy/incomplete (needs a manager)
  uncategorizedCount: number            // complete but still 'uncategorized' → accountant attention
  // attention buckets (surfaced separately; NOT part of the complete totals)
  needsReviewCount: number
  processingFailedCount: number
  rejectedCount: number
  complete: ReceiptRow[]                 // original-document references + provenance preserved
}
/**
 * The complete (filed ∪ legacy-approved) receipts for a business month (membership by the plain
 * 'YYYY-MM-DD' receipt date → no UTC drift), plus honest funding buckets and the attention buckets. This
 * is the clean internal data layer the future accountant package consumes. NOTHING here is labeled
 * booked/posted/synced — 'filed'/'approved' mean "operationally captured, export-ready", not "in QuickBooks".
 * Purchases (what was bought) are kept separate from cash actually paid (business funding only).
 */
export async function monthlyExpenseReport(month: string): Promise<MonthlyExpenseReport> {
  const db = getDb()
  const rows = await db.select().from(businessReceipts)
  const complete = rows.filter((r) => isCompleteStatus(r.status) && inBusinessMonth(r.receiptDate, month))
  const byEntity: MonthlyExpenseReport['byEntity'] = {}
  const byCategory: MonthlyExpenseReport['byCategory'] = {}
  const funded = { business: 0, personal: 0, unpaid: 0, unknown: 0 }
  let purchasesTotalCents = 0, uncategorizedCount = 0, filedCount = 0, approvedCount = 0, approvedTotalCents = 0
  for (const r of complete) {
    const amt = r.totalCents ?? 0
    purchasesTotalCents += amt
    if (r.status === 'filed') filedCount++
    if (r.status === 'approved') { approvedCount++; approvedTotalCents += amt }
    ;(byEntity[r.entity] ??= { count: 0, totalCents: 0 })
    byEntity[r.entity].count++; byEntity[r.entity].totalCents += amt
    ;(byCategory[r.category] ??= { count: 0, totalCents: 0 })
    byCategory[r.category].count++; byCategory[r.category].totalCents += amt
    if (r.category === 'uncategorized') uncategorizedCount++
    const f = (isFundingSource(r.funding) ? r.funding : 'unknown') as FundingSource
    funded[f] += amt
  }
  // Attention buckets are month-scoped by receipt date where known, else always surfaced (undated → shown).
  const inMonthOrUndated = (r: ReceiptRow) => r.receiptDate == null || inBusinessMonth(r.receiptDate, month)
  return {
    month, completeCount: complete.length, purchasesTotalCents, filedCount, approvedCount, approvedTotalCents,
    byEntity, byCategory,
    businessCashOutflowCents: funded.business, personalReimbursableCents: funded.personal,
    unpaidCents: funded.unpaid, unknownFundingCents: funded.unknown, uncategorizedCount,
    needsReviewCount: rows.filter((r) => r.status === 'needs_review' && inMonthOrUndated(r)).length,
    processingFailedCount: rows.filter((r) => r.status === 'processing_failed' && inMonthOrUndated(r)).length,
    rejectedCount: rows.filter((r) => r.status === 'rejected' && inBusinessMonth(r.receiptDate, month)).length,
    complete,
  }
}
