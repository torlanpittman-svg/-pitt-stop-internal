/**
 * Pure customer-notes helpers — no server/DB imports, run identically in the browser and on the server.
 * Covers normalization (multiline preserved), the conservative bounds (never truncated), control-char
 * rejection, and the memo composition that keeps a note-free memo byte-for-byte unchanged.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeCustomerNotes, validateCustomerNotes, composeEstimateMemo, customerNotesErrorMessage,
  reconcileNotes, MAX_CUSTOMER_NOTES, MAX_COMPOSED_MEMO, CUSTOMER_NOTES_LABEL,
} from './notes'

const BELL = String.fromCharCode(7)
const NUL = String.fromCharCode(0)

describe('normalizeCustomerNotes', () => {
  it('normalizes CR/CRLF to LF, strips trailing per-line and overall whitespace, keeps internal newlines', () => {
    expect(normalizeCustomerNotes('  Claim: A \r\nAdjuster: B  \r\n\n ')).toBe('Claim: A\nAdjuster: B')
    expect(normalizeCustomerNotes('Line1\rLine2')).toBe('Line1\nLine2')
  })
  it('treats null/undefined/blank as empty', () => {
    expect(normalizeCustomerNotes(null)).toBe('')
    expect(normalizeCustomerNotes(undefined)).toBe('')
    expect(normalizeCustomerNotes('   \n  ')).toBe('')
  })
})

describe('validateCustomerNotes', () => {
  it('accepts normalized multiline notes and returns them', () => {
    expect(validateCustomerNotes('Claim number: ABC-123\nAdjuster: Jane')).toEqual({ ok: true, notes: 'Claim number: ABC-123\nAdjuster: Jane' })
  })
  it('accepts empty notes (a clear)', () => {
    expect(validateCustomerNotes('')).toEqual({ ok: true, notes: '' })
  })
  it('rejects (never truncates) notes over the bound', () => {
    expect(validateCustomerNotes('x'.repeat(MAX_CUSTOMER_NOTES))).toEqual({ ok: true, notes: 'x'.repeat(MAX_CUSTOMER_NOTES) })
    expect(validateCustomerNotes('x'.repeat(MAX_CUSTOMER_NOTES + 1))).toEqual({ ok: false, reason: 'too_long' })
  })
  it('rejects control characters that could smuggle formatting into the memo, but allows newlines', () => {
    expect(validateCustomerNotes(`Claim${BELL}number`)).toEqual({ ok: false, reason: 'invalid' })
    expect(validateCustomerNotes(`a${NUL}b`)).toEqual({ ok: false, reason: 'invalid' })
    expect(validateCustomerNotes('a\nb')).toEqual({ ok: true, notes: 'a\nb' })
  })
})

describe('customerNotesErrorMessage', () => {
  it('maps each reason to a human message', () => {
    expect(customerNotesErrorMessage('too_long')).toMatch(new RegExp(String(MAX_CUSTOMER_NOTES)))
    expect(customerNotesErrorMessage('too_long')).toMatch(/too long/i)
    expect(customerNotesErrorMessage('invalid')).toMatch(/unusual characters/i)
  })
})

describe('composeEstimateMemo', () => {
  it('returns the EXACT original vehicle memo when there are no notes (unchanged, untrimmed)', () => {
    expect(composeEstimateMemo('2020 Honda Civic', '')).toBe('2020 Honda Civic')
    expect(composeEstimateMemo('2020 Honda Civic  ', null)).toBe('2020 Honda Civic  ')
    expect(composeEstimateMemo('2020 Honda Civic', '   \n ')).toBe('2020 Honda Civic')
  })
  it('appends clearly-labeled multiline notes after the vehicle memo', () => {
    expect(composeEstimateMemo('2020 Honda Civic', 'Claim number: ABC-123\nAdjuster: Jane'))
      .toBe(`2020 Honda Civic\n\n${CUSTOMER_NOTES_LABEL}\nClaim number: ABC-123\nAdjuster: Jane`)
  })
  it('throws (never truncates) if the whole composed memo would exceed the bound', () => {
    const base = 'v'.repeat(MAX_COMPOSED_MEMO)   // already at the limit before any notes
    expect(() => composeEstimateMemo(base, 'x')).toThrow(/too long/i)
  })
})

describe('reconcileNotes (draft vs freshly-read server value)', () => {
  it('seeds a fresh editor: empty baseline adopts the saved server value', () => {
    expect(reconcileNotes({ serverNotes: 'Claim: A', draft: '', baseline: '' }))
      .toEqual({ draft: 'Claim: A', baseline: 'Claim: A', conflict: null })
  })

  it('server UNCHANGED + clean draft → tracks it (own item/fee refresh never traps notes)', () => {
    expect(reconcileNotes({ serverNotes: 'Claim: A', draft: 'Claim: A', baseline: 'Claim: A' }))
      .toEqual({ draft: 'Claim: A', baseline: 'Claim: A', conflict: null })
  })

  it('server UNCHANGED + dirty draft → keeps the draft, no conflict', () => {
    expect(reconcileNotes({ serverNotes: 'Claim: A', draft: 'Claim: A edited', baseline: 'Claim: A' }))
      .toEqual({ draft: undefined, baseline: 'Claim: A', conflict: null })
  })

  it('server CHANGED + clean draft → adopts the new value', () => {
    expect(reconcileNotes({ serverNotes: 'Claim: B', draft: 'Claim: A', baseline: 'Claim: A' }))
      .toEqual({ draft: 'Claim: B', baseline: 'Claim: B', conflict: null })
  })

  // The concrete stale-overwrite bug: a dirty draft on a blank baseline must NOT silently adopt another
  // session's note or its revision — it is a CONFLICT that keeps the draft AND the old baseline, so a
  // later save can't blindly overwrite the other session.
  it('server CHANGED under a DIRTY draft → conflict, keeps draft + OLD baseline', () => {
    expect(reconcileNotes({ serverNotes: 'Other manager note', draft: 'My unsaved note', baseline: '' }))
      .toEqual({ draft: undefined, baseline: '', conflict: 'Other manager note' })
  })

  it('server CHANGED to exactly the dirty draft → no conflict (already matches), adopts', () => {
    expect(reconcileNotes({ serverNotes: 'Same text', draft: 'Same text', baseline: 'old' }))
      .toEqual({ draft: 'Same text', baseline: 'Same text', conflict: null })
  })
})
