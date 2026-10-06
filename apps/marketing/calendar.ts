/**
 * Premium-service marketing calendar. A deterministic 12-week rotation that biases the business
 * toward higher-ticket work (~40% ceramic, 30% paint correction, 20% interior, 10% brand/general)
 * plus the default weekly Facebook cadence (Mon educate / Wed proof / Fri sell). Code-defined and
 * testable; the UI merges this plan with actually-scheduled campaigns and posts into one calendar.
 * This seeds a plan — it never sends or posts anything on its own.
 */
import type { ContentPillar, ServiceCategory } from './types'

export interface CalendarWeek {
  week: number                 // 1..12
  focus: ServiceCategory       // the premium service this week leans on
  theme: string
  /** Suggested biweekly SMS/email campaign angle (null on off weeks). */
  campaignAngle: string | null
}

// 12-week rotation. Count: ceramic x5, paint_correction x4, interior x2, brand x1 → biased to premium.
export const TWELVE_WEEK_ROTATION: CalendarWeek[] = [
  { week: 1,  focus: 'ceramic',          theme: 'Ceramic coating — education + proof + offer', campaignAngle: 'Ceramic upsell to past paint/detail customers' },
  { week: 2,  focus: 'interior',         theme: 'Interior transformation + odor/stain education', campaignAngle: null },
  { week: 3,  focus: 'paint_correction', theme: 'Paint correction — swirls under sunlight', campaignAngle: 'Paint-correction inspection month' },
  { week: 4,  focus: 'ceramic',          theme: 'Ceramic myths vs reality + maintenance', campaignAngle: null },
  { week: 5,  focus: 'paint_correction', theme: 'Before/after correction proof', campaignAngle: 'Reactivate inactive customers (correction angle)' },
  { week: 6,  focus: 'ceramic',          theme: 'Ceramic protection for new/leased vehicles', campaignAngle: null },
  { week: 7,  focus: 'interior',         theme: 'Premium interior restoration', campaignAngle: 'Interior restoration for past exterior customers' },
  { week: 8,  focus: 'paint_correction', theme: 'Why dark paint shows swirls', campaignAngle: null },
  { week: 9,  focus: 'ceramic',          theme: 'Ceramic maintenance follow-up (previous coating customers)', campaignAngle: 'Ceramic maintenance / follow-up' },
  { week: 10, focus: 'brand',            theme: 'Reviews, spotlights, and the Pitt Stop difference', campaignAngle: null },
  { week: 11, focus: 'paint_correction', theme: 'Correction + coating bundle education', campaignAngle: 'Correction-to-ceramic bundle' },
  { week: 12, focus: 'ceramic',          theme: 'Ceramic — long-term value recap', campaignAngle: null },
]

/** Default weekly Facebook cadence. */
export const WEEKLY_FACEBOOK_PLAN: Array<{ day: 'Mon' | 'Wed' | 'Fri'; pillar: ContentPillar; note: string }> = [
  { day: 'Mon', pillar: 'educate', note: 'Teach something (why black paint swirls, ceramic myths, detailing vs correction).' },
  { day: 'Wed', pillar: 'proof',   note: 'Real Pitt Stop work — before/after, transformation, review, spotlight.' },
  { day: 'Fri', pillar: 'sell',    note: 'Direct-response around a premium service (rotate ceramic/correction/interior).' },
]

/** The premium service a given week leans on (1-indexed, wraps every 12 weeks). */
export function focusForWeek(weekNumber: number): CalendarWeek {
  const idx = ((Math.max(1, Math.floor(weekNumber)) - 1) % TWELVE_WEEK_ROTATION.length)
  return TWELVE_WEEK_ROTATION[idx]
}

/** Rough mix summary (for the Settings/Overview explainer). */
export function rotationMix(): Record<ServiceCategory, number> {
  const mix = { ceramic: 0, paint_correction: 0, interior: 0, general: 0, brand: 0, other: 0 } as Record<ServiceCategory, number>
  for (const w of TWELVE_WEEK_ROTATION) mix[w.focus] += 1
  return mix
}
