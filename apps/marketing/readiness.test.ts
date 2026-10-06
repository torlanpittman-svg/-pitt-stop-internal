import { describe, it, expect } from 'vitest'
import { smsLaunchReadiness } from './readiness'
import { buildA2pPacket, OPT_OUT_KEYWORDS, OPT_IN_KEYWORDS, HELP_KEYWORDS } from './a2p'
import type { MarketingConfig } from '@/apps/settings/db'

function cfg(over: Partial<MarketingConfig> = {}): MarketingConfig {
  return {
    enabled: true, requireApproval: true, sendDailyCap: 500, attributionWindowDays: 30, highValueCents: 100000, defaultOffer: '',
    smsLive: false, smsBrandName: 'Pitt Stop Detail', smsHelpText: 'Reply HELP for help.', smsFrequency: 'Up to 3 marketing messages per month.',
    privacyUrl: '', termsUrl: '', smsQuietStartHour: 9, smsQuietEndHour: 20, smsGlobalCap: 250,
    publicBaseUrl: '', legalName: 'Pitt Stop Detail & Auto Sales', businessWebsite: '', supportContact: '',
    a2pBrandApproved: false, a2pCampaignApproved: false, advancedOptOutConfigured: false, optInPublished: false, webhooksVerified: false, privacyPublished: false, termsPublished: false, ...over,
  }
}

const allApproved: Partial<MarketingConfig> = {
  publicBaseUrl: 'https://pittstopdetail.com', businessWebsite: 'https://pittstopdetail.com', supportContact: 'text us',
  optInPublished: true, privacyPublished: true, termsPublished: true, advancedOptOutConfigured: true, a2pBrandApproved: true, a2pCampaignApproved: true, smsLive: true,
}

describe('SMS launch readiness', () => {
  it('can finish preflight after real webhook verification is recorded', () => {
    const r = smsLaunchReadiness({ cfg: cfg({ ...allApproved, webhooksVerified: true }), providerLive: true, webhookBaseConfigured: true, subscriberCount: 1 })
    expect(r.canGoLive).toBe(true)
    expect(r.blockers).toEqual([])
  })
  it('is NOT ready when A2P brand/campaign are unapproved (even if everything else is set)', () => {
    const r = smsLaunchReadiness({ cfg: cfg({ ...allApproved, a2pBrandApproved: false, a2pCampaignApproved: false }), providerLive: true, webhookBaseConfigured: true, subscriberCount: 5 })
    expect(r.canGoLive).toBe(false)
    expect(r.blockers.map((b) => b.key)).toEqual(expect.arrayContaining(['a2p_brand', 'a2p_campaign']))
  })

  it('credentials ALONE do not make SMS ready', () => {
    // Twilio configured + webhook + subscribers, but policies/A2P/advanced-opt-out not confirmed.
    const r = smsLaunchReadiness({ cfg: cfg({ smsLive: true }), providerLive: true, webhookBaseConfigured: true, subscriberCount: 3 })
    expect(r.canGoLive).toBe(false)
    expect(r.blockers.length).toBeGreaterThan(0)
  })

  it('requires at least one real opt-in', () => {
    const r = smsLaunchReadiness({ cfg: cfg(allApproved), providerLive: true, webhookBaseConfigured: true, subscriberCount: 0 })
    expect(r.canGoLive).toBe(false)
    expect(r.blockers.map((b) => b.key)).toContain('test_opt_in')
  })

  it('is ready only when every required item is READY', () => {
    const r = smsLaunchReadiness({ cfg: cfg(allApproved), providerLive: true, webhookBaseConfigured: true, subscriberCount: 2 })
    // webhook_reachable stays external (can't verify without a deploy) → still a blocker by design.
    expect(r.items.find((i) => i.key === 'webhook_reachable')?.status).toBe('external')
    expect(r.canGoLive).toBe(false)
    // Everything except the deploy-only webhook check is satisfied:
    expect(r.blockers.map((b) => b.key)).toEqual(['webhook_reachable'])
  })
})

describe('A2P registration packet', () => {
  const packet = buildA2pPacket(cfg(allApproved))
  it('uses the MARKETING use case and the approved description', () => {
    expect(packet.campaign.useCase).toBe('MARKETING')
    expect(packet.campaign.description).toMatch(/affirmatively opt in/i)
  })
  it('lists carrier-standard opt-out/opt-in/help keywords', () => {
    expect(packet.optOutKeywords).toEqual(OPT_OUT_KEYWORDS)
    expect(packet.optInKeywords).toEqual(OPT_IN_KEYWORDS)
    expect(packet.helpKeywords).toEqual(HELP_KEYWORDS)
  })
  it('produces brand-identified sample messages with STOP language and no fake offers', () => {
    expect(packet.sampleMessages.length).toBeGreaterThanOrEqual(4)
    for (const m of packet.sampleMessages) {
      expect(m).toMatch(/pitt stop/i)
      expect(m).toMatch(/reply stop/i)
      expect(m).not.toMatch(/\d+%\s*off|\$\d+\s*off/i)
    }
  })
  it('includes Advanced Opt-Out confirmation copy with program terms + URLs', () => {
    expect(packet.confirmations.optIn).toMatch(/subscribed/i)
    expect(packet.confirmations.optIn).toContain('pittstopdetail.com')
    expect(packet.confirmations.optOut).toMatch(/unsubscribed/i)
  })
  it('opt-in URL points at the real public /sms-opt-in route', () => {
    expect(packet.urls.optIn).toBe('https://pittstopdetail.com/sms-opt-in')
    expect(packet.urls.privacy).toBe('https://pittstopdetail.com/privacy')
    expect(packet.urls.terms).toBe('https://pittstopdetail.com/terms')
  })
  it('flags missing required fields when URLs/contact are blank', () => {
    const blank = buildA2pPacket(cfg())
    expect(blank.missing.length).toBeGreaterThan(0)
    expect(blank.missing.join(' ')).toMatch(/public base url/i)
  })
})
