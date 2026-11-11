import { describe, it, expect } from 'vitest'
import { describeBookingSource, customerSaidLabel, classifySource, PLACEMENT_LABELS } from './attribution'

const GCLID = 'Cj0KCQiA' + 'x'.repeat(83) // 91 chars, the length stored on real bookings

describe('describeBookingSource — tracked source', () => {
  it('gclid → Google Ads', () => {
    const d = describeBookingSource({ gclid: GCLID })
    expect(d.trackedSource).toBe('Google Ads')
    expect(d.entryPoint).toBeNull()
  })
  it('utm_source=gbp → Google Maps / Business Profile', () => {
    expect(describeBookingSource({ utm_source: 'gbp' }).trackedSource).toBe('Google Maps / Business Profile')
    expect(describeBookingSource({ utm_source: 'google', utm_medium: 'gbp' }).trackedSource).toBe('Google Maps / Business Profile')
  })
  it('utm_source=website alone → original source unknown, never organic', () => {
    const d = describeBookingSource({ utm_source: 'website' })
    expect(d.trackedSource).toBe('Website — original source unknown')
    expect(d.trackedSource.toLowerCase()).not.toContain('organic')
    expect(d.entryPoint).toBeNull() // nothing to add beyond the source line
  })
  it('Facebook / Instagram tags are named without calling them paid', () => {
    expect(describeBookingSource({ utm_source: 'facebook', utm_medium: 'organic' }).trackedSource).toBe('Facebook')
    expect(describeBookingSource({ utm_source: 'fb' }).trackedSource).toBe('Facebook')
    expect(describeBookingSource({ utm_source: 'Instagram' }).trackedSource).toBe('Instagram')
    expect(describeBookingSource({ utm_source: 'ig', utm_medium: 'social' }).trackedSource).toBe('Instagram')
    expect(describeBookingSource({ fbclid: 'IwAR123' }).trackedSource).toBe('Facebook / Instagram')
    for (const a of [{ utm_source: 'facebook' }, { utm_source: 'instagram', fbclid: 'x' }, { fbclid: 'x' }, { utm_source: 'facebook', utm_medium: 'paid_social' }]) {
      expect(describeBookingSource(a).trackedSource).not.toMatch(/paid|ads?\b/i)
    }
  })
  it('explicit email / SMS campaign tags', () => {
    expect(describeBookingSource({ utm_source: 'email', utm_medium: 'newsletter' }).trackedSource).toBe('Email campaign')
    expect(describeBookingSource({ utm_source: 'mailerlite' }).trackedSource).toBe('Email campaign')
    expect(describeBookingSource({ utm_medium: 'email' }).trackedSource).toBe('Email campaign')
    expect(describeBookingSource({ utm_source: 'sms' }).trackedSource).toBe('Text campaign')
    expect(describeBookingSource({ utm_medium: 'SMS', utm_campaign: 'fall' }).trackedSource).toBe('Text campaign')
  })
  it('other non-empty source → readable name, not guessed', () => {
    expect(describeBookingSource({ utm_source: 'nextdoor' }).trackedSource).toBe('Other tracked source — Nextdoor')
    expect(describeBookingSource({ utm_source: 'local_radio-KBTX' }).trackedSource).toBe('Other tracked source — Local Radio KBTX')
    expect(describeBookingSource({ utm_source: 'google' }).trackedSource).toBe('Other tracked source — Google') // no ad or Maps evidence
    expect(describeBookingSource({ ref: 'partner_shop' }).trackedSource).toBe('Other tracked source — Partner Shop')
    expect(describeBookingSource({ utm_campaign: 'spring_promo' }).trackedSource).toBe('Other tracked source — campaign “Spring Promo”')
  })
  it('does not mistake substrings for Facebook / Instagram', () => {
    expect(describeBookingSource({ utm_source: 'digital_flyer' }).trackedSource).toBe('Other tracked source — Digital Flyer')
    expect(describeBookingSource({ utm_source: 'metalworks' }).trackedSource).toBe('Other tracked source — Metalworks')
  })
  it('no usable tracking → Unknown / untracked', () => {
    for (const raw of [{}, null, undefined, 'gclid=abc', [], 42, { utm_source: '   ' }, { gclid: '' }, { utm_source: null }, { utm_content: 'hero' }, { utm_term: 'detailing' }]) {
      const d = describeBookingSource(raw)
      expect(d.trackedSource).toBe('Unknown / untracked')
      expect(d.kind).toBe('unknown')
      expect(d.entryPoint).toBeNull()
    }
  })
})

describe('describeBookingSource — precedence and entry point', () => {
  it('Google Ads click evidence beats the generic website tag (owner example)', () => {
    const d = describeBookingSource({ gclid: GCLID, utm_source: 'website', utm_content: 'hero' })
    expect(d.trackedSource).toBe('Google Ads')
    expect(d.entryPoint).toBe('Website — top booking button')
  })
  it('gclid beats every other source tag', () => {
    for (const utm_source of ['website', 'gbp', 'facebook', 'email', 'nextdoor']) {
      expect(describeBookingSource({ gclid: GCLID, utm_source }).trackedSource).toBe('Google Ads')
    }
    expect(describeBookingSource({ gclid: GCLID, utm_source: 'website' }).entryPoint).toBe('Website')
  })
  it('tagged Google ad link without a click ID is still Google Ads', () => {
    expect(describeBookingSource({ utm_source: 'google', utm_medium: 'cpc' }).trackedSource).toBe('Google Ads')
  })
  it('website tag + known placements (values stored on real bookings)', () => {
    const entry = (utm_content: string) => describeBookingSource({ utm_source: 'website', utm_content }).entryPoint
    expect(entry('hero')).toBe('Website — top booking button')
    expect(entry('mobile_bar')).toBe('Website — mobile bottom bar')
    expect(entry('service_card')).toBe('Website — service section button')
    expect(entry('content')).toBe('Website — link in page content')
    expect(entry('sticky_header')).toBe('Website — sticky header booking button')
    expect(PLACEMENT_LABELS.hero).toBe('Top booking button')
  })
  it('unfamiliar placement is shown as-is, not translated', () => {
    const d = describeBookingSource({ utm_source: 'website', utm_content: 'promo_banner_7' })
    expect(d.trackedSource).toBe('Website — original source unknown')
    expect(d.entryPoint).toBe('Website — unrecognized button tag “promo_banner_7”')
  })
  it('placement is only read as a website button when the website tag is present', () => {
    expect(describeBookingSource({ utm_source: 'facebook', utm_content: 'hero' }).entryPoint).toBeNull()
    expect(describeBookingSource({ gclid: GCLID, utm_content: 'hero' }).entryPoint).toBeNull()
  })
  it('a campaign on a website-tagged booking does not change the source', () => {
    const d = describeBookingSource({ utm_source: 'website', utm_campaign: 'domain_verification' })
    expect(d.trackedSource).toBe('Website — original source unknown')
  })
  it('whitespace and capitalization', () => {
    const d = describeBookingSource({ ' UTM_Source ': '  WebSite ', UTM_CONTENT: ' Hero ', GCLID: `  ${GCLID} ` })
    expect(d.trackedSource).toBe('Google Ads')
    expect(d.entryPoint).toBe('Website — top booking button')
    expect(describeBookingSource({ utm_source: ' GBP ' }).trackedSource).toBe('Google Maps / Business Profile')
  })
})

describe('describeBookingSource — tracking details', () => {
  it('keeps every stored tag verbatim, including the full click ID', () => {
    const raw = { utm_content: 'hero', gclid: GCLID, utm_source: 'website', custom_tag: 'x' }
    const before = JSON.stringify(raw)
    const d = describeBookingSource(raw)
    expect(d.details).toEqual([
      { key: 'utm_source', value: 'website' }, { key: 'utm_content', value: 'hero' },
      { key: 'gclid', value: GCLID }, { key: 'custom_tag', value: 'x' },
    ])
    expect(JSON.stringify(raw)).toBe(before) // input never mutated
  })
  it('empty when nothing is stored', () => {
    expect(describeBookingSource({}).details).toEqual([])
    expect(describeBookingSource(null).details).toEqual([])
  })
})

describe('customer-reported source stays separate', () => {
  it('labels the answer with the existing "How did you hear about us?" vocabulary', () => {
    expect(customerSaidLabel('referral')).toBe('Friend or family')
    expect(customerSaidLabel(' Google ')).toBe('Google (search or Maps)')
    expect(customerSaidLabel('other', 'radio ad')).toBe('Other — radio ad')
    expect(customerSaidLabel('saw_sign')).toBe('Saw Sign') // unfamiliar key: readable, not dropped
  })
  it('not answered → null', () => {
    expect(customerSaidLabel(null)).toBeNull()
    expect(customerSaidLabel(undefined, '  ')).toBeNull()
    expect(customerSaidLabel('')).toBeNull()
  })
  it('neither overwrites the other', () => {
    const tracked = describeBookingSource({ gclid: GCLID })
    const said = customerSaidLabel('referral')
    expect(tracked.trackedSource).toBe('Google Ads')
    expect(said).toBe('Friend or family')
    // the tracked reading has no input for the customer's answer at all
    expect(describeBookingSource({ gclid: GCLID, referral_source: 'referral' }).trackedSource).toBe('Google Ads')
    expect(describeBookingSource({ referral_source: 'referral' }).trackedSource).toBe('Unknown / untracked')
  })
})

describe('classifySource (ledger vocabulary) is unchanged by the display work', () => {
  it('keeps its existing answers', () => {
    expect(classifySource({ gclid: 'x' })).toBe('google_ads')
    expect(classifySource({ utm_source: 'website' })).toBe('website')
    expect(classifySource({ utm_source: 'gbp' })).toBe('google_organic')
    expect(classifySource({})).toBe('unknown')
  })
})
