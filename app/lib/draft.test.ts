import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  draftKey, saveDraft, loadDraft, loadDraftEntry, clearDraft,
  purgeExpiredDrafts, draftAgeLabel, DRAFT_TTL_MS,
} from './draft'

/** Minimal in-memory Storage, including the `length`/`key()` pair that purging enumerates with. */
function fakeStorage() {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
  }
}

let local: ReturnType<typeof fakeStorage>
let session: ReturnType<typeof fakeStorage>

beforeEach(() => {
  local = fakeStorage()
  session = fakeStorage()
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('sessionStorage', session)
})

describe('draftKey', () => {
  it('isolates by user and record', () => {
    expect(draftKey('check', 'u1', 'r1')).toBe('psd:check:u1:r1')
    expect(draftKey('check', 'u1', 'r1')).not.toBe(draftKey('check', 'u2', 'r1')) // different user
    expect(draftKey('check', 'u1', 'r1')).not.toBe(draftKey('check', 'u1', 'r2')) // different record
  })
  it('falls back to anon / new for missing ids', () => {
    expect(draftKey('intake')).toBe('psd:intake:anon:new')
    expect(draftKey('intake', '  ', null)).toBe('psd:intake:anon:new')
  })
})

describe('save / load / clear', () => {
  it('round-trips a draft object', () => {
    const key = draftKey('intake', 'u1', 'new')
    expect(loadDraft(key)).toBeNull()
    saveDraft(key, { name: 'Jo', lines: [{ p: 1200 }] })
    expect(loadDraft<{ name: string }>(key)).toEqual({ name: 'Jo', lines: [{ p: 1200 }] })
  })

  it('writes to localStorage, NOT sessionStorage', () => {
    const key = draftKey('intake', 'u1', 'new')
    saveDraft(key, { a: 1 })
    expect(local.store.has(key)).toBe(true)
    expect(session.store.has(key)).toBe(false)
  })

  // The 2026-11-02 incident: closing the home-screen web app wiped a sessionStorage draft and a
  // real customer's name/phone/VIN were lost for good. A draft must outlive the app session.
  it('survives the app session ending (regression: lost Cadillac intake)', () => {
    const key = draftKey('intake:quick-entry', 'darryl', 'new')
    saveDraft(key, { cust: { first: 'Jo', phone: '9795550123' }, veh: { vin: '1GYKPCRS3LZ235299' } })

    session.store.clear() // the web-app instance is force-quit / evicted by iOS

    expect(loadDraft<{ veh: { vin: string } }>(key)?.veh.vin).toBe('1GYKPCRS3LZ235299')
  })

  it('clears a draft from both stores', () => {
    const key = draftKey('intake', 'u1', 'new')
    saveDraft(key, { a: 1 })
    session.setItem(key, JSON.stringify({ v: 1, at: Date.now(), data: { a: 2 } }))
    clearDraft(key)
    expect(loadDraft(key)).toBeNull()
    expect(local.store.has(key)).toBe(false)
    expect(session.store.has(key)).toBe(false)
  })

  it('returns null for corrupt, version-mismatched, or untimestamped data', () => {
    const key = draftKey('intake', 'u1', 'new')
    local.setItem(key, 'not json')
    expect(loadDraft(key)).toBeNull()
    local.setItem(key, JSON.stringify({ v: 2, at: Date.now(), data: { a: 1 } }))
    expect(loadDraft(key)).toBeNull()
    local.setItem(key, JSON.stringify({ v: 1, data: { a: 1 } })) // no `at`
    expect(loadDraft(key)).toBeNull()
  })

  it('never throws when storage is unavailable', () => {
    const boom = () => { throw new Error('blocked') }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, length: 0, key: boom })
    const key = draftKey('intake', 'u1', 'new')
    expect(() => saveDraft(key, { a: 1 })).not.toThrow()
    expect(loadDraft(key)).toBeNull()
    expect(() => clearDraft(key)).not.toThrow()
  })
})

describe('expiry', () => {
  const key = draftKey('intake', 'u1', 'new')

  it('restores a draft just inside the TTL', () => {
    const at = Date.now() - (DRAFT_TTL_MS - 60_000)
    local.setItem(key, JSON.stringify({ v: 1, at, data: { a: 1 } }))
    expect(loadDraft(key)).toEqual({ a: 1 })
  })

  it('refuses and deletes a draft past the TTL', () => {
    const at = Date.now() - (DRAFT_TTL_MS + 60_000)
    local.setItem(key, JSON.stringify({ v: 1, at, data: { a: 1 } }))
    expect(loadDraft(key)).toBeNull()
    expect(local.store.has(key)).toBe(false) // swept, so stale PII doesn't linger on a shop phone
  })

  it('purges only expired/unreadable psd: keys, leaving fresh drafts and other app data', () => {
    const fresh = draftKey('intake', 'u1', 'new')
    const stale = draftKey('check', 'u2', 'new')
    const junk = draftKey('sale', 'u3', 'v1')
    saveDraft(fresh, { a: 1 })
    local.setItem(stale, JSON.stringify({ v: 1, at: Date.now() - (DRAFT_TTL_MS + 1), data: { a: 1 } }))
    local.setItem(junk, 'not json')
    local.setItem('ps_other_feature', 'keep me')

    purgeExpiredDrafts()

    expect(local.store.has(fresh)).toBe(true)
    expect(local.store.has(stale)).toBe(false)
    expect(local.store.has(junk)).toBe(false)
    expect(local.store.get('ps_other_feature')).toBe('keep me')
  })
})

describe('loadDraftEntry', () => {
  it('reports when the draft was last saved', () => {
    const key = draftKey('intake', 'u1', 'new')
    const at = Date.now() - 3 * 60 * 60 * 1000
    local.setItem(key, JSON.stringify({ v: 1, at, data: { a: 1 } }))
    const entry = loadDraftEntry<{ a: number }>(key)
    expect(entry).toEqual({ data: { a: 1 }, at })
  })

  it('adopts a pre-localStorage sessionStorage draft once, then owns it', () => {
    const key = draftKey('intake', 'u1', 'new')
    const at = Date.now() - 1000
    session.setItem(key, JSON.stringify({ v: 1, at, data: { legacy: true } }))

    expect(loadDraft<{ legacy: boolean }>(key)).toEqual({ legacy: true })
    expect(local.store.has(key)).toBe(true)   // migrated
    expect(session.store.has(key)).toBe(false) // and not left behind to be re-adopted
  })

  it('does not adopt an expired sessionStorage draft', () => {
    const key = draftKey('intake', 'u1', 'new')
    session.setItem(key, JSON.stringify({ v: 1, at: Date.now() - (DRAFT_TTL_MS + 1), data: { old: true } }))
    expect(loadDraft(key)).toBeNull()
  })
})

describe('draftAgeLabel', () => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  it('stays silent for a just-now reload', () => {
    expect(draftAgeLabel(now - 5_000, now)).toBe('')
    expect(draftAgeLabel(now - 59_000, now)).toBe('')
  })
  it('reads naturally in minutes, hours, and days', () => {
    expect(draftAgeLabel(now - 60_000, now)).toBe('1 minute ago')
    expect(draftAgeLabel(now - 25 * 60_000, now)).toBe('25 minutes ago')
    expect(draftAgeLabel(now - 60 * 60_000, now)).toBe('1 hour ago')
    expect(draftAgeLabel(now - 5 * 60 * 60_000, now)).toBe('5 hours ago')
    expect(draftAgeLabel(now - 24 * 60 * 60_000, now)).toBe('1 day ago')
    expect(draftAgeLabel(now - 3 * 24 * 60 * 60_000, now)).toBe('3 days ago')
  })
  it('tolerates a nonsense timestamp', () => {
    expect(draftAgeLabel(Number.NaN, now)).toBe('')
  })
})
