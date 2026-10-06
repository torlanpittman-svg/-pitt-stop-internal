import { describe, it, expect } from 'vitest'
import { classifyInboundKeyword, composeSmsBody, smsDisclosureText, a2pProfile, helpReply, SMS_OPT_IN_VERSION } from './compliance'

const P = a2pProfile({ smsBrandName: 'Pitt Stop Detail', privacyUrl: 'https://pittstopdetail.com/privacy', termsUrl: 'https://pittstopdetail.com/terms' })

describe('inbound keyword classification (carrier STOP/START/HELP)', () => {
  it('detects STOP and its synonyms', () => {
    for (const w of ['STOP', 'stop', 'Stop.', 'UNSUBSCRIBE', 'cancel', 'END', 'quit']) {
      expect(classifyInboundKeyword(w)).toBe('stop')
    }
  })
  it('detects START/UNSTOP and HELP', () => {
    expect(classifyInboundKeyword('START')).toBe('start')
    expect(classifyInboundKeyword('unstop')).toBe('start')
    expect(classifyInboundKeyword('HELP')).toBe('help')
    expect(classifyInboundKeyword('info')).toBe('help')
  })
  it('treats a normal reply as not-a-keyword', () => {
    expect(classifyInboundKeyword('How much for an F-250?')).toBeNull()
    expect(classifyInboundKeyword('')).toBeNull()
    expect(classifyInboundKeyword('yes please stop by')).toBe('start') // first word wins (START synonym)
  })
})

describe('compliant outbound composition', () => {
  it('adds brand identification and STOP language without duplicating', () => {
    const out = composeSmsBody('Your Silverado may be due for a detail. Reply for an estimate.', P)
    expect(out.startsWith('Pitt Stop Detail:')).toBe(true)
    expect(out).toMatch(/reply stop to opt out/i)
  })
  it('does not double-add brand or STOP when already present', () => {
    const body = 'Pitt Stop Detail: ceramic openings this week. Reply STOP to opt out.'
    expect(composeSmsBody(body, P)).toBe(body)
  })
})

describe('opt-in disclosure', () => {
  it('includes consent, frequency, rates, STOP/HELP and real links', () => {
    const d = smsDisclosureText(P)
    expect(d.toLowerCase()).toContain('agree to receive')
    expect(d).toMatch(/msg & data rates may apply/i)
    expect(d).toMatch(/reply stop/i)
    expect(d).toContain('https://pittstopdetail.com/privacy')
  })
  it('versions the disclosure for audit', () => {
    expect(SMS_OPT_IN_VERSION).toMatch(/^v\d/)
  })
  it('help reply identifies the sender and offers STOP', () => {
    expect(helpReply(P)).toContain('Pitt Stop Detail')
    expect(helpReply(P)).toMatch(/stop/i)
  })
})
