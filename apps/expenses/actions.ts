'use server'
/**
 * Business Receipts — MANAGER-gated server actions (review, correct, approve, reject, reopen, retry).
 *
 * Authorization is enforced at the action layer via authorizedManager() (SEPARATE from ADMIN_PASSWORD —
 * a manager PIN suffices; admin ⊇ manager). This is independent of any hidden UI control: an anonymous
 * or employee-only caller cannot approve/reject. Capture/upload itself is employee-safe and lives in the
 * API route (app/api/expenses/receipt). No money movement; no QuickBooks mutation.
 */
import { revalidatePath } from 'next/cache'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { saveReview, approveReceipt, rejectReceipt, reopenReceipt, getReceipt, applyRetryExtraction, inventoryVehicleExists, type ReviewFields } from './db'
import { parseCents, isBusinessEntity, isExpenseCategory, isPaymentMethod, type BusinessEntity, type ExpenseCategory, type PaymentMethod } from './types'

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
  const actor = await authorizedManager()
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
  const actor = await authorizedManager()
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
  const actor = await authorizedManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const r = await rejectReceipt(f.id, f.reason?.trim() || null, actor.name)
  if (r.ok) revalidate()
  return r
}

export async function reopenReceiptAction(f: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const actor = await authorizedManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const r = await reopenReceipt(f.id, actor.name)
  if (r.ok) revalidate()
  return r
}

/** Re-run AI extraction on the already-stored image (manager-gated). Never creates a duplicate receipt
 *  or an expense; only refreshes the proposal on the existing row. */
export async function retryExtractionAction(f: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const actor = await authorizedManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  const row = await getReceipt(f.id)
  if (!row) return { ok: false, error: 'Receipt not found.' }
  if (!row.storageRef || row.storage !== 'blob_private') return { ok: false, error: 'No stored image to re-read.' }
  try {
    // Read the ORIGINAL bytes from PRIVATE storage server-side (never a public URL). Idempotent: this
    // only refreshes the proposal on the existing row — it never creates a new receipt or expense.
    const { getPrivateBlob } = await import('@/platform/blob')
    const blob = await getPrivateBlob(row.storageRef)
    if (!blob) return { ok: false, error: 'Could not load the stored image.' }
    const bytes = blob.bytes
    const { extractExpense } = await import('./ai')
    const ai = await extractExpense(bytes.toString('base64'), row.contentType || 'image/jpeg')
    const e = ai.extraction
    const r = await applyRetryExtraction(f.id, {
      aiStatus: ai.status, aiModel: ai.model, aiRaw: ai.raw, aiExtracted: e, confidence: e.present,
      vendor: e.vendor, receiptDate: e.date, subtotalCents: e.subtotalCents, taxCents: e.taxCents,
      totalCents: e.totalCents, category: e.categoryKey, paymentMethod: e.paymentMethod, paymentLast4: e.paymentLast4,
    }, actor.name)
    if (r.ok) revalidate()
    return r
  } catch {
    return { ok: false, error: 'Could not re-read the image — enter the details manually.' }
  }
}
