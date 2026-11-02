/**
 * The server half of "Enable notifications on this device", factored out of the component so the
 * rules that actually matter can be tested without a browser.
 *
 * TWO RULES, and they are the whole reason this file exists:
 *  1. A device is reported ON only after the SERVER has confirmed the enrolment — HTTP ok *and*
 *     `ok: true` in the body. A 403 (signed in as somebody who may not enrol), a 503 (no VAPID keys
 *     yet), a 500 or a dropped connection must leave the switch off with a readable reason. A green
 *     "Notifications are ON" over a device the server never recorded is the worst possible outcome:
 *     nobody checks a notification that silently never comes.
 *  2. No wait is unbounded. `fetch`, `serviceWorker.ready` and `getSubscription()` can all hang
 *     indefinitely on a phone with a half-open connection, and an un-timed await is what leaves the
 *     screen stuck on "Checking this device…" forever.
 */

export interface PushDevice { id: string; label: string | null; enrolledAt: string; lastSuccessAt: string | null }
export interface PushServerStatus { configured: boolean; publicKey: string | null; devices: PushDevice[] }
export interface SubscriptionFields { endpoint: string; p256dh: string; auth: string }

export const PUSH_API = '/api/appointments/push'
/** Long enough for a slow shop connection, short enough that the screen always resolves. */
export const WAIT_MS = 12_000

export class TimeoutError extends Error {
  constructor(what: string) { super(`Timed out waiting for ${what}.`); this.name = 'TimeoutError' }
}

/** Why an enrolment did not succeed — the component maps this onto what it shows. */
export type EnrollFailure = 'denied' | 'not_configured' | 'not_refreshable' | 'rejected' | 'server' | 'network' | 'timeout'
export type EnrollOutcome = { ok: true } | { ok: false; reason: EnrollFailure; error: string }

export interface Io {
  fetchImpl?: typeof fetch
  /** Per-step bound; tests pass something small instead of waiting. */
  timeoutMs?: number
}

/**
 * Reject rather than hang. The underlying work is not cancelled (we cannot cancel a service-worker
 * promise), it is simply no longer waited on — the caller reports an error instead of nothing.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(what)), ms)
    const done = () => clearTimeout(timer)
    work.then((value) => { done(); resolve(value) }, (err) => { done(); reject(err) })
  })
}

/** The message for a response we could read nothing useful out of. */
export function enrollErrorForStatus(status: number): { reason: EnrollFailure; error: string } {
  if (status === 401 || status === 403) {
    return { reason: 'denied', error: 'This sign-in cannot turn booking alerts on. Sign in with a manager PIN, then tap Enable again.' }
  }
  if (status === 503) {
    return { reason: 'not_configured', error: 'Notifications are not set up on the server yet, so this device could not be registered.' }
  }
  if (status === 409) {
    // Refresh-only answer: this device is not an active enrolment of this person's, so nothing was
    // changed. A normal state (somebody turned it off, or it is a colleague's device), not an error.
    return { reason: 'not_refreshable', error: 'Notifications are off for this device. Tap Enable to turn them on.' }
  }
  if (status === 400 || status === 422) {
    return { reason: 'rejected', error: 'The server would not accept this device’s notification address. Turn notifications off and on again.' }
  }
  return { reason: 'server', error: `The server could not register this device (error ${status}). Try again in a moment.` }
}

async function readJson(res: Response, timeoutMs: number): Promise<{ ok?: boolean; error?: string } | null> {
  try { return await withTimeout(res.json(), timeoutMs, 'the server') as { ok?: boolean; error?: string } }
  catch { return null }
}

/**
 * Ask the server what it knows: whether push is configured, the public VAPID key, this person's
 * devices. Returns null when the answer cannot be TRUSTED (not signed in as a manager, an error, or
 * unreadable JSON) — the caller must not treat null as "nothing enrolled", only as "unknown".
 */
export async function fetchPushStatus(io: Io = {}): Promise<PushServerStatus | null> {
  const ms = io.timeoutMs ?? WAIT_MS
  try {
    const res = await withTimeout((io.fetchImpl ?? fetch)(PUSH_API, { cache: 'no-store' }), ms, 'the server')
    if (!res.ok) return null
    const data = await withTimeout(res.json(), ms, 'the server') as Partial<PushServerStatus> | null
    if (!data || typeof data.configured !== 'boolean') return null
    return {
      configured: data.configured,
      publicKey: data.publicKey ?? null,
      devices: Array.isArray(data.devices) ? data.devices : [],
    }
  } catch { return null }
}

/**
 * Register this device with the server and WAIT for the answer. "ON" is only ever truthful if this
 * resolves `{ ok: true }`.
 *
 * `mode` is the difference between the two callers, and it matters:
 *  • 'enroll' — somebody tapped Enable. May create, re-enable or take over this device.
 *  • 'refresh' — the screen re-registering on load, with nobody asking. The server refuses unless
 *    this is already an active enrolment of this person's, so merely opening the screen can never
 *    undo an opt-out or quietly move a colleague's device to the current signed-in person.
 */
async function postSubscription(
  mode: 'enroll' | 'refresh',
  sub: SubscriptionFields & { label?: string },
  io: Io,
): Promise<EnrollOutcome> {
  const ms = io.timeoutMs ?? WAIT_MS
  let res: Response
  try {
    res = await withTimeout((io.fetchImpl ?? fetch)(PUSH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, label: sub.label, mode }),
    }), ms, 'the server')
  } catch (err) {
    return err instanceof TimeoutError
      ? { ok: false, reason: 'timeout', error: 'The server did not answer. Check the connection, then tap Enable again.' }
      : { ok: false, reason: 'network', error: 'Could not reach the server. Check the connection, then tap Enable again.' }
  }
  const data = await readJson(res, ms)
  if (res.ok && data?.ok === true) return { ok: true }
  const fallback = enrollErrorForStatus(res.status)
  // Prefer the server's own wording when it gave one — it is written for the person reading it.
  return { ok: false, reason: fallback.reason, error: data?.error ?? fallback.error }
}

/** Explicit Enable: may create, re-enable or take over this device. */
export const enrollDevice = (sub: SubscriptionFields & { label?: string }, io: Io = {}): Promise<EnrollOutcome> =>
  postSubscription('enroll', sub, io)

/** Automatic on-load refresh: strictly keeps an existing active enrolment current, or fails. */
export const refreshDevice = (sub: SubscriptionFields & { label?: string }, io: Io = {}): Promise<EnrollOutcome> =>
  postSubscription('refresh', sub, io)

/**
 * Ask the server to stop notifying this device. Reports whether it actually agreed; it never throws,
 * because signing out must not be blocked by the network (see app/components/IdentityBar.tsx, which
 * is deliberately best-effort and unchanged).
 */
export async function releaseDevice(endpoint: string, reason: 'signed_out' | 'disabled_by_staff', io: Io = {}): Promise<boolean> {
  try {
    const res = await withTimeout((io.fetchImpl ?? fetch)(PUSH_API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, reason }),
    }), io.timeoutMs ?? WAIT_MS, 'the server')
    return res.ok
  } catch { return false }
}

export interface StopOutcome {
  /** True only when something verifiably stopped the alerts. */
  stopped: boolean
  serverReleased: boolean
  locallyUnsubscribed: boolean
  /** Set when `stopped` is false, or when only one half succeeded. */
  error?: string
}

/**
 * Turn this device off, and report honestly whether it worked.
 *
 * Two independent halves stop the alerts, and EITHER is enough:
 *  • the server disabling the row (that endpoint is never sent to again);
 *  • the browser dropping the subscription (the endpoint stops existing, and the next push comes
 *    back 404/410, which disables the row at the next dispatch).
 * If BOTH fail, the phone is still enrolled and still reachable — showing "off" there would be the
 * same lie as showing "ON" for a device the server never recorded, so the caller must not.
 */
export async function stopDevice(
  device: { endpoint: string; unsubscribe: () => Promise<boolean> },
  io: Io = {},
): Promise<StopOutcome> {
  const serverReleased = await releaseDevice(device.endpoint, 'disabled_by_staff', io)
  let locallyUnsubscribed = false
  try {
    // Bounded like every other wait here: unsubscribe() talks to the browser's push service.
    locallyUnsubscribed = await withTimeout(device.unsubscribe(), io.timeoutMs ?? WAIT_MS, 'the browser') === true
  } catch { locallyUnsubscribed = false }

  if (!serverReleased && !locallyUnsubscribed) {
    return {
      stopped: false, serverReleased, locallyUnsubscribed,
      error: 'This device could NOT be turned off — the server could not be reached and the browser kept the subscription, so alerts may still arrive. Check the connection and tap “Turn off on this device” again.',
    }
  }
  if (!serverReleased) {
    return {
      stopped: true, serverReleased, locallyUnsubscribed,
      error: 'Turned off on this device, but the server could not be told. It stops its side automatically at the next alert.',
    }
  }
  if (!locallyUnsubscribed) {
    return {
      stopped: true, serverReleased, locallyUnsubscribed,
      error: 'The server will no longer send to this device, but the browser kept its subscription. Nothing further will arrive.',
    }
  }
  return { stopped: true, serverReleased, locallyUnsubscribed }
}
