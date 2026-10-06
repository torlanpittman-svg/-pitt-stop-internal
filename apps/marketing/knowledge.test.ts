import { describe, it, expect } from 'vitest'
import { classifyServiceLabel, classifyServices, hasServiceCategory, primaryServiceCategory } from './services'
import { validateCopy, validateCampaignCopy } from './guardrails'
import { focusForWeek, rotationMix, TWELVE_WEEK_ROTATION } from './calendar'
import { brandContext, serviceKnowledge } from './profile'

describe('service classifier', () => {
  it('classifies premium services from free text', () => {
    expect(classifyServiceLabel('Ceramic Coating 3yr')).toBe('ceramic')
    expect(classifyServiceLabel('Full paint correction')).toBe('paint_correction')
    expect(classifyServiceLabel('Interior shampoo + odor')).toBe('interior')
    expect(classifyServiceLabel('Full detail / wash & wax')).toBe('general')
  })
  it('returns null for unknown text and never invents a service', () => {
    expect(classifyServiceLabel('oil change')).toBeNull()
    expect(classifyServiceLabel('')).toBeNull()
    expect(classifyServiceLabel(null)).toBeNull()
  })
  it('ceramic wins over correction when both present', () => {
    expect(primaryServiceCategory(['ceramic coating after correction'])).toBe('ceramic')
  })
  it('dedupes and priority-orders multi-service jobs', () => {
    const cats = classifyServices(['Interior detail', 'Paint correction', 'Ceramic coating', 'wash'])
    expect(cats).toEqual(['ceramic', 'paint_correction', 'interior', 'general'])
  })
  it('hasServiceCategory detects a specific premium service', () => {
    expect(hasServiceCategory(['Paint correction'], 'paint_correction')).toBe(true)
    expect(hasServiceCategory(['Paint correction'], 'ceramic')).toBe(false)
  })
  it('falls back to other when nothing classifies', () => {
    expect(primaryServiceCategory(['brake job'])).toBe('other')
  })
})

describe('copy guardrails', () => {
  it('passes clean professional copy', () => {
    const res = validateCopy("If your black paint looks swirled under sunlight, paint correction can dramatically improve it. Reply with a few photos and we'll take a look.")
    expect(res.ok).toBe(true)
    expect(res.findings).toHaveLength(0)
  })
  it('flags guarantees and permanent claims as blocking errors', () => {
    expect(validateCopy('Guaranteed to remove all scratches permanently!').ok).toBe(false)
  })
  it('warns on fake urgency and emoji spam without blocking', () => {
    const res = validateCopy('🚨🔥 MEGA DEAL — ACT NOW!! 🔥🚨')
    expect(res.ok).toBe(true) // warnings only
    expect(res.findings.some((f) => f.code === 'spam_alert' || f.code === 'act_now')).toBe(true)
    expect(res.findings.some((f) => f.code === 'all_caps')).toBe(true)
  })
  it('blocks invented discounts when no offer is approved', () => {
    expect(validateCopy('Get 50% off this week!', { offerApproved: false }).ok).toBe(false)
    expect(validateCopy('Get 50% off this week!', { offerApproved: true }).ok).toBe(true)
  })
  it('validates all campaign surfaces and namespaces findings', () => {
    const res = validateCampaignCopy({ smsCopy: 'Guaranteed perfect', emailSubject: 'Hello', emailBody: 'Clean body' })
    expect(res.ok).toBe(false)
    expect(res.findings.some((f) => f.code.startsWith('smsCopy:'))).toBe(true)
  })
})

describe('premium-service calendar', () => {
  it('has a 12-week rotation biased toward premium services', () => {
    expect(TWELVE_WEEK_ROTATION).toHaveLength(12)
    const mix = rotationMix()
    expect(mix.ceramic).toBeGreaterThanOrEqual(mix.interior)
    expect(mix.ceramic + mix.paint_correction).toBeGreaterThan(mix.general + mix.brand)
  })
  it('wraps the rotation past week 12', () => {
    expect(focusForWeek(13).week).toBe(focusForWeek(1).week)
    expect(focusForWeek(1).focus).toBe('ceramic')
  })
})

describe('marketing profile', () => {
  it('builds a compact brand context for prompts', () => {
    const ctx = brandContext()
    expect(ctx).toContain('Pitt Stop')
    expect(ctx).toContain('Ceramic Coating')
    expect(ctx.toLowerCase()).toContain('never claim')
  })
  it('exposes per-service knowledge', () => {
    expect(serviceKnowledge('ceramic')?.name).toBe('Ceramic Coating')
    expect(serviceKnowledge('nope')).toBeNull()
  })
})
