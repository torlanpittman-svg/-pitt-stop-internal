/**
 * Form-draft persistence (localStorage, TTL-bounded). Lets a long, multi-field form survive a
 * reload, a backgrounded phone, an accidental nav, a force-quit, or a reboot — without ever
 * submitting anything.
 *
 * Rules (by design):
 *  - **Drafts only.** These helpers read/write local storage; they NEVER submit, post a financial
 *    event, or call QuickBooks. Only the user's explicit action submits.
 *  - **Isolated by user AND record.** The key includes the signed-in user id and the record id, so a
 *    shared shop phone never restores one person's draft into another's session (or across records).
 *  - **Cleared on success.** Callers clear the draft once the real submit succeeds.
 *  - **Expires.** A draft older than DRAFT_TTL_MS is never restored and is swept from storage, so a
 *    stale half-entry can't be mistaken for today's customer and PII doesn't linger on a shop phone.
 *
 * **localStorage, not sessionStorage** — deliberate, and a reversal of the original choice. On
 * 2026-11-02 a retail Quick Entry (customer + phone + VIN of a 2020 Cadillac XT6) was lost for good:
 * sessionStorage is scoped to the tab/web-app instance, so closing the home-screen app wiped the
 * draft, and nothing reaches the server before the final submit — the only server-side trace was the
 * VIN in the decode log. localStorage survives app close and reboot, which is exactly the failure
 * that cost a real customer. The TTL + the caller's "Start fresh" control bound the downside.
 *
 * NOTE: a draft still lives only on the device that typed it. Recovering one from another device
 * would need server-side drafts (a deliberate, separate change — it would put customer PII in the
 * database before anyone pressed save).
 */

const PREFIX = 'psd'

/** A draft older than this is never restored, and is purged on the next load. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

type Wrapped = { v: 1; at: number; data: unknown }

/** A restored draft plus when it was last touched, so callers can show its age. */
export interface DraftEntry<T> {
  data: T
  /** epoch ms of the last save. */
  at: number
}

/** Durable store. Accessing it can throw (private mode / blocked storage), so it's always guarded. */
function durable(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Some builds kept drafts here; read once so a deploy never drops someone's work. */
function legacy(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function get(s: Storage | null, key: string): string | null {
  try {
    return s ? s.getItem(key) : null
  } catch {
    return null
  }
}

function set(s: Storage | null, key: string, value: string): void {
  try {
    s?.setItem(key, value)
  } catch {
    /* quota / blocked — drafting is best-effort */
  }
}

function remove(s: Storage | null, key: string): void {
  try {
    s?.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Build a namespaced, user+record-isolated draft key. */
export function draftKey(scope: string, user?: string | null, record?: string | null): string {
  const safe = (s: string | null | undefined) => (s && String(s).trim()) || null
  return [PREFIX, scope, safe(user) ?? 'anon', safe(record) ?? 'new'].join(':')
}

function parse(raw: string | null): Wrapped | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Wrapped
    if (!p || p.v !== 1 || p.data == null || typeof p.at !== 'number') return null
    return p
  } catch {
    return null
  }
}

export function saveDraft(key: string, data: unknown): void {
  const wrapped: Wrapped = { v: 1, at: Date.now(), data }
  set(durable(), key, JSON.stringify(wrapped))
}

/**
 * Drop every `psd:` draft that is expired or unreadable. Called on each load so storage self-heals
 * without a cron or an explicit user action. Only touches this module's own prefix.
 */
export function purgeExpiredDrafts(now: number = Date.now()): void {
  const s = durable()
  if (!s) return
  try {
    const stale: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (!k || !k.startsWith(`${PREFIX}:`)) continue
      const w = parse(get(s, k))
      if (!w || now - w.at > DRAFT_TTL_MS) stale.push(k)
    }
    for (const k of stale) remove(s, k)
  } catch {
    /* enumeration unavailable — nothing to purge */
  }
}

/** Load a draft with its age, or null when absent / expired / unreadable. */
export function loadDraftEntry<T>(key: string, now: number = Date.now()): DraftEntry<T> | null {
  purgeExpiredDrafts(now)

  const s = durable()
  let w = parse(get(s, key))

  // Adopt a draft left behind by any build that used sessionStorage, so shipping loses nothing.
  if (!w) {
    const ls = legacy()
    const adopted = parse(get(ls, key))
    if (adopted) {
      w = adopted
      set(s, key, JSON.stringify(adopted))
      remove(ls, key)
    }
  }

  if (!w) return null
  if (now - w.at > DRAFT_TTL_MS) {
    clearDraft(key)
    return null
  }
  return { data: w.data as T, at: w.at }
}

export function loadDraft<T>(key: string, now: number = Date.now()): T | null {
  return loadDraftEntry<T>(key, now)?.data ?? null
}

export function clearDraft(key: string): void {
  remove(durable(), key)
  remove(legacy(), key) // also drop any pre-localStorage copy so it can't be re-adopted
}

/**
 * Human age of a draft for the restore banner — so nobody mistakes a days-old half-entry for the
 * customer standing in front of them. Returns '' for anything under a minute (just-now reloads).
 */
export function draftAgeLabel(at: number, now: number = Date.now()): string {
  const ms = now - at
  if (!Number.isFinite(ms) || ms < 60_000) return ''
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
