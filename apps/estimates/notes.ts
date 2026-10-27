/**
 * Customer-visible estimate NOTES — a pure, side-effect-free helper shared by the browser
 * (EstimateActions) and the server (quickbooks.ts / API). It MUST NOT import any server/DB module so it
 * can run in the client bundle (same rule as recipients.ts).
 *
 * These notes are shown to the customer and to any insurer the estimate is emailed to (e.g. an insurance
 * claim number). On a send they are appended, clearly labeled, to the existing vehicle CustomerMemo so
 * they appear on the QuickBooks estimate. They are NEVER a private/internal note and never touch pricing.
 */

/** Conservative bounds — the notes themselves and the whole composed memo (vehicle + notes). */
export const MAX_CUSTOMER_NOTES = 700
export const MAX_COMPOSED_MEMO = 1000
/** How the notes are introduced on the customer-facing memo. */
export const CUSTOMER_NOTES_LABEL = 'Notes:'

export type CustomerNotesErrorReason = 'too_long' | 'invalid'
export type CustomerNotesResult =
  | { ok: true; notes: string }
  | { ok: false; reason: CustomerNotesErrorReason }

// Control characters (other than the newline that normalization keeps) could smuggle formatting or extra
// header-like content into the customer-facing memo, so they are rejected. Built from escapes so the source
// stays plain ASCII: U+0000–0008, U+000B, U+000C, U+000E–001F.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]')

/**
 * Normalize typed notes into their canonical stored form: CR/CRLF → LF, trailing whitespace stripped per
 * line, and the whole thing trimmed — while preserving INTERNAL newlines (multiline notes survive).
 */
export function normalizeCustomerNotes(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim()
}

/**
 * Validate notes. Fails CLOSED: control characters are rejected, and anything over the bound is rejected —
 * never truncated. Returns the NORMALIZED notes on success so callers store exactly what was validated.
 */
export function validateCustomerNotes(raw: string | null | undefined): CustomerNotesResult {
  const notes = normalizeCustomerNotes(raw)
  if (CONTROL_CHARS.test(notes)) return { ok: false, reason: 'invalid' }
  if (notes.length > MAX_CUSTOMER_NOTES) return { ok: false, reason: 'too_long' }
  return { ok: true, notes }
}

/** A human message for a rejected notes value — shared so the UI and server read the same way. */
export function customerNotesErrorMessage(reason: CustomerNotesErrorReason): string {
  switch (reason) {
    case 'too_long': return `Notes are too long — keep them under ${MAX_CUSTOMER_NOTES} characters.`
    default: return 'Remove unusual characters from the notes before saving.'
  }
}

/**
 * Decide how a freshly-read server notes value reconciles with the editor's current draft — PURE so it can
 * be unit-tested without the browser. `baseline` is the saved value the draft is being edited against.
 *
 * - Server value UNCHANGED (=== baseline): a clean draft tracks it; a dirty draft is kept (so an own item/fee
 *   refresh never traps typed notes). Baseline stays the same value.
 * - Server value CHANGED but it's safe to adopt (the draft is clean, or already equals the new value): adopt
 *   it into both draft and baseline, no conflict.
 * - Server value CHANGED under a DIRTY draft: CONFLICT. Keep the draft AND the OLD baseline (so a later save
 *   can't silently overwrite the other session at the new revision); surface `conflict` for the UI to block
 *   the save and offer an explicit reload.
 *
 * `draft === undefined` means "leave the editor text as-is".
 */
export interface NotesReconcileResult { draft?: string; baseline: string; conflict: string | null }
export function reconcileNotes(params: { serverNotes: string; draft: string; baseline: string }): NotesReconcileResult {
  const { serverNotes, draft, baseline } = params
  const dirty = draft !== baseline
  if (serverNotes === baseline) return { draft: dirty ? undefined : serverNotes, baseline: serverNotes, conflict: null }
  if (!dirty || draft === serverNotes) return { draft: serverNotes, baseline: serverNotes, conflict: null }
  return { draft: undefined, baseline, conflict: serverNotes }
}

/**
 * Compose the customer-facing memo for a send: the EXACT original vehicle memo when there are no notes
 * (so a note-free estimate's body/hash is byte-for-byte unchanged), otherwise the vehicle memo followed by
 * the clearly-labeled notes. Throws (before any QuickBooks side effect) if the whole memo would exceed the
 * bound — it NEVER truncates. `notes` may still be re-normalized here so the helper is safe to call directly.
 */
export function composeEstimateMemo(vehicleMemo: string, notes: string | null | undefined): string {
  const clean = normalizeCustomerNotes(notes)
  if (!clean) return vehicleMemo
  const base = (vehicleMemo ?? '').trim()
  const notesBlock = `${CUSTOMER_NOTES_LABEL}\n${clean}`
  const memo = [base, notesBlock].filter(Boolean).join('\n\n')
  if (memo.length > MAX_COMPOSED_MEMO) {
    throw new Error(`These notes make the estimate memo too long (${memo.length}/${MAX_COMPOSED_MEMO} characters). Shorten the notes.`)
  }
  return memo
}
