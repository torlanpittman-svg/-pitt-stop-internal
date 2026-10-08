import { describe, expect, it } from 'vitest'
import { templatePost } from './ai/social-post'

const RESULT_CLAIMS = /(restored|oxidation|removed years|brought the gloss|swirls? removed|like new|paint correction)/i

describe('templatePost — factual only, no unobserved results', () => {
  it('proof for a ceramic job states the vehicle + service performed, never paint-correction results', () => {
    const post = templatePost({ pillar: 'proof', targetService: 'ceramic', vehicle: '2021 Chevrolet Tahoe', servicePerformed: 'Ceramic coating' })
    expect(post.copy).toContain('2021 Chevrolet Tahoe')
    expect(post.copy.toLowerCase()).toContain('ceramic coating')
    expect(post.copy).not.toMatch(RESULT_CLAIMS)
  })

  it('proof for an interior job never claims paint correction / oxidation removal', () => {
    const post = templatePost({ pillar: 'proof', targetService: 'interior', vehicle: '2019 Honda Accord', servicePerformed: 'Interior detail' })
    expect(post.copy).toContain('2019 Honda Accord')
    expect(post.copy).not.toMatch(RESULT_CLAIMS)
    expect(post.copy.toLowerCase()).not.toContain('paint')
  })

  it('proof with NO service performed does not claim any result — it educates + invites', () => {
    const post = templatePost({ pillar: 'proof', targetService: 'interior', vehicle: '2019 Honda Accord' })
    expect(post.copy).not.toMatch(RESULT_CLAIMS)
    expect(post.copy.toLowerCase()).toMatch(/send|photos|year\/make\/model/)
  })

  it('educate for ceramic never mentions paint correction', () => {
    const post = templatePost({ pillar: 'educate', targetService: 'ceramic' })
    expect(post.copy.toLowerCase()).not.toContain('paint correction')
  })
})
