/**
 * The quick-sticker REQUEST LIFECYCLE — pure, framework-free, and unit-tested, because this is the
 * logic that decides whether a tap prints a second physical sticker.
 *
 * The rules it enforces (learned the hard way; see oil-sticker-quick-state.test.ts):
 *   1. A request is RECORDED BEFORE it is dispatched, with `job: null` and state 'pending'. If the
 *      page reloads or the dialog closes mid-flight, what comes back is "there is a request whose
 *      outcome I do not know" — never a stale earlier success wearing a newer token's name.
 *   2. The submitted values are stored RESOLVED and are then immutable for that request. Every
 *      retry re-sends exactly what was shown and sent the first time, even across midnight.
 *   3. A new token may be minted ONLY from a resolved request (the server told us a terminal
 *      outcome) or from no request at all. Everything else must be resolved against the server
 *      first — with the SAME token.
 *   4. A 404 from the status route does NOT prove nothing printed (the original POST may still be
 *      committing). The only safe retry is the SAME token, which the server answers idempotently.
 *
 * It stores no state itself and performs no I/O: the component hands it a record and gets the next
 * record or the next legal action back.
 */

/** Mirrors StickerJobView in ./OilStickerForm — restated here so this module stays import-free. */
export interface QuickJobView { jobId: string; status: string; error: string | null; uncertain: boolean; createdAt: string }

/** sessionStorage key. Bumped from v1: v1 records lacked the dispatch state and were unsafe. */
export const QUICK_STORE_KEY = 'ps.oil-sticker.quick.v2'

/** Exactly what was sent — fully resolved, so a retry can never recompute a different sticker. */
export interface QuickSubmittedValues {
  mileage: number
  intervalMiles: number | null
  intervalMonths: number | null
  nextMileage: number
  nextDate: string
}

/**
 * pending  — recorded and dispatched; no answer yet in THIS session.
 * unknown  — the answer was lost (network error, 5xx, reload, reopened dialog). Must be checked.
 * unsent   — the server reports no job for this token. A retry with the SAME token is safe.
 * tracked  — the server gave us the job; `job` is its last known status.
 */
export type QuickRequestState = 'pending' | 'unknown' | 'unsent' | 'tracked'

export interface QuickRequestRecord {
  v: 2
  actorKey: string
  requestId: string
  state: QuickRequestState
  values: QuickSubmittedValues
  job: QuickJobView | null
  updatedAt: string
}

export const isWaitingStatus = (status: string | null | undefined) => status === 'queued' || status === 'claimed'

/** The server has given a final answer for this request — nothing more will print for it. */
export function isResolved(rec: QuickRequestRecord | null): boolean {
  return !!rec && rec.state === 'tracked' && !!rec.job && !isWaitingStatus(rec.job.status)
}

/** A new token is legal only when there is nothing unresolved that it could duplicate. */
export function canMintNewRequest(rec: QuickRequestRecord | null): boolean {
  return !rec || isResolved(rec)
}

const stamp = (now: Date) => now.toISOString()

/** Record a request BEFORE dispatching it. */
export function beginRequest(actorKey: string, requestId: string, values: QuickSubmittedValues, now: Date = new Date()): QuickRequestRecord {
  return { v: 2, actorKey, requestId, state: 'pending', values, job: null, updatedAt: stamp(now) }
}

/** The server answered with a job — the values are never rewritten. */
export function withJob(rec: QuickRequestRecord, job: QuickJobView, now: Date = new Date()): QuickRequestRecord {
  return { ...rec, state: 'tracked', job, updatedAt: stamp(now) }
}

/** The dispatch outcome is unknown. Keeps the token; forbids minting another. */
export function markUnknown(rec: QuickRequestRecord, now: Date = new Date()): QuickRequestRecord {
  return { ...rec, state: 'unknown', updatedAt: stamp(now) }
}

/** The server knows no job for this token — re-sending the SAME token is the safe retry. */
export function markUnsent(rec: QuickRequestRecord, now: Date = new Date()): QuickRequestRecord {
  return { ...rec, state: 'unsent', job: null, updatedAt: stamp(now) }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v)

function isValues(v: unknown): v is QuickSubmittedValues {
  const o = v as QuickSubmittedValues
  return !!o && isNum(o.mileage) && isNum(o.nextMileage) && typeof o.nextDate === 'string'
    && isNumOrNull(o.intervalMiles) && isNumOrNull(o.intervalMonths)
}

function isJobView(v: unknown): v is QuickJobView {
  const o = v as QuickJobView
  return !!o && typeof o.jobId === 'string' && typeof o.status === 'string'
}

/**
 * Read a persisted record back. Returns null — leaving the stored value untouched — for anything
 * that is not THIS actor's own well-formed record, so a different person signing in on the same
 * device can never inherit an in-flight sticker. A 'pending' record is downgraded to 'unknown':
 * the response it was waiting for died with the page.
 */
export function restoreRecord(raw: unknown, actorKey: string): QuickRequestRecord | null {
  const parsed = typeof raw === 'string' ? safeParse(raw) : raw
  const rec = parsed as QuickRequestRecord
  if (!rec || rec.v !== 2 || typeof rec.requestId !== 'string' || !rec.requestId) return null
  if (typeof rec.actorKey !== 'string' || rec.actorKey !== actorKey) return null
  if (!isValues(rec.values)) return null
  if (rec.job != null && !isJobView(rec.job)) return null
  const state: QuickRequestState =
    rec.state === 'tracked' && rec.job ? 'tracked'
      : rec.state === 'unsent' ? 'unsent'
        : 'unknown' // 'pending' (and anything unrecognised) is an unknown outcome after a reload
  return { ...rec, state, job: state === 'tracked' ? rec.job : null }
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return null }
}

/** How a failed POST affects the token. */
export type PostFailureOutcome = 'unauthorized' | 'conflict' | 'not_dispatched' | 'unknown'

/**
 * Codes the server only raises BEFORE anything is written — the token is provably unspent.
 * `invalid_json` / `invalid_body` mean the request was never even read; the `bad_*` codes come
 * from validation, which runs before the insert. Anything not on this list is treated as unknown.
 */
const PRE_WRITE_CODES = new Set(['bad_mileage', 'bad_interval_miles', 'bad_interval_months', 'bad_next_mileage', 'bad_next_date', 'bad_request_id', 'invalid_body', 'invalid_json'])

/**
 * Only a refusal we know happened before the insert clears the token. Everything else — a 5xx, an
 * unreadable error, a dropped connection — is 'unknown' and must be checked, never re-minted.
 */
export function postFailureOutcome(status: number, code: string | null | undefined): PostFailureOutcome {
  if (status === 401) return 'unauthorized'
  if (status === 409) return 'conflict'
  if ((status === 400 || status === 422) && code && PRE_WRITE_CODES.has(code)) return 'not_dispatched'
  return 'unknown'
}

export interface QuickActionPlan {
  /** print = new token; resend = THIS token again; check = ask the server; wait = nothing to do. */
  kind: 'print' | 'resend' | 'check' | 'wait'
  /** The token a 'resend'/'check' must use. Null for 'print' (one is minted) and 'wait'. */
  requestId: string | null
  label: string
  disabled: boolean
  /** "Start a new sticker" may only clear a RESOLVED request. */
  canStartNew: boolean
  /** The submitted values must not drift while a request is unresolved. */
  fieldsLocked: boolean
}

/**
 * THE one place that decides what the primary button does. Derived from the persisted record —
 * never from a loose job id — so the button can never offer a fresh print while an earlier request
 * is unresolved.
 */
export function planQuickAction(args: {
  record: QuickRequestRecord | null
  canPrint: boolean
  busy: boolean
  booting: boolean
}): QuickActionPlan {
  const { record, canPrint, busy, booting } = args
  if (booting) return { kind: 'wait', requestId: null, label: 'Loading…', disabled: true, canStartNew: false, fieldsLocked: true }

  if (!record) {
    return { kind: 'print', requestId: null, label: 'Print Oil Change Sticker', disabled: busy || !canPrint, canStartNew: false, fieldsLocked: busy }
  }
  if (record.state === 'pending' || record.state === 'unknown') {
    return { kind: 'check', requestId: record.requestId, label: 'Check printer status', disabled: busy, canStartNew: false, fieldsLocked: true }
  }
  if (record.state === 'unsent') {
    return { kind: 'resend', requestId: record.requestId, label: 'Send this sticker again', disabled: busy, canStartNew: false, fieldsLocked: true }
  }
  if (isWaitingStatus(record.job?.status)) {
    return { kind: 'wait', requestId: record.requestId, label: 'Sticker on its way…', disabled: true, canStartNew: false, fieldsLocked: true }
  }
  // Resolved: a further copy is a NEW request, which is why it needs a deliberate tap.
  return {
    kind: 'print', requestId: null,
    label: record.job?.status === 'submitted' ? 'Print another copy' : 'Send again',
    disabled: busy || !canPrint, canStartNew: true, fieldsLocked: busy,
  }
}
