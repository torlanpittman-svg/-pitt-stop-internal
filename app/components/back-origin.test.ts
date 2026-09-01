import { describe, it, expect } from 'vitest'
import { resolveBack } from './back-origin'

const FALLBACK = { href: '/work-board', label: 'Work Board' }

describe('resolveBack (allowlist-only, no external redirect)', () => {
  it('known key → its internal target', () => {
    expect(resolveBack('check-in', FALLBACK)).toEqual({ href: '/check-in', label: 'Check In' })
    expect(resolveBack('work-board', FALLBACK)).toEqual({ href: '/work-board', label: 'Work Board' })
  })
  it('absent / null / empty → safe fallback', () => {
    expect(resolveBack(null, FALLBACK)).toEqual(FALLBACK)
    expect(resolveBack(undefined, FALLBACK)).toEqual(FALLBACK)
    expect(resolveBack('', FALLBACK)).toEqual(FALLBACK)
  })
  it('unknown key → fallback (never an arbitrary route)', () => {
    expect(resolveBack('quick-entry-freeform', FALLBACK)).toEqual(FALLBACK)
  })
  it('external / open-redirect attempts → fallback (never honored)', () => {
    expect(resolveBack('https://evil.example.com', FALLBACK)).toEqual(FALLBACK)
    expect(resolveBack('//evil.example.com', FALLBACK)).toEqual(FALLBACK)
    expect(resolveBack('/admin/finance', FALLBACK)).toEqual(FALLBACK)
    expect(resolveBack('javascript:alert(1)', FALLBACK)).toEqual(FALLBACK)
    // prototype-pollution-style key must not resolve
    expect(resolveBack('toString', FALLBACK)).toEqual(FALLBACK)
    expect(resolveBack('__proto__', FALLBACK)).toEqual(FALLBACK)
  })
})
