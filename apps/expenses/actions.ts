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
import { receiptManager, receiptUploader, canFileReceipt } from './authz'
import { saveReview, approveReceipt, rejectReceipt, reopenReceipt, claimRetryExtraction, applyRetryExtraction, releaseRetryClaim, inventoryVehicleExists, consumeRateLimit, getReceipt, fileReceipt, RATE_LIMITS, type ReviewFields, type FileReceiptInput } from './db'
import {
  parseCents, isBusinessEntity, isExpenseCategory, isPaymentMethod, isFundingSource, categoryChoiceFrom,
  type BusinessEntity, type ExpenseCategory, type PaymentMethod, type FundingSource,
} from './types'
import { errorCode } from './errors'
import { resolveReceiptPayment } from './payment'
import { receiptDateWarning, todayBusinessDate } from './checks'
import { allocateReceipt, isUuid } from './job-expenses'
import { setReceiptVehicle } from './vehicle-link'
import { logger } from '@/platform/logger'

const revalidate = () => { revalidatePath('/expenses/review'); revalidatePath('/expenses') }

/**
 * The sales-inventory vehicle posted with a review/approve form: undefined = not sent (leave it alone),
 * null = remove it, otherwise the vehicle id. It is never written as a plain review field — it goes through
 * vehicle-link.setReceiptVehicle, the ONE assignment path, so every safeguard applies (real vehicle, not on a
 * customer job, no return standing against it, any match to a vehicle expense undone, audited).
 */
function vehicleFrom(f: ReviewForm): string | null | undefined {
  return f.inventoryVehicleId === undefined ? undefined : (f.inventoryVehicleId.trim() || null)
}
/** Apply the posted vehicle BEFORE the review write. Fails closed: if the assignment is refused, nothing else is saved. */
async function applyVehicle(receiptId: string, vehicleId: string | null | undefined, actor: { name: string; key?: string | null }): Promise<string | null> {
  if (vehicleId === undefined) return null
  if (vehicleId && !(await inventoryVehicleExists(vehicleId))) return 'That vehicle no longer exists — pick a current inventory vehicle or leave it unassigned.'
  const r = await setReceiptVehicle({ receiptId, inventoryVehicleId: vehicleId }, { name: actor.name, key: actor.key ?? null })
  if (!r.ok) return r.error ?? 'Could not assign the vehicle.'
  for (const v of [r.inventoryVehicleId, r.previousVehicleId]) if (v) { revalidatePath(`/auto-sales/${v}`); revalidatePath(`/admin/auto-sales/${v}`) }
  if (!r.already) { revalidatePath('/auto-sales'); revalidatePath('/admin/auto-sales') }
  return null
}

/** Shape posted from the review form (all strings; parsed + validated here). */
export interface ReviewForm {
  id: string
  entity?: string; category?: string; vendor?: string; receiptDate?: string
  subtotal?: string; tax?: string; total?: string
  shipping?: string; invoiceNumber?: string; orderNumber?: string; description?: string
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
  if (f.shipping !== undefined) fields.shippingCents = f.shipping.trim() === '' ? null : parseCents(f.shipping)
  if (f.invoiceNumber !== undefined) fields.invoiceNumber = f.invoiceNumber.trim().slice(0, 80) || null
  if (f.orderNumber !== undefined) fields.orderNumber = f.orderNumber.trim().slice(0, 80) || null
  if (f.description !== undefined) fields.description = f.description.trim().slice(0, 300) || null
  if (f.paymentMethod !== undefined) fields.paymentMethod = (isPaymentMethod(f.paymentMethod) ? f.paymentMethod : null) as PaymentMethod | null
  if (f.accountRef !== undefined) fields.accountRef = f.accountRef.trim() || null
  if (f.paymentLast4 !== undefined) fields.paymentLast4 = (f.paymentLast4.match(/\d{4}/)?.[0]) ?? null
  if (f.memo !== undefined) fields.memo = f.memo.trim() || null
  return fields
}

export async function saveReviewAction(f: ReviewForm): Promise<{ ok: boolean; error?: string }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const fields = reviewFieldsFrom(f)
  const vErr = await applyVehicle(f.id, vehicleFrom(f), actor)
  if (vErr) return { ok: false, error: vErr }
  const r = await saveReview(f.id, fields, actor.name)
  if (r.ok) revalidate()
  return r
}

/**
 * Employee (or manager) OPERATIONAL FILING — the tap-first flow's finalize step. FAIL-CLOSED: requires a
 * verified session (anonymous → rejected) AND ownership of THIS receipt (canFileReceipt: manager role, a
 * signed capture token minted for it at upload, or an uploaded_by_key match). An employee can therefore
 * never file an arbitrary receipt id. The pure decideFiling() (inside db.fileReceipt) decides clean-file vs
 * exception; this action just parses the form + enforces authorization. Filing is NOT approval and never
 * touches QuickBooks.
 */
export interface FileForm {
  id: string; token?: string
  paymentChoice?: string; otherPayment?: string
  // Explicit classification of an "Other" payment source (whose money, and — for business money — the
  // instrument). Validated against the server-side allowlist; never derived from the description text.
  otherFunding?: string; otherPaymentMethod?: string
  entity?: string; category?: string; categoryMode?: string; funding?: string; paymentMethod?: string
  vendor?: string; receiptDate?: string; subtotal?: string; tax?: string; total?: string
  memo?: string; filingNote?: string; duplicate?: boolean
  // Auto Sales inventory vehicle this purchase was for ('' = none). Applied AFTER the save through the one
  // assignment path (vehicle-link.setReceiptVehicle). vehicleMatchEventId = an expense already entered on that
  // vehicle that IS this purchase — the receipt is matched to it so it is counted once.
  inventoryVehicleId?: string; vehicleMatchEventId?: string
  shipping?: string; invoiceNumber?: string; orderNumber?: string; description?: string
  // The customer job this purchase was for (capture started from a job, or picked on the confirm step). On a
  // successful save the WHOLE purchase is pointed at that job — a link to this same receipt, never a second
  // expense, and never a change to the customer's invoice.
  serviceOrderId?: string
  // The person looked at a date flagged as questionable (old / future / year possibly misread) and confirmed it.
  dateConfirmed?: boolean
  // Manager-only: acknowledge a still-OUTSTANDING exception (reimbursement/unpaid/mixed) as reviewed so it
  // leaves the backlog WITHOUT falsifying funding/category. Ignored for non-managers.
  acknowledge?: boolean
}
export interface FileResult {
  ok: boolean; error?: string; conflict?: boolean; alreadyFiled?: boolean; status?: 'filed' | 'needs_review'; reasons?: string[]; clarified?: boolean
  jobLinked?: boolean; jobLinkError?: string   // set only when a serviceOrderId was supplied
  vehicleLinked?: boolean; vehicleLinkError?: string   // set only when inventoryVehicleId was supplied
}

export async function fileReceiptAction(f: FileForm): Promise<FileResult> {
  const uploader = await receiptUploader()
  if (!uploader) return { ok: false, error: 'Sign in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const row = await getReceipt(f.id)
  if (!row) return { ok: false, error: 'Receipt not found.' }
  // Ownership enforced server-side, independent of the UI.
  if (!canFileReceipt(uploader.actor, { id: row.id, uploadedByKey: row.uploadedByKey }, f.token)) {
    return { ok: false, error: 'You can only file a receipt you captured.' }
  }
  // Acknowledging an outstanding exception is a MANAGER review act — honored only for a verified manager.
  const acknowledge = f.acknowledge === true && !!(await receiptManager())
  // Durable rate limit — bound filing submits per named actor, else per shared device by receipt.
  const bucket = uploader.actor?.key ? `file:actor:${uploader.actor.key}` : `file:rcpt:${f.id}`
  const rl = await consumeRateLimit(bucket, RATE_LIMITS.file.limit, RATE_LIMITS.file.windowMs)
  if (!rl.ok) return { ok: false, error: `Too many saves — try again in ${rl.retryAfterSec}s.` }

  const total = f.total !== undefined ? (f.total.trim() === '' ? null : parseCents(f.total)) : null
  const input: FileReceiptInput = {
    entity: (isBusinessEntity(f.entity) ? f.entity : 'unassigned') as BusinessEntity,
    category: categoryChoiceFrom(f.categoryMode, f.category),
    funding: (isFundingSource(f.funding) ? f.funding : 'unknown') as FundingSource,
    paymentMethod: (isPaymentMethod(f.paymentMethod) ? f.paymentMethod : null) as PaymentMethod | null,
    vendor: f.vendor !== undefined ? (f.vendor.trim() || null) : null,
    receiptDate: f.receiptDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(f.receiptDate.trim()) ? f.receiptDate.trim() : null,
    totalCents: total,
  }
  if (f.paymentChoice !== undefined) {
    const payment = resolveReceiptPayment(f.paymentChoice, f.otherPayment, { funding: f.otherFunding, paymentMethod: f.otherPaymentMethod })
    if (!payment.ok) return { ok: false, error: payment.error }
    // Derive instrument, funding and account together on the server, never from client-supplied mappings.
    Object.assign(input, payment.payment)
  } else if (input.funding !== row.funding || input.paymentMethod !== row.paymentMethod) {
    // Legacy manager controls may change the method/funding without selecting a known source.
    input.accountRef = null
    input.paymentLast4 = null
  }
  if (f.subtotal !== undefined) input.subtotalCents = f.subtotal.trim() === '' ? null : parseCents(f.subtotal)
  if (f.tax !== undefined) input.taxCents = f.tax.trim() === '' ? null : parseCents(f.tax)
  if (f.shipping !== undefined) input.shippingCents = f.shipping.trim() === '' ? null : parseCents(f.shipping)
  if (f.invoiceNumber !== undefined) input.invoiceNumber = f.invoiceNumber.trim().slice(0, 80) || null
  if (f.orderNumber !== undefined) input.orderNumber = f.orderNumber.trim().slice(0, 80) || null
  if (f.description !== undefined) input.description = f.description.trim().slice(0, 300) || null
  if (f.memo !== undefined) input.memo = f.memo.trim() || null
  if (f.filingNote !== undefined) input.filingNote = f.filingNote.trim() || null
  if (f.serviceOrderId !== undefined && f.serviceOrderId !== '' && !isUuid(f.serviceOrderId)) return { ok: false, error: 'That job could not be found.' }
  const vehicleId = f.inventoryVehicleId !== undefined ? (f.inventoryVehicleId.trim() || null) : undefined
  if (vehicleId) {
    if (f.serviceOrderId) return { ok: false, error: 'Choose a customer job or a sales-inventory vehicle for this receipt — not both.' }
    if (!(await inventoryVehicleExists(vehicleId))) return { ok: false, error: 'That vehicle no longer exists — pick a current inventory vehicle or leave it off.' }
  }
  // A date that looks misread/old/future stays flagged unless the person explicitly confirmed it.
  const questionableDate = f.dateConfirmed !== true && receiptDateWarning(input.receiptDate, todayBusinessDate()) !== null
  const who = { name: uploader.name, key: uploader.actor?.key ?? null }
  const r: FileResult = await fileReceipt(f.id, input, who, { duplicate: f.duplicate, acknowledge, questionableDate })
  if (r.ok && f.serviceOrderId) {
    // Point the whole purchase at the job. Idempotent per (receipt, job); a failure here never un-saves the
    // receipt — it is reported so the link can be made from the job instead.
    const link = await allocateReceipt({ receiptId: f.id, target: 'job', serviceOrderId: f.serviceOrderId, amountCents: null }, who)
      .catch(() => ({ ok: false as const, error: 'Could not attach the job.' }))
    r.jobLinked = link.ok
    if (!link.ok) r.jobLinkError = link.error
    if (link.ok) revalidatePath(`/orders/${f.serviceOrderId}`)
  }
  // Assign the purchase to the sales-inventory vehicle (or match it to an expense already on that vehicle).
  // Same rule as the job link: a failure here never un-saves the receipt — it is reported. A repeat submit of
  // an already-filed receipt may only re-apply this for a manager (an employee cannot re-point a filed receipt).
  if (r.ok && vehicleId !== undefined && (!r.alreadyFiled || !!(await receiptManager()))) {
    const link = await setReceiptVehicle({ receiptId: f.id, inventoryVehicleId: vehicleId, matchEventId: f.vehicleMatchEventId || null }, who)
      .catch(() => ({ ok: false as const, error: 'Could not assign the vehicle.', inventoryVehicleId: undefined, previousVehicleId: undefined }))
    if (vehicleId) { r.vehicleLinked = link.ok; if (!link.ok) r.vehicleLinkError = link.error }
    if (link.ok) for (const v of [link.inventoryVehicleId, link.previousVehicleId]) if (v) { revalidatePath(`/auto-sales/${v}`); revalidatePath(`/admin/auto-sales/${v}`) }
    if (link.ok) { revalidatePath('/auto-sales'); revalidatePath('/admin/auto-sales') }
  }
  if (r.ok) revalidate()
  return r
}

export async function approveReceiptAction(f: ReviewForm): Promise<{ ok: boolean; error?: string; alreadyApproved?: boolean }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.id) return { ok: false, error: 'Missing receipt.' }
  const fields = reviewFieldsFrom(f)
  const vErr = await applyVehicle(f.id, vehicleFrom(f), actor)
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
  // Durable rate limits (distinct from the extraction lock): bound repeated AI attempts per manager AND
  // per receipt, so hammering "Retry" cannot burn unbounded AI cost even across app instances.
  const perActor = await consumeRateLimit(`extract:actor:${actor.key}`, RATE_LIMITS.extractActor.limit, RATE_LIMITS.extractActor.windowMs)
  if (!perActor.ok) return { ok: false, error: `Too many re-reads — try again in ${perActor.retryAfterSec}s.` }
  const perReceipt = await consumeRateLimit(`extract:rcpt:${f.id}`, RATE_LIMITS.extractReceipt.limit, RATE_LIMITS.extractReceipt.windowMs)
  if (!perReceipt.ok) return { ok: false, error: `This receipt was re-read too many times — try again in ${perReceipt.retryAfterSec}s.` }
  const claim = await claimRetryExtraction(f.id)
  if (!claim.ok) return { ok: false, error: claim.error }
  const { row, token } = claim
  try {
    // Read the ORIGINAL bytes from PRIVATE storage server-side (never a public URL).
    const { getPrivateBlob } = await import('@/platform/blob')
    const blob = await getPrivateBlob(row.storageRef!)
    if (!blob) { await releaseRetryClaim(f.id, token); return { ok: false, error: 'Could not load the stored image.' } }
    const { extractExpense } = await import('./ai')
    const ai = await extractExpense(blob.bytes.toString('base64'), row.contentType || 'image/jpeg')
    const e = ai.extraction
    const r = await applyRetryExtraction(f.id, token, {
      aiStatus: ai.status, aiModel: ai.model, aiRaw: ai.raw, aiExtracted: e, confidence: e.present,
      vendor: e.vendor, receiptDate: e.date, subtotalCents: e.subtotalCents, taxCents: e.taxCents,
      totalCents: e.totalCents, category: e.categoryKey, paymentMethod: e.paymentMethod, paymentLast4: e.paymentLast4,
      shippingCents: e.shippingCents, invoiceNumber: e.receiptNumber, orderNumber: e.orderNumber, description: e.description,
    }, actor.name)
    if (r.ok) revalidate()
    return r.ok ? r : { ok: false, error: r.error ?? 'Could not update — refresh and try again.' }
  } catch (err) {
    await releaseRetryClaim(f.id, token).catch(() => {})
    logger.error('expenses:retry', 'failed', { code: errorCode(err) })
    return { ok: false, error: 'Could not re-read the image — enter the details manually.' }
  }
}

// ── "Check the reading" — re-read a stored receipt and COMPARE, saving nothing ─────────────────────────
export interface ReadingCheck {
  ok: boolean; error?: string
  aiStatus?: 'extracted' | 'failed'; model?: string | null
  read?: Record<string, string | number | null>      // what the reader sees in the stored document right now
  saved?: Record<string, string | number | null>     // what is saved on the receipt
  differences?: string[]                             // fields where the reading disagrees with what is saved
  paymentSourceRead?: string | null                  // an approved source ONLY when a printed card ending identifies it
}
/**
 * Manager-only diagnostic: run the reader on the receipt's stored original (photo, PDF or pasted text) and
 * return what it sees next to what is saved. It WRITES NOTHING to the receipt — no status change, no field
 * change, no audit entry, no new expense — so it is safe on a filed receipt. Rate-limited like a retry.
 */
export async function checkReadingAction(f: { id: string }): Promise<ReadingCheck> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  const row = f.id ? await getReceipt(f.id) : null
  if (!row) return { ok: false, error: 'Receipt not found.' }
  if (row.storage !== 'blob_private' || !row.storageRef) return { ok: false, error: 'This receipt has no stored document to read.' }
  const perActor = await consumeRateLimit(`extract:actor:${actor.key}`, RATE_LIMITS.extractActor.limit, RATE_LIMITS.extractActor.windowMs)
  if (!perActor.ok) return { ok: false, error: `Too many reads — try again in ${perActor.retryAfterSec}s.` }
  try {
    const { getPrivateBlob } = await import('@/platform/blob')
    const blob = await getPrivateBlob(row.storageRef)
    if (!blob) return { ok: false, error: 'Could not load the stored document.' }
    const type = row.contentType || 'image/jpeg'
    const { isImageType } = await import('./upload-validation')
    const { derivedForExtraction } = await import('./image-decode')
    const input = isImageType(type) ? await derivedForExtraction(blob.bytes) : { bytes: blob.bytes, contentType: type }
    const { extractExpense } = await import('./ai')
    const ai = await extractExpense(input.bytes.toString('base64'), input.contentType)
    const e = ai.extraction
    const { matchPaymentSource } = await import('./payment')
    const read = {
      vendor: e.vendor, date: e.date, subtotalCents: e.subtotalCents, taxCents: e.taxCents, shippingCents: e.shippingCents, totalCents: e.totalCents,
      invoiceNumber: e.receiptNumber, orderNumber: e.orderNumber, description: e.description, paymentMethod: e.paymentMethod, cardLast4: e.paymentLast4,
    }
    const saved = {
      vendor: row.vendor, date: row.receiptDate, subtotalCents: row.subtotalCents, taxCents: row.taxCents, shippingCents: row.shippingCents, totalCents: row.totalCents,
      invoiceNumber: row.invoiceNumber, orderNumber: row.orderNumber, description: row.description, paymentMethod: row.paymentMethod, cardLast4: row.paymentLast4,
    }
    const differences = (Object.keys(read) as (keyof typeof read)[]).filter((k) => k !== 'description' && read[k] != null && saved[k] != null && String(read[k]).toLowerCase() !== String(saved[k]).toLowerCase())
    return {
      ok: true, aiStatus: ai.status, model: ai.model, read, saved, differences,
      paymentSourceRead: matchPaymentSource({ method: e.paymentMethod, brand: e.cardBrand, cardLast4: e.paymentLast4, accountEnding: e.accountEnding }),
    }
  } catch (err) {
    logger.error('expenses:check-reading', 'failed', { code: errorCode(err) })
    return { ok: false, error: 'Could not read the stored document.' }
  }
}
