/**
 * Booking → Marketing Agent attribution. Reuses the EXISTING marketing funnel (marketing_leads +
 * append-only marketing_attribution + linkLeadOutcome); it adds no reporting of its own.
 *
 *   campaign/ad link (utm_*, gclid, fbclid, ps_cid) → booking → lead (status 'booked')
 *     → check-in links the lead to the real Job → completed/invoiced revenue (existing report)
 *
 * Never fakes a source: no parameters ⇒ 'unknown'.
 */
import type { AttributionSource } from '@/apps/marketing/types'

export const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'ps_cid', 'ref'] as const
export type BookingAttribution = Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>>

/** Keep only known keys, short, printable values. */
export function cleanAttribution(raw: unknown): BookingAttribution {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: BookingAttribution = {}
  for (const k of ATTRIBUTION_KEYS) {
    const v = r[k]
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().replace(/[^\w.\-:/@ +%]/g, '').slice(0, 120)
  }
  return out
}

/** Map booking parameters onto the Marketing Agent's source vocabulary. */
export function classifySource(a: BookingAttribution): AttributionSource {
  const src = (a.utm_source ?? '').toLowerCase()
  const med = (a.utm_medium ?? '').toLowerCase()
  const paid = /cpc|ppc|paid|ads?$/.test(med)
  if (a.gclid || (src.includes('google') && paid)) return 'google_ads'
  if (a.fbclid && !src) return 'facebook_paid'
  if (/facebook|fb|instagram|meta|ig/.test(src)) return paid || a.fbclid ? 'facebook_paid' : 'facebook_organic'
  if (/google|gbp|gmb|maps/.test(src)) return 'google_organic'
  if (src === 'website') return 'website' // the shop's own WordPress site (utm_source=website on its Book buttons)
  if (src === 'sms' || med === 'sms') return 'sms'
  if (src === 'email' || med === 'email' || src === 'mailerlite') return 'email'
  if (src === 'referral' || med === 'referral') return 'referral'
  if (src === 'reactivation' || a.utm_campaign?.toLowerCase().includes('reactivation')) return 'reactivation'
  return 'unknown'
}

/** 'direct' only when a parameter actually names the channel; otherwise honest 'unknown'. */
export function attributionConfidence(a: BookingAttribution): 'direct' | 'unknown' {
  return classifySource(a) === 'unknown' ? 'unknown' : 'direct'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const campaignIdFrom = (a: BookingAttribution): string | null => (a.ps_cid && UUID.test(a.ps_cid) ? a.ps_cid.toLowerCase() : null)
