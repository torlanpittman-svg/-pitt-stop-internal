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
import { normalizeReferralSource, referralSourceLabel } from '@/apps/quick-entry/referral-source'

/** `lp` = the landing-page slug the shop's own pages append to their estimate links (e.g. lp=car-overspray-removal). */
export const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'ps_cid', 'ref', 'lp'] as const
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
  // `lp` is appended ONLY by the shop's own landing pages: with no other channel signal it is a website visit.
  if (a.lp && !src && !med) return 'website'
  return 'unknown'
}

/** 'direct' only when a parameter actually names the channel; otherwise honest 'unknown'. */
export function attributionConfidence(a: BookingAttribution): 'direct' | 'unknown' {
  return classifySource(a) === 'unknown' ? 'unknown' : 'direct'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const campaignIdFrom = (a: BookingAttribution): string | null => (a.ps_cid && UUID.test(a.ps_cid) ? a.ps_cid.toLowerCase() : null)

// ── Staff-facing display ─────────────────────────────────────────────────────────────────────────────────
// Plain-English reading of the tags STORED on a booking (appointments.attribution). Presentation only: it
// never changes what is collected or stored, and it is deliberately separate from classifySource() above,
// whose vocabulary feeds the marketing_attribution ledger and the reports and must not shift under them.
//
// Rules the wording follows:
//   • Click evidence (gclid) outranks the generic utm_source=website tag — that tag only says which button on
//     the shop's site was pressed, never how the visitor reached the site.
//   • A website tag alone is NOT called organic; a Facebook/Instagram tag alone is NOT called paid.
//   • Only placements the website snippet actually emits are translated; anything else is shown as-is.
//   • The customer's own "How did you hear about us?" answer is a second, independent line.

export type TrackedSourceKind =
  | 'google_ads' | 'google_maps' | 'facebook' | 'instagram' | 'facebook_instagram'
  | 'email' | 'sms' | 'website' | 'other' | 'unknown'

/** utm_content values the shop's website booking snippet sets on its own Book buttons (data-ps-book). */
export const PLACEMENT_LABELS: Record<string, string> = {
  hero: 'Top booking button',
  header: 'Header booking button',
  sticky_header: 'Sticky header booking button',
  mobile_bar: 'Mobile bottom bar',
  service_card: 'Service section button',
  product: 'Product page button',
  after_reviews: 'Prompt after reviews',
  page_end: 'End-of-page prompt',
  content: 'Link in page content',
}

export type BookingSourceDisplay = {
  kind: TrackedSourceKind
  /** e.g. "Google Ads", "Website — original source unknown", "Unknown / untracked". */
  trackedSource: string
  /** e.g. "Website — top booking button". Null when the booking carries no website-button tag. */
  entryPoint: string | null
  /** Every stored tag, untouched, for the collapsed "Tracking details". */
  details: Array<{ key: string; value: string }>
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** A stored tag as a readable name: "fall_special-2026" → "Fall Special 2026". Never invents meaning. */
export function readableTag(raw: string): string {
  let s = raw.trim()
  try { s = decodeURIComponent(s) } catch { /* keep the stored text */ }
  return s.replace(/[_+\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    .split(' ').map((w) => (/^[a-z]/.test(w) && w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

/** Lower-cased keys, trimmed non-empty string values. Tolerates null / arrays / non-string junk. */
function usableTags(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k.trim().toLowerCase()] = v.trim()
  }
  return out
}

function storedDetails(raw: unknown): Array<{ key: string; value: string }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const order = (k: string) => { const i = (ATTRIBUTION_KEYS as readonly string[]).indexOf(k.trim().toLowerCase()); return i < 0 ? ATTRIBUTION_KEYS.length : i }
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v) }))
    .sort((a, b) => order(a.key) - order(b.key))
}

export function describeBookingSource(raw: unknown): BookingSourceDisplay {
  const t = usableTags(raw)
  const src = (t.utm_source ?? '').toLowerCase()
  const med = (t.utm_medium ?? '').toLowerCase()
  const words = new Set(src.split(/[^a-z0-9]+/).filter(Boolean)) // whole words only: "digital" is not "ig"
  const compact = src.replace(/[^a-z0-9]/g, '')
  const has = (...w: string[]) => w.some((x) => words.has(x))
  const paidMedium = /cpc|ppc|paid|ads?$/.test(med)
  const websiteTag = src === 'website' || !!t.lp

  let kind: TrackedSourceKind
  let trackedSource: string
  const fb = has('facebook', 'fb'), ig = has('instagram', 'ig', 'insta')
  if (t.gclid || (has('google') && paidMedium) || compact === 'googleads' || compact === 'adwords') {
    kind = 'google_ads'; trackedSource = 'Google Ads'
  } else if (fb && !ig) { kind = 'facebook'; trackedSource = 'Facebook' }
  else if (ig && !fb) { kind = 'instagram'; trackedSource = 'Instagram' }
  else if ((fb && ig) || has('meta') || (t.fbclid && (!src || src === 'website'))) {
    kind = 'facebook_instagram'; trackedSource = 'Facebook / Instagram' // an fbclid cannot tell the two apart
  } else if (has('gbp', 'gmb', 'maps') || ['googlemaps', 'googlebusinessprofile', 'googlemybusiness'].includes(compact)
    || (has('google') && /^(gbp|gmb|maps|business[_ -]?profile)$/.test(med))) {
    kind = 'google_maps'; trackedSource = 'Google Maps / Business Profile'
  } else if (has('sms', 'text') || med === 'sms' || med === 'text') { kind = 'sms'; trackedSource = 'Text campaign' }
  else if (has('email', 'mailerlite', 'newsletter') || med === 'email' || med === 'newsletter') { kind = 'email'; trackedSource = 'Email campaign' }
  else if (websiteTag && (src === 'website' || (!src && !med))) { kind = 'website'; trackedSource = 'Website — original source unknown' }
  else {
    const name = src ? readableTag(t.utm_source)
      : t.ref ? readableTag(t.ref)
      : t.ps_cid ? 'Pitt Stop campaign link'
      : t.utm_campaign ? `campaign “${readableTag(t.utm_campaign)}”`
      : med ? readableTag(t.utm_medium)
      : ''
    if (name) { kind = 'other'; trackedSource = `Other tracked source — ${name}` }
    else { kind = 'unknown'; trackedSource = 'Unknown / untracked' }
  }

  let entryPoint: string | null = null
  if (websiteTag) {
    const placement = (t.utm_content ?? '').toLowerCase().replace(/[\s-]+/g, '_')
    const known = PLACEMENT_LABELS[placement]
    if (src === 'website' && known) entryPoint = `Website — ${lowerFirst(known)}`
    else if (src === 'website' && t.utm_content) entryPoint = `Website — unrecognized button tag “${t.utm_content.slice(0, 60)}”`
    else if (t.lp) entryPoint = `Website — landing page “${t.lp.slice(0, 60)}”`
    else if (kind !== 'website') entryPoint = 'Website'
  }

  return { kind, trackedSource, entryPoint, details: storedDetails(raw) }
}

/**
 * The customer's own "How did you hear about us?" answer, worded for staff. Null = not asked / not answered.
 * Independent of describeBookingSource(): neither ever replaces the other.
 */
export function customerSaidLabel(source: string | null | undefined, detail?: string | null): string | null {
  const key = (source ?? '').trim()
  const extra = (detail ?? '').trim()
  if (!key && !extra) return null
  const known = normalizeReferralSource(key)
  const label = known ? referralSourceLabel(known) : key ? readableTag(key) : ''
  return [label, extra].filter(Boolean).join(' — ')
}
