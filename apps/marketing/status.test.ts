import { describe, it, expect } from 'vitest'
import { canTransition, allowedTransitions, isTerminal } from './status'

describe('campaign status machine', () => {
  it('allows the forward path draft → ready → scheduled → sending → sent → completed', () => {
    expect(canTransition('draft', 'ready')).toBe(true)
    expect(canTransition('ready', 'scheduled')).toBe(true)
    expect(canTransition('scheduled', 'sending')).toBe(true)
    expect(canTransition('sending', 'sent')).toBe(true)
    expect(canTransition('sent', 'completed')).toBe(true)
  })
  it('refuses to send a draft or re-open a sent campaign', () => {
    expect(canTransition('draft', 'sending')).toBe(false)
    expect(canTransition('draft', 'sent')).toBe(false)
    expect(canTransition('sent', 'sending')).toBe(false)
    expect(canTransition('sent', 'draft')).toBe(false)
  })
  it('treats completed and cancelled as terminal', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(allowedTransitions('completed')).toEqual([])
    expect(allowedTransitions('cancelled')).toEqual([])
  })
  it('allows pausing a send and resuming', () => {
    expect(canTransition('sending', 'paused')).toBe(true)
    expect(canTransition('paused', 'sending')).toBe(true)
  })
})
