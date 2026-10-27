/**
 * Standalone-estimate SEND recipients — a pure, side-effect-free helper shared by the browser
 * (EstimateActions) and the server (quickbooks.ts). It MUST NOT import any server/DB module so it
 * can run in the client bundle; the server does the extra placeholder check (isPlaceholderEmail).
 *
 * These recipients are an explicit PER-SEND choice (who this one email goes to), never stored as the
 * customer's contact and never used for customer identity resolution. A recipient SET is normalized to
 * a trimmed, case-insensitive-deduped, deterministically ORDERED list so the same set (in any order,
 * with duplicates) is one send identity: the same QuickBooks estimate hash and the same send request id.
 */
import { z } from 'zod'

/** App bounds (not QuickBooks limits): keep a send addressable and the joined header reasonable. */
export const MAX_RECIPIENTS = 10
export const MAX_JOINED_LENGTH = 1000

const emailSchema = z.email().max(254)

export type RecipientErrorReason = 'empty' | 'invalid' | 'too_many' | 'too_long'
export type RecipientResult =
  | { ok: true; list: string[]; joined: string }
  | { ok: false; reason: RecipientErrorReason }

/** Control characters / list separators that would smuggle extra headers or addresses into one entry. */
function hasHeaderInjection(value: string): boolean {
  return /[\r\n\t,;]/.test(value) || /%0a|%0d/i.test(value)
}

/**
 * Normalize a raw list of typed recipient strings into the canonical SET used for both the QuickBooks
 * BillEmail/sendTo and the send identity. Trims, drops blanks, rejects header-injection/whitespace and
 * non-email entries, lowercases, de-duplicates case-insensitively, sorts for a stable order, and enforces
 * the app bounds. Fails CLOSED: any invalid entry rejects the whole list before any side effect.
 */
export function normalizeRecipients(raw: readonly string[]): RecipientResult {
  const trimmed = raw.map((s) => (s ?? '').trim()).filter((s) => s.length > 0)
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  const seen = new Set<string>()
  const list: string[] = []
  for (const entry of trimmed) {
    if (hasHeaderInjection(entry) || /\s/.test(entry)) return { ok: false, reason: 'invalid' }
    if (!emailSchema.safeParse(entry).success) return { ok: false, reason: 'invalid' }
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    list.push(key)
  }
  list.sort()
  if (list.length > MAX_RECIPIENTS) return { ok: false, reason: 'too_many' }
  const joined = list.join(',')
  if (joined.length > MAX_JOINED_LENGTH) return { ok: false, reason: 'too_long' }
  return { ok: true, list, joined }
}

/** A human message for a rejected list — shared so the UI and server read the same way. */
export function recipientErrorMessage(reason: RecipientErrorReason): string {
  switch (reason) {
    case 'empty': return 'Add at least one recipient email address.'
    case 'too_many': return `Remove some recipients — up to ${MAX_RECIPIENTS} are allowed per send.`
    case 'too_long': return 'Too many recipient characters. Remove some addresses.'
    default: return 'Enter valid recipient email addresses.'
  }
}

/**
 * Canonicalize a comma-separated address string (e.g. QuickBooks' returned BillEmail.Address) into the
 * same sorted, lowercased, trimmed SET as normalizeRecipients — so verification before a send ignores
 * spacing, case, and order and compares the recipient SET, not its formatting.
 */
export function normalizeForCompare(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).sort()
}

/** Two recipient SETs are the same send identity when their canonical lists are identical. */
export function sameRecipientSet(a: string | null | undefined, b: readonly string[]): boolean {
  const left = normalizeForCompare(a)
  return left.length === b.length && left.every((v, i) => v === b[i])
}
