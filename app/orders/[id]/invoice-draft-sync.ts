/**
 * Coordination helpers for the shared Invoice Draft / estimate totals, extracted so the stale-response
 * and busy-lock rules are unit-tested without a browser. The panels (InvoiceDraftPanel, EstimateActions)
 * wire these into React state; the logic itself is pure.
 *
 * Background: the totals panel used to be fully REMOUNTED (via a React `key`) after every confirmed item
 * edit, which threw away any in-flight request and any open confirmation. It now refetches IN PLACE, so
 * it must instead (a) ignore a stale async response that resolves after a newer one, (b) disable its
 * actions while a refresh or an editor save is running, and (c) invalidate an open send/sync confirmation
 * when the underlying items change.
 */

/**
 * A monotonic request sequencer. Every draft/summary read — the initial load, the in-place refresh after
 * an item edit, and a fee override's own response — takes a token from begin(); its result may be applied
 * ONLY while isCurrent(token) still holds. Because starting any newer read (or a newer fee override) bumps
 * the latest token, an older response that resolves out of order can never overwrite a newer fee draft.
 */
export function createDraftSequencer(): { begin: () => number; isCurrent: (token: number) => boolean } {
  let latest = 0
  return {
    begin: () => ++latest,
    isCurrent: (token: number) => token === latest,
  }
}

/**
 * The Invoice Draft's actions (fee Remove/Restore, Create / Sync / Send / Resend, tax exemption) must be
 * inert whenever the draft is being re-read in place, the item editor above is mid-save, or another
 * invoice action is already running — so no control can act on a stale or in-flight draft.
 */
export function invoiceActionsLocked(s: {
  refreshing?: boolean; editorBusy?: boolean; busy?: boolean
  creating?: boolean; sending?: boolean; syncing?: boolean; savingCust?: boolean
}): boolean {
  return !!(s.refreshing || s.editorBusy || s.busy || s.creating || s.sending || s.syncing || s.savingCust)
}

/**
 * The standalone estimate actions (Send / Move to Work Board / fee Remove/Restore) are inert while the
 * summary is being re-read, the editor above is saving, or an action is already running.
 */
export function estimateActionsLocked(s: { refreshing?: boolean; editorBusy?: boolean; busy?: boolean }): boolean {
  return !!(s.refreshing || s.editorBusy || s.busy)
}

/**
 * Interpret a totals read, FAILING CLOSED. The result is usable ONLY on a 2xx response carrying a real
 * draft; a non-2xx, a null/malformed body, or a missing draft yields `{ draft: null, error }` so the caller
 * never keeps an old total showing as current/actionable after a failed refresh. `ok` = response.ok;
 * `body` = the parsed JSON, or null when it could not be parsed.
 */
export function interpretDraftResponse<T extends { draft?: unknown; error?: unknown }>(
  ok: boolean, body: T | null, fallback = 'Could not load the invoice totals. Try again.',
): { draft: NonNullable<T['draft']> | null; error: string | null } {
  if (ok && body && body.draft != null) return { draft: body.draft as NonNullable<T['draft']>, error: null }
  const error = body && typeof body.error === 'string' && body.error.trim() ? body.error : fallback
  return { draft: null, error }
}

/**
 * An affirmative/confirmed action (Send, Choose customer, estimate Send/Move) may run only against a
 * current, loaded draft — never while it is still loading or refreshing, and never after a failed refresh
 * dropped it.
 */
export function draftActionReady(s: { draft: boolean; loading?: boolean; refreshing?: boolean }): boolean {
  return !!s.draft && !s.loading && !s.refreshing
}
