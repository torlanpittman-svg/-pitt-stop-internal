/**
 * Pure autosave-decision helpers for standalone-estimate recipients. No browser, no DB, no network — just
 * the logic that decides WHAT (if anything) to persist as the manager types. localStorage draft helpers are
 * exercised against a tiny in-memory stub to prove they key by estimate id and swallow storage errors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  recipientSaveTarget, normalizeBaseline, sameRecipientList, decideRecipientSave,
  readRecipientDraft, writeRecipientDraft, clearRecipientDraft,
} from './recipient-autosave'

describe('recipientSaveTarget', () => {
  it('drops blank rows and normalizes the rest (trim/lowercase/dedupe/sort)', () => {
    expect(recipientSaveTarget(['  B@x.com ', '', 'a@x.com', 'A@X.com'])).toEqual({ ok: true, list: ['a@x.com', 'b@x.com'] })
  })
  it('an all-blank editor is the explicit empty (cleared) set', () => {
    expect(recipientSaveTarget(['', '   '])).toEqual({ ok: true, list: [] })
  })
  it('a non-blank invalid entry fails closed — nothing is persisted', () => {
    expect(recipientSaveTarget(['a@x.com', 'not-an-email'])).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('normalizeBaseline / sameRecipientList', () => {
  it('normalizes a contact-email seed and invalid input collapses to empty', () => {
    expect(normalizeBaseline(['Owner@Shop.NET'])).toEqual(['owner@shop.net'])
    expect(normalizeBaseline(['garbage'])).toEqual([])
  })
  it('compares normalized lists element-for-element', () => {
    expect(sameRecipientList(['a@x.com', 'b@x.com'], ['a@x.com', 'b@x.com'])).toBe(true)
    expect(sameRecipientList(['a@x.com'], ['a@x.com', 'b@x.com'])).toBe(false)
  })
})

describe('decideRecipientSave', () => {
  it('idle when the normalized set already matches the saved baseline (order/case/blank-insensitive)', () => {
    expect(decideRecipientSave(['A@x.com', '', 'b@x.com'], ['a@x.com', 'b@x.com'])).toEqual({ kind: 'idle' })
  })
  it('saves the normalized set when it differs from the baseline', () => {
    expect(decideRecipientSave(['a@x.com', 'c@x.com'], ['a@x.com', 'b@x.com'])).toEqual({ kind: 'save', list: ['a@x.com', 'c@x.com'] })
  })
  it('saves the explicit empty set when the editor is cleared from a non-empty baseline', () => {
    expect(decideRecipientSave(['', ' '], ['a@x.com'])).toEqual({ kind: 'save', list: [] })
  })
  it('an empty editor matching an already-empty baseline is idle (no spurious write)', () => {
    expect(decideRecipientSave([''], [])).toEqual({ kind: 'idle' })
  })
  it('blocks (does not save) while an invalid address is present, even alongside valid ones', () => {
    expect(decideRecipientSave(['a@x.com', 'oops'], ['a@x.com'])).toEqual({ kind: 'blocked', reason: 'invalid' })
  })
})

describe('localStorage draft recovery', () => {
  const store = new Map<string, string>()
  const stub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  vi.stubGlobal('window', { localStorage: stub })
  afterEach(() => store.clear())

  it('round-trips a raw draft keyed by estimate id and never leaks across estimates', () => {
    writeRecipientDraft('est-1', ['a@x.com', ''])
    expect(readRecipientDraft('est-1')).toEqual(['a@x.com', ''])
    expect(readRecipientDraft('est-2')).toBeNull()   // a different estimate sees nothing
    clearRecipientDraft('est-1')
    expect(readRecipientDraft('est-1')).toBeNull()
  })

  it('returns null on malformed JSON or a non-string-array shape', () => {
    store.set('ps:estimate-recipients:v1:est-3', '{not json')
    expect(readRecipientDraft('est-3')).toBeNull()
    store.set('ps:estimate-recipients:v1:est-4', JSON.stringify([1, 2]))
    expect(readRecipientDraft('est-4')).toBeNull()
  })

  it('swallows storage errors (quota / disabled) without throwing', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('nope') } } })
    expect(() => writeRecipientDraft('x', ['a@x.com'])).not.toThrow()
    expect(readRecipientDraft('x')).toBeNull()
    expect(() => clearRecipientDraft('x')).not.toThrow()
  })
})
