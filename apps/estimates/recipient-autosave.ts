/**
 * Pure helpers for AUTOSAVING standalone-estimate send recipients — shared by the browser
 * (EstimateActions). Like recipients.ts / notes.ts this MUST NOT import any server/DB module so it can run
 * in the client bundle; it only reuses the pure normalizeRecipients helper.
 *
 * The editor keeps RAW typed rows (including blanks the manager is still filling in). These helpers decide
 * what — if anything — to persist, comparing against the last-saved BASELINE so a mere refresh or a value
 * that already matches the server never triggers a write. A blank row never blocks saving the other valid
 * entries; an invalid (non-blank, non-email) row blocks the save entirely so a partial list is never
 * persisted silently.
 */
import { normalizeRecipients, type RecipientErrorReason } from './recipients'

/** How long after the last keystroke an autosave fires (blur / remove flush it sooner). */
export const RECIPIENT_SAVE_DEBOUNCE_MS = 800

/** localStorage schema version + per-estimate key, so a draft never leaks across estimates. */
const DRAFT_KEY_PREFIX = 'ps:estimate-recipients:v1:'

/**
 * The SET that would be persisted for a raw editor list: blanks dropped, the rest normalized. An all-blank
 * editor is the EXPLICIT empty set `[]` (cleared). A non-blank entry that isn't a valid address fails CLOSED
 * so nothing is persisted silently.
 */
export function recipientSaveTarget(raw: readonly string[]): { ok: true; list: string[] } | { ok: false; reason: RecipientErrorReason } {
  const nonBlank = raw.map((s) => (s ?? '').trim()).filter((s) => s.length > 0)
  if (nonBlank.length === 0) return { ok: true, list: [] }
  const norm = normalizeRecipients(nonBlank)
  if (!norm.ok) return { ok: false, reason: norm.reason }
  return { ok: true, list: norm.list }
}

/** Normalized SET used as the saved BASELINE (invalid input collapses to the empty set). */
export function normalizeBaseline(raw: readonly string[]): string[] {
  const t = recipientSaveTarget(raw)
  return t.ok ? t.list : []
}

/** Two already-normalized recipient lists are equal when identical element-for-element. */
export function sameRecipientList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export type RecipientSaveDecision =
  | { kind: 'idle' }                                   // matches the saved baseline — nothing to persist
  | { kind: 'save'; list: string[] }                   // persist this normalized set (may be [] = cleared)
  | { kind: 'blocked'; reason: RecipientErrorReason }  // an invalid/over-bound entry — hold off, surface it

/**
 * Decide whether the current editor should autosave, given the last-saved baseline. PURE so the debounce /
 * status logic can be unit-tested without the browser.
 */
export function decideRecipientSave(raw: readonly string[], baseline: readonly string[]): RecipientSaveDecision {
  const target = recipientSaveTarget(raw)
  if (!target.ok) return { kind: 'blocked', reason: target.reason }
  if (sameRecipientList(target.list, baseline)) return { kind: 'idle' }
  return { kind: 'save', list: target.list }
}

/**
 * Per-estimate localStorage draft recovery: preserves the RAW typed rows on THIS browser so a quick
 * back/reopen (even mid-debounce) doesn't lose an in-progress address. Keyed by estimate id so it never
 * restores across estimates; every call swallows storage errors (quota / disabled / server rendering) so a
 * failing store can never break the editor.
 */
export function readRecipientDraft(id: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY_PREFIX + id)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[]
    return null
  } catch { return null }
}

export function writeRecipientDraft(id: string, raw: readonly string[]): void {
  try { window.localStorage.setItem(DRAFT_KEY_PREFIX + id, JSON.stringify(raw)) } catch { /* ignore storage errors */ }
}

export function clearRecipientDraft(id: string): void {
  try { window.localStorage.removeItem(DRAFT_KEY_PREFIX + id) } catch { /* ignore storage errors */ }
}
