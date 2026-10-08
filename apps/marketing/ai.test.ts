import { describe, it, expect } from 'vitest'
import { generateCampaignCopy, templateCopy } from './ai/campaign-copy'
import { generateSocialPost } from './ai/social-post'
import type { RawCompletion } from './ai/client'

const goodCopy: RawCompletion = async () => JSON.stringify({
  smsCopy: "Hi {{name}}, if your {{vehicle}}'s paint looks swirled under sunlight, we can inspect it. Reply with photos.",
  emailSubject: 'Is your {{vehicle}} due for correction?',
  emailBody: 'Hi {{name}},\n\nPaint correction removes swirls and restores gloss. Reply with photos and we will take a look.',
  targetService: 'paint_correction',
  reasoningSummary: 'Targets swirl-aware owners.',
  warnings: [],
})

describe('campaign copy generator', () => {
  it('returns a validated AI draft when the model responds well', async () => {
    const res = await generateCampaignCopy({ targetService: 'paint_correction', segmentLabel: 'Detailing customers', channel: 'both' }, { complete: goodCopy })
    expect(res.source).toBe('ai')
    expect(res.copy.smsCopy).toContain('{{name}}')
    expect(res.guardrail.ok).toBe(true)
  })

  it('malformed AI output can never drive a write — falls back to a safe template', async () => {
    const broken: RawCompletion = async () => '{ this is not valid json'
    const res = await generateCampaignCopy({ targetService: 'ceramic', segmentLabel: 'Paint customers', channel: 'sms' }, { complete: broken })
    expect(res.source).toBe('template')
    expect(res.copy.smsCopy.length).toBeGreaterThan(0)
    expect(res.guardrail.ok).toBe(true)
  })

  it('rejects AI copy that violates brand guardrails and uses the template', async () => {
    const unsafe: RawCompletion = async () => JSON.stringify({
      smsCopy: 'GUARANTEED to remove ALL scratches permanently! ACT NOW!!!',
      emailSubject: 'MEGA DEAL', emailBody: 'Guaranteed forever shine, like new!',
      targetService: 'ceramic', reasoningSummary: '', warnings: [],
    })
    const res = await generateCampaignCopy({ targetService: 'ceramic', segmentLabel: 'All', channel: 'both' }, { complete: unsafe })
    expect(res.source).toBe('template')
    expect(res.guardrail.ok).toBe(true)
  })

  it('schema-invalid AI output (missing fields) falls back safely', async () => {
    const partial: RawCompletion = async () => JSON.stringify({ smsCopy: 'hi' }) // missing required fields
    const res = await generateCampaignCopy({ targetService: 'interior', segmentLabel: 'All', channel: 'sms' }, { complete: partial })
    expect(res.source).toBe('template')
  })

  it('template copy is deterministic and on-brand (no invented discount)', () => {
    const a = templateCopy({ targetService: 'ceramic', segmentLabel: 'x', channel: 'both' })
    const b = templateCopy({ targetService: 'ceramic', segmentLabel: 'x', channel: 'both' })
    expect(a).toEqual(b)
    expect(a.smsCopy).not.toMatch(/\d+%\s*off/i)
  })
})

describe('social post generator', () => {
  it('produces a validated AI post or a safe template on bad output', async () => {
    const good: RawCompletion = async () => JSON.stringify({ copy: 'Paint correction restores the gloss your paint already has. Send your year/make/model for a tight estimate.', targetService: 'paint_correction', reasoningSummary: '', warnings: [] })
    const res = await generateSocialPost({ pillar: 'educate', targetService: 'paint_correction' }, { complete: good })
    expect(res.source).toBe('ai')
    expect(res.post.copy.length).toBeGreaterThan(0)

    const broken: RawCompletion = async () => 'nope'
    const res2 = await generateSocialPost({ pillar: 'proof', targetService: 'paint_correction', vehicle: '2019 Silverado', servicePerformed: 'Paint correction' }, { complete: broken })
    expect(res2.source).toBe('template')
    expect(res2.post.copy).toContain('Silverado')
  })
})
