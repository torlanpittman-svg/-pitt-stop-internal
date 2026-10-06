/**
 * Segment engine — pure, deterministic logic over a per-customer aggregate (ContactAggregate).
 * No DB here, so every predicate is unit-testable; contacts.ts builds the aggregates from the
 * canonical customer/order data and feeds them in. Named segments encode the V1 strategy
 * (reactivation, premium upsell, high value); the custom builder combines the same criteria.
 */
import type { ServiceCategory } from './types'

export interface ContactAggregate {
  customerId: string
  name: string
  phone: string | null
  email: string | null
  lastVisitAt: Date | null
  totalVisits: number
  lifetimeRevenueCents: number
  avgTicketCents: number
  categories: ServiceCategory[]   // premium categories ever purchased
  smsEligible: boolean            // manager hard-block flag (false = blocked)
  emailEligible: boolean
  smsConsent: boolean             // proven promotional-SMS opt-in (phone presence is NOT consent)
  unsubscribed: boolean
}

export interface SegmentCriteria {
  /** Customer's last visit was at least this many days ago (inactive gate). */
  minDaysSinceVisit?: number
  /** Customer's last visit was at most this many days ago. */
  maxDaysSinceVisit?: number
  minLifetimeRevenueCents?: number
  minVisits?: number
  /** Must have purchased this premium category at least once. */
  hasCategory?: ServiceCategory
  /** Must NOT have purchased this category (upsell gap). */
  missingCategory?: ServiceCategory
  requireSmsEligible?: boolean
  requireEmailEligible?: boolean
  /** Must have proven promotional-SMS consent (A2P/TCPA). */
  requireSmsConsent?: boolean
  /** Must be reachable (has a phone or email) and not unsubscribed. */
  requireContactable?: boolean
}

export interface NamedSegment {
  key: string
  label: string
  description: string
  /** The premium service this segment is meant to promote (drives copy + attribution). */
  targetService?: ServiceCategory
  criteria: SegmentCriteria
}

const DAY_MS = 24 * 60 * 60 * 1000

export function daysSince(date: Date | null | undefined, now: number): number | null {
  if (!date) return null
  return Math.floor((now - date.getTime()) / DAY_MS)
}

/** Does a contact satisfy a criteria set? `requireContactable` guards against blasting everyone. */
export function matchesSegment(contact: ContactAggregate, criteria: SegmentCriteria, now: number): boolean {
  const since = daysSince(contact.lastVisitAt, now)

  if (criteria.minDaysSinceVisit != null) {
    if (since == null || since < criteria.minDaysSinceVisit) return false
  }
  if (criteria.maxDaysSinceVisit != null) {
    if (since == null || since > criteria.maxDaysSinceVisit) return false
  }
  if (criteria.minLifetimeRevenueCents != null && contact.lifetimeRevenueCents < criteria.minLifetimeRevenueCents) return false
  if (criteria.minVisits != null && contact.totalVisits < criteria.minVisits) return false
  if (criteria.hasCategory && !contact.categories.includes(criteria.hasCategory)) return false
  if (criteria.missingCategory && contact.categories.includes(criteria.missingCategory)) return false

  if (criteria.requireSmsEligible && (!contact.smsEligible || contact.unsubscribed || !contact.phone)) return false
  if (criteria.requireSmsConsent && (!contact.smsConsent || !contact.phone)) return false
  if (criteria.requireEmailEligible && (!contact.emailEligible || contact.unsubscribed || !contact.email)) return false
  if (criteria.requireContactable) {
    const reachable = (!!contact.phone || !!contact.email) && !contact.unsubscribed
    if (!reachable) return false
  }
  return true
}

/** Filter an aggregate list by criteria. */
export function applySegment(contacts: ContactAggregate[], criteria: SegmentCriteria, now: number): ContactAggregate[] {
  return contacts.filter((c) => matchesSegment(c, criteria, now))
}

/** Reach estimate: how many match, and how many are reachable by each channel. */
export interface SegmentEstimate { total: number; smsReachable: number; emailReachable: number }
export function estimateSegment(contacts: ContactAggregate[], criteria: SegmentCriteria, now: number): SegmentEstimate {
  const matched = applySegment(contacts, criteria, now)
  let sms = 0, email = 0
  for (const c of matched) {
    // SMS reach requires PROVEN consent, not merely a phone number.
    if (c.smsConsent && c.phone) sms++
    if (c.emailEligible && !c.unsubscribed && c.email) email++
  }
  return { total: matched.length, smsReachable: sms, emailReachable: email }
}

/** Default high-value threshold (cents). Overridable via settings/custom builder. */
export const DEFAULT_HIGH_VALUE_CENTS = 100_000 // $1,000 lifetime

export const NAMED_SEGMENTS: Record<string, NamedSegment> = {
  inactive_180: {
    key: 'inactive_180', label: 'Inactive 180+ days', description: 'No visit in 6+ months — prime for reactivation.',
    criteria: { minDaysSinceVisit: 180, requireContactable: true },
  },
  inactive_270: {
    key: 'inactive_270', label: 'Inactive 270+ days', description: 'No visit in 9+ months.',
    criteria: { minDaysSinceVisit: 270, requireContactable: true },
  },
  inactive_365: {
    key: 'inactive_365', label: 'Inactive 365+ days', description: 'No visit in a year — strong reactivation list.',
    criteria: { minDaysSinceVisit: 365, requireContactable: true },
  },
  paint_without_ceramic: {
    key: 'paint_without_ceramic', label: 'Paint correction → ceramic upsell', targetService: 'ceramic',
    description: 'Did paint correction with us but no ceramic coating yet.',
    criteria: { hasCategory: 'paint_correction', missingCategory: 'ceramic', requireContactable: true },
  },
  detail_without_correction: {
    key: 'detail_without_correction', label: 'Detailing → paint correction upsell', targetService: 'paint_correction',
    description: 'General detailing customers who have not had paint correction.',
    criteria: { hasCategory: 'general', missingCategory: 'paint_correction', requireContactable: true },
  },
  interior_without_exterior: {
    key: 'interior_without_exterior', label: 'Interior → exterior correction', targetService: 'paint_correction',
    description: 'Premium interior customers without exterior paint correction.',
    criteria: { hasCategory: 'interior', missingCategory: 'paint_correction', requireContactable: true },
  },
  ceramic_followup: {
    key: 'ceramic_followup', label: 'Ceramic maintenance follow-up', targetService: 'ceramic',
    description: 'Previous ceramic customers due for a maintenance check (300+ days).',
    criteria: { hasCategory: 'ceramic', minDaysSinceVisit: 300, requireContactable: true },
  },
  high_value: {
    key: 'high_value', label: 'High-value customers', description: 'Lifetime revenue above $1,000.',
    criteria: { minLifetimeRevenueCents: DEFAULT_HIGH_VALUE_CENTS, requireContactable: true },
  },
  repeat_customers: {
    key: 'repeat_customers', label: 'Repeat customers', description: 'Two or more completed visits.',
    criteria: { minVisits: 2, requireContactable: true },
  },
  sms_subscribers: {
    key: 'sms_subscribers', label: 'SMS subscribers (opted in)', description: 'Customers with proven promotional-SMS consent — the only ones a text campaign can reach.',
    criteria: { requireSmsConsent: true, requireContactable: true },
  },
}

export function getNamedSegment(key: string): NamedSegment | null {
  return NAMED_SEGMENTS[key] ?? null
}

export function listNamedSegments(): NamedSegment[] {
  return Object.values(NAMED_SEGMENTS)
}

/** Resolve a campaign's segment definition (named key or ad-hoc criteria) to criteria. */
export function resolveSegmentCriteria(segmentKey: string | null | undefined, custom?: SegmentCriteria | null): SegmentCriteria {
  if (segmentKey) {
    const named = getNamedSegment(segmentKey)
    if (named) return named.criteria
  }
  return custom ?? { requireContactable: true }
}
