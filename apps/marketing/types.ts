/**
 * Shared marketing vocabulary + view types. One place for the enums the whole module
 * agrees on (service categories, campaign/lead statuses, channels, attribution sources)
 * so the DB layer, AI layer, UI, and tests never drift.
 */

// ── Premium-service taxonomy (priority order mirrors the business objective) ──
export const SERVICE_CATEGORIES = ['ceramic', 'paint_correction', 'interior', 'general', 'brand', 'other'] as const
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]

/** Human labels for a category. */
export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  ceramic: 'Ceramic Coating',
  paint_correction: 'Paint Correction',
  interior: 'Interior Detailing',
  general: 'General Detailing',
  brand: 'Pitt Stop / Brand',
  other: 'Other',
}

/** The three premium services the whole strategy biases toward. */
export const PREMIUM_CATEGORIES: ServiceCategory[] = ['ceramic', 'paint_correction', 'interior']

// ── Channels ──
export const CHANNELS = ['sms', 'email', 'both'] as const
export type Channel = (typeof CHANNELS)[number]
export type SendChannel = 'sms' | 'email'

// ── Campaign lifecycle ──
export const CAMPAIGN_STATUSES = ['draft', 'ready', 'scheduled', 'sending', 'sent', 'paused', 'completed', 'cancelled'] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

export const CAMPAIGN_TYPES = ['reactivation', 'paint_correction_upsell', 'ceramic_upsell', 'interior', 'general', 'custom'] as const
export type CampaignType = (typeof CAMPAIGN_TYPES)[number]

// ── Recipients ──
export const RECIPIENT_STATUSES = ['pending', 'excluded', 'sent', 'failed', 'suppressed'] as const
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number]

// ── Social content ──
export const CONTENT_PILLARS = ['educate', 'proof', 'sell'] as const
export type ContentPillar = (typeof CONTENT_PILLARS)[number]

export const POST_STATUSES = ['idea', 'draft', 'approved', 'scheduled', 'posted', 'failed', 'archived'] as const
export type PostStatus = (typeof POST_STATUSES)[number]

// ── Leads ──
export const LEAD_STATUSES = ['new', 'contacted', 'estimate_needed', 'estimate_sent', 'booked', 'won', 'lost', 'no_response'] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

// ── Attribution ──
export const ATTRIBUTION_SOURCES = [
  'google_ads', 'google_organic', 'facebook_organic', 'facebook_paid',
  'sms', 'email', 'referral', 'walk_in', 'reactivation', 'unknown',
] as const
export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number]

export const ATTRIBUTION_CONFIDENCE = ['direct', 'assisted', 'unknown'] as const
export type AttributionConfidence = (typeof ATTRIBUTION_CONFIDENCE)[number]

// ── Channel buckets for reporting (where revenue/spend rolls up) ──
export const REPORT_CHANNELS = ['google_ads', 'facebook', 'sms_email', 'reactivation', 'organic', 'referral', 'other'] as const
export type ReportChannel = (typeof REPORT_CHANNELS)[number]

/** Map a raw attribution source to a reporting channel bucket. */
export function reportChannelForSource(source: string): ReportChannel {
  switch (source) {
    case 'google_ads': return 'google_ads'
    case 'facebook_organic':
    case 'facebook_paid': return 'facebook'
    case 'sms':
    case 'email': return 'sms_email'
    case 'reactivation': return 'reactivation'
    case 'google_organic': return 'organic'
    case 'referral': return 'referral'
    default: return 'other'
  }
}

export const REPORT_CHANNEL_LABELS: Record<ReportChannel, string> = {
  google_ads: 'Google Ads',
  facebook: 'Facebook',
  sms_email: 'SMS / Email',
  reactivation: 'Customer Reactivation',
  organic: 'Google Organic',
  referral: 'Referral',
  other: 'Other / Unknown',
}
