import { describe, it, expect } from 'vitest'
import { classifyComment } from './comments'
import { getProviders, providerStatus } from './providers'
import type { SmsProvider } from './providers'

describe('comment assistant classification', () => {
  it('suggests safe FAQ answers for routine questions', () => {
    expect(classifyComment('What are your hours?').topic).toBe('hours')
    expect(classifyComment('Do you work on trucks?').topic).toBe('trucks')
    expect(classifyComment('Can you get a smoke odor out?').topic).toBe('stains')
    const ceramic = classifyComment('Tell me about ceramic coating')
    expect(ceramic.suggestedReply).toBeTruthy()
    expect(ceramic.escalate).toBe(false)
  })

  it('never fabricates a price — answers condition-dependent questions with an estimate invite', () => {
    const res = classifyComment('How much for an F-250?')
    expect(res.topic).toBe('pricing')
    expect(res.suggestedReply).toContain('photos')
    expect(res.suggestedReply).not.toMatch(/\$\d/)
  })

  it('escalates angry, refund, damage, legal, and fleet messages', () => {
    expect(classifyComment('I want a refund now').escalate).toBe(true)
    expect(classifyComment('You scratched my paint!').escalationReason).toBe('damage_claim')
    expect(classifyComment('My lawyer will be in touch').escalationReason).toBe('legal_threat')
    expect(classifyComment('This is the worst shop ever').escalate).toBe(true)
    expect(classifyComment('We have a fleet of 20 vehicles').escalationReason).toBe('fleet_commercial')
  })

  it('queues anything it is unsure about for human review instead of guessing', () => {
    const res = classifyComment('Random unrelated message about weather')
    expect(res.state).toBe('needs_review')
    expect(res.suggestedReply).toBeNull()
  })
})

describe('providers are dry-run by default (no credentials in repo)', () => {
  it('returns non-live adapters', () => {
    const p = getProviders({} as NodeJS.ProcessEnv)
    expect(providerStatus(p)).toEqual({ sms: false, email: false, facebook: false, googleAds: false })
  })

  it('dry-run send never reports a real send', async () => {
    const sms: SmsProvider = getProviders({} as NodeJS.ProcessEnv).sms
    const res = await sms.send('555', 'hi')
    expect(res.status).toBe('dry_run')
  })
})
