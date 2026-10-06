import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The customer-facing A2P routes MUST stay public (unauthenticated). The proxy only gates paths listed
// in its middleware matcher, so "public" == "absent from the matcher". We assert that structurally.
const proxySrc = readFileSync('proxy.ts', 'utf8')
// Only the actual matcher entries matter — strip comment lines (which may mention routes in prose).
const matcherBlock = proxySrc.slice(proxySrc.indexOf('matcher'))
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

describe('public A2P routes remain unauthenticated', () => {
  it('does not gate /privacy, /terms, /sms-opt-in, or /unsubscribe', () => {
    for (const route of ['/privacy', '/terms', '/sms-opt-in', '/unsubscribe']) {
      expect(matcherBlock).not.toContain(`'${route}`)
    }
  })
  it('the Twilio webhooks are outside the /api/marketing gate (public, signature-validated)', () => {
    expect(matcherBlock).not.toContain('/api/twilio')
  })
  it('still gates the manager /marketing surface', () => {
    expect(matcherBlock).toContain("'/marketing/:path*'")
  })
})
