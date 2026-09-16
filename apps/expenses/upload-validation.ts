/**
 * Business Receipts — upload validation (PURE, deterministic, unit-testable).
 *
 * Security posture:
 *   - Extension is NEVER used to decide type.
 *   - The authoritative content type comes from the MAGIC BYTES (detectImageMime), not the client's
 *     declared MIME. A declared/detected mismatch is rejected.
 *   - Only the formats our vision-extraction path can safely process are allowed: JPEG / PNG / WEBP.
 *     SVG, HTML, scripts and PDFs are rejected (they are never detected as a raster image).
 *   - A conservative size cap is enforced.
 */
import { detectImageMime } from '@/platform/image'

// Allowed receipt image types (what GPT-4o vision can process AND we can verify by signature).
export const EXPENSE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type ExpenseImageType = (typeof EXPENSE_IMAGE_TYPES)[number]

// Conservative cap for a phone photo (client compresses first; raw originals are well under this).
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024 // 12 MB
export const MAX_DECLARED_OVERHEAD = 512 * 1024  // slack for multipart headers when checking Content-Length

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

/** File extension for a detected/authoritative mime (for a stable storage key). */
export function extForMime(mime: ExpenseImageType): 'jpg' | 'png' | 'webp' {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'
}
