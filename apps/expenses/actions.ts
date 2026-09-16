'use server'
/**
 * Business Receipts — MANAGER-gated server actions (review, correct, approve, reject, reopen, retry).
 *
 * Authorization is enforced at the action layer via receiptManager() (FAIL-CLOSED; SEPARATE from
 * ADMIN_PASSWORD — a manager PIN suffices, admin ⊇ manager; never dev-opens). Independent of any hidden
 * UI control: an anonymous or employee-only caller cannot approve/reject. Capture/upload is employee-safe
 * and lives in the API route (app/api/expenses/receipt). No money movement; no QuickBooks mutation.
 */
import { revalidatePath } from 'next/cache'
import { receiptManager } from './authz'
import { saveReview, approveReceipt, rejectReceipt, reopenReceipt, claimRetryExtraction, applyRetryExtraction, releaseRetryClaim, inventoryVehicleExists, type ReviewFields } from './db'
import { parseCents, isBusinessEntity, isExpenseCategory, isPaymentMethod, type BusinessEntity, type ExpenseCategory, type PaymentMethod } from './types'
import { errorCode } from './errors'
import { logger } from '@/platform/logger'

const revalidate = () => { revalidatePath('/expenses/review'); revalidatePath('/expenses') }

/** If a vehicle association is being SET (non-empty), it must be a real canonical inventory vehicle.
 *  Clearing the association ('' → null) is always allowed. Returns an error string, or null when OK. */
async function validateVehicle(fields: ReviewFields): Promise<string | null> {
  if (fields.inventoryVehicleId === undefined || fields.inventoryVehicleId === null || fields.inventoryVehicleId === '') return null
  return (await inventoryVehicleExists(fields.inventoryVehicleId)) ? null : 'That vehicle no longer exists — pick a current inventory vehicle or leave it unassigned.'
}

/** Shape posted from the review form (all strings; parsed + validated here). */
export interface ReviewForm {
  id: string
  entity?: string; category?: string; vendor?: string; receiptDate?: string
  subtotal?: string; tax?: string; total?: string
  paymentMethod?: string; accountRef?: string; paymentLast4?: string; memo?: string; inventoryVehicleId?: string
}

/** Build the validated ReviewFields from a form. Blank dollar inputs stay `undefined` (unchanged), a
 *  cleared field is sent explicitly by the client as '' → null. Never coerces a missing amount to $0. */
function reviewFieldsFrom(f: ReviewForm): ReviewFields {
  const fields: ReviewFields = {}
  if (f.entity !== undefined) fields.entity = (isBusinessEntity(f.entity) ? f.entity : 'unassigned') as BusinessEntity
  if (f.category !== undefined) fields.category = (isExpenseCategory(f.category) ? f.category : 'uncategorized') as ExpenseCategory
  if (f.vendor !== undefined) fields.vendor = f.vendor.trim() || null
  if (f.receiptDate !== undefined) { const d = f.receiptDate.trim(); fields.receiptDate = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null }
  if (f.subtotal !== undefined) fields.subtotalCents = f.subtotal.trim() === '' ? null : parseCents(f.subtotal)
  if (f.tax !== undefined) fields.taxCents = f.tax.trim() === '' ? null : parseCents(f.tax)
  if (f.total !== undefined) fields.totalCents = f.total.trim() === '' ? null : parseCents(f.total)
  if (f.paymentMethod !== undefined) fields.paymentMethod = (isPaymentMethod(f.paymentMethod) ? f.paymentMethod : null) as PaymentMethod | null
  if (f.accountRef !== undefined) fields.accountRef = f.accountRef.trim() || null
  if (f.paymentLast4 !== undefined) fields.paymentLast4 = (f.paymentLast4.match(/\d{4}/)?.[0]) ?? null
  if (f.memo !== undefined) fields.memo = f.memo.trim() || null
  if (f.inventoryVehicleId !== undefined) fields.inventoryVehicleId = f.inventoryVehicleId.trim() || null
  return fields
}

export async function saveReviewAction(f: ReviewForm): Promise<{ ok: boolean; error?: string }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const fields = reviewFieldsFrom(f)
  const vErr = await validateVehicle(fields)
  if (vErr) return { ok: false, error: vErr }
  const r = await saveReview(f.id, fields, actor.name)
  if (r.ok) revalidate()
  return r
}

export async function approveReceiptAction(f: ReviewForm): Promise<{ ok: boolean; error?: string; alreadyApproved?: boolean }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const fields = reviewFieldsFrom(f)
  const vErr = await validateVehicle(fields)
  if (vErr) return { ok: false, error: vErr }
  const r = await approveReceipt(f.id, fields, actor.name)
  if (r.ok) revalidate()
  return r
}

export async function rejectReceiptAction(f: { id: string; reason?: string }): Promise<{ ok: boolean; error?: string }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const r = await rejectReceipt(f.id, f.reason?.trim() || null, actor.name)
  if (r.ok) revalidate()
  return r
}

export async function reopenReceiptAction(f: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const r = await reopenReceipt(f.id, actor.name)
  if (r.ok) revalidate()
  return r
}

/**
 * Re-run AI extraction on the already-stored image (manager-gated). Concurrency-safe: it first CLAIMS a
 * durable per-receipt lock (status→'processing') so two managers cannot fire concurrent AI calls for the
 * same receipt; a second caller is told it is busy. The result is applied only while the lock is held, so
 * a late result can never overwrite a manager correction or a newer status. Never creates a receipt/expense.
 */
export async function retryExtractionAction(f: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const claim = await claimRetryExtraction(f.id)
  if (!claim.ok) return { ok: false, error: claim.error }
  const row = claim.row
  try {
    // Read the ORIGINAL bytes from PRIVATE storage server-side (never a public URL).
    const { getPrivateBlob } = await import('@/platform/blob')
    const blob = await getPrivateBlob(row.storageRef!)
    if (!blob) { await releaseRetryClaim(f.id); return { ok: false, error: 'Could not load the stored image.' } }
    const { extractExpense } = await import('./ai')
    const ai = await extractExpense(blob.bytes.toString('base64'), row.contentType || 'image/jpeg')
    const e = ai.extraction
    const r = await applyRetryExtraction(f.id, {
      aiStatus: ai.status, aiModel: ai.model, aiRaw: ai.raw, aiExtracted: e, confidence: e.present,
      vendor: e.vendor, receiptDate: e.date, subtotalCents: e.subtotalCents, taxCents: e.taxCents,
      totalCents: e.totalCents, category: e.categoryKey, paymentMethod: e.paymentMethod, paymentLast4: e.paymentLast4,
    }, actor.name)
    if (r.ok) revalidate()
    return r.ok ? r : { ok: false, error: r.error ?? 'Could not update — refresh and try again.' }
  } catch (err) {
    await releaseRetryClaim(f.id).catch(() => {})
    logger.error('expenses:retry', 'failed', { code: errorCode(err) })
    return { ok: false, error: 'Could not re-read the image — enter the details manually.' }
  }
}
