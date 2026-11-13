/**
 * Business Receipts — upload validation (PURE, deterministic, unit-testable).
 *
 * Security posture:
 *   - Extension is NEVER used to decide type.
 *   - The authoritative content type comes from the MAGIC BYTES (detectImageMime), not the client's
 *     declared MIME. A declared/detected mismatch is rejected.
 *   - validateReceiptUpload (shared with the parts screenshot import) allows ONLY the raster formats our
 *     vision path can process: JPEG / PNG / WEBP. SVG, HTML, scripts and PDFs are rejected there.
 *   - validateReceiptFile (business receipts only) additionally allows a PDF document (a vendor's emailed
 *     invoice), detected by its "%PDF-" signature, stored as-is and only ever served as application/pdf.
 *   - A conservative size cap is enforced.
 */
import { detectImageMime } from '@/platform/image'

// Allowed receipt image types (what GPT-4o vision can process AND we can verify by signature).
export const EXPENSE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type ExpenseImageType = (typeof EXPENSE_IMAGE_TYPES)[number]

// Conservative cap: the hosting platform (Vercel Functions) rejects request bodies over ~4.5 MB before
// our code runs, so a larger app limit would surface as an opaque platform 413. We cap at 4 MB (under the
// platform limit) so our own clear error applies; the client compresses to well under this before upload.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024  // 4 MB
export const MAX_DECLARED_OVERHEAD = 256 * 1024  // slack for multipart headers when checking Content-Length

// A vendor invoice PDF is accepted as original evidence alongside photos.
export const EXPENSE_PDF_TYPE = 'application/pdf' as const
export const EXPENSE_TEXT_TYPE = 'text/plain' as const
export type ExpenseFileType = ExpenseImageType | typeof EXPENSE_PDF_TYPE
/** Every content type a stored receipt may have (photo, PDF, or pasted email text). */
export type ExpenseStoredType = ExpenseFileType | typeof EXPENSE_TEXT_TYPE
export function isImageType(t: string | null | undefined): t is ExpenseImageType {
  return !!t && (EXPENSE_IMAGE_TYPES as readonly string[]).includes(t)
}
/** PDF magic bytes: the file must START with "%PDF-" (never trusted from the name or declared type). */
export function isPdfHead(head: Uint8Array): boolean {
  return head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d
}

// Pasted receipt text (e.g. an emailed order confirmation). Bounded; stored verbatim as the evidence.
export const MIN_PASTED_TEXT = 20
export const MAX_PASTED_TEXT = 20_000
export type TextValidation = { ok: true; text: string } | { ok: false; status: 400 | 413; error: string }
/** Validate pasted receipt text: trimmed, bounded, and free of control characters other than tab/newline. */
export function validatePastedText(raw: unknown): TextValidation {
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'Paste the receipt text first.' }
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
  if (text.length < MIN_PASTED_TEXT) return { ok: false, status: 400, error: 'That is too short to be a receipt — paste the whole email or order confirmation.' }
  if (text.length > MAX_PASTED_TEXT) return { ok: false, status: 413, error: 'That is too long — paste just the receipt part of the email.' }
  return { ok: true, text }
}

export type UploadValidation =
  | { ok: true; mime: ExpenseImageType }
  | { ok: false; status: 400 | 413 | 415; error: string }

/** Normalize a declared MIME to a comparable family (jpg→jpeg), lowercased. */
function normalizeDeclared(t: string | null | undefined): string {
  const s = (t ?? '').toLowerCase().split(';')[0].trim()
  return s === 'image/jpg' ? 'image/jpeg' : s
}

/**
 * Validate a receipt upload. `head` is the first bytes of the file (≥12 needed for WEBP detection); the
 * caller passes the full buffer's head. Size is the true byte length. Returns the AUTHORITATIVE mime
 * (from magic bytes) on success — callers should use this, not the client's declared type.
 */
export function validateReceiptUpload(declaredType: string | null | undefined, size: number, head: Uint8Array): UploadValidation {
  if (!Number.isFinite(size) || size <= 0) return { ok: false, status: 400, error: 'Empty file.' }
  if (size > MAX_UPLOAD_BYTES) return { ok: false, status: 413, error: 'Image too large' }
  const detected = detectImageMime(head)
  if (!detected) return { ok: false, status: 415, error: 'Unsupported or unsafe file — use a JPEG, PNG or WEBP photo.' }
  const declared = normalizeDeclared(declaredType)
  // If the client declared a type, it must match what the bytes actually are (reject spoofed content).
  if (declared && declared !== detected) return { ok: false, status: 415, error: 'File content does not match its type.' }
  return { ok: true, mime: detected }
}

export type ReceiptFileValidation =
  | { ok: true; mime: ExpenseFileType }
  | { ok: false; status: 400 | 413 | 415; error: string }
/**
 * Validate a BUSINESS RECEIPT upload: everything validateReceiptUpload accepts (a photo) PLUS a PDF document.
 * Kept separate so other callers of the photo validator (e.g. the parts screenshot import) stay image-only.
 * Same rules: type from magic bytes, declared/detected mismatch rejected, same size cap.
 */
export function validateReceiptFile(declaredType: string | null | undefined, size: number, head: Uint8Array): ReceiptFileValidation {
  if (!isPdfHead(head)) {
    const v = validateReceiptUpload(declaredType, size, head)
    if (v.ok || v.status !== 415 || detectImageMime(head)) return v
    return { ok: false, status: 415, error: 'Unsupported or unsafe file — use a photo (JPEG, PNG, WEBP) or a PDF.' }
  }
  if (!Number.isFinite(size) || size <= 0) return { ok: false, status: 400, error: 'Empty file.' }
  if (size > MAX_UPLOAD_BYTES) return { ok: false, status: 413, error: 'File too large — keep it under 4 MB.' }
  const declared = normalizeDeclared(declaredType)
  if (declared && declared !== EXPENSE_PDF_TYPE) return { ok: false, status: 415, error: 'File content does not match its type.' }
  return { ok: true, mime: EXPENSE_PDF_TYPE }
}

/** File extension for a detected/authoritative mime (for a stable storage key). */
export function extForMime(mime: ExpenseImageType): 'jpg' | 'png' | 'webp' {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'
}
/** Storage-key extension for ANY stored receipt type (photo, PDF, pasted text). */
export function extForStoredType(mime: ExpenseStoredType): 'jpg' | 'png' | 'webp' | 'pdf' | 'txt' {
  return mime === 'application/pdf' ? 'pdf' : mime === 'text/plain' ? 'txt' : extForMime(mime)
}
