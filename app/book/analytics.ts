/**
 * Privacy boundary for third-party analytics on the PUBLIC booking surfaces.
 *
 * The Google tag (GA4 / Google Ads) may load ONLY on the exact public paths /book and /quote.
 * It must never load on the private token routes (/book/a/<token> view/cancel, /book/r/<token>
 * resume): the tag's default page_view reports the full page URL
 * (https://developers.google.com/analytics/devguides/collection/ga4/views), which would hand the
 * access-bearing token to a third party. This gate only works because every transition between a
 * public page and a token route is a hard document navigation (plain <a href>, never next/link or
 * router.push) — enforced by analytics.test.ts; a client-side navigation would keep an already
 * loaded tag alive.
 *
 * On the allowed pages automatic page_views are disabled (send_page_view: false) and ONE sanitized
 * page_view is sent explicitly: page_location is origin + path with NO querystring whatsoever, and
 * page_referrer is the referrer's origin only (a foreign path could itself carry an access token,
 * e.g. a booking link under another alias) — and empty for same-origin referrers. The same
 * sanitized values are also pinned on each config as defense in depth: if the GA4 property has
 * Enhanced Measurement history tracking enabled (an admin setting this code cannot disable),
 * BookingFlow's same-URL pushState step tracking may still emit page_views, and pinned config
 * values are what they inherit. First-party attribution capture (apps/appointments/attribution.ts
 * → the booking/quote APIs) is unaffected by any of this.
 *
 * Consent behavior is deliberately untouched (no gtag('consent', …) calls — same as before).
 * Booking must never depend on analytics: every function here no-ops safely.
 */

/** Google tag ids (GA4 and/or Google Ads), baked at build time. Empty = analytics entirely off. */
export const TAG_IDS: readonly string[] = [process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID, process.env.NEXT_PUBLIC_GOOGLE_ADS_ID]
  .map((v) => (v || '').trim())
  .filter(Boolean)

/** Exact-path allowlist — every other path under /book (all token routes) stays untracked. */
const PUBLIC_ANALYTICS_PATHS = new Set(['/book', '/quote'])

export function isPublicAnalyticsPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return PUBLIC_ANALYTICS_PATHS.has(pathname.replace(/\/+$/, '') || '/')
}

/** Canonical page_location: origin + allowlisted path, never any query or hash. Marketing params
 *  (utm_* / gclid / …) are captured first-party by the booking API, not via this URL. */
export function sanitizedPageLocation(loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname.replace(/\/+$/, '') || '/'}`
}

/**
 * page_referrer must always be set explicitly — left unset, gtag falls back to document.referrer.
 * Same-origin referrers are dropped entirely (they can be private token URLs and carry no
 * attribution value); cross-origin referrers keep the ORIGIN only — a foreign path or query could
 * itself contain an access token or search-engine PII.
 */
export function sanitizedPageReferrer(referrer: string | null | undefined, origin: string): string {
  if (!referrer) return ''
  try {
    const u = new URL(referrer)
    return u.origin === origin ? '' : u.origin
  } catch {
    return ''
  }
}

type Gtag = (...args: unknown[]) => void

/** The slice of window this module touches — narrow so tests can pass a plain object. */
export interface AnalyticsWindow {
  location: { origin: string; pathname: string }
  document: { referrer: string }
  dataLayer?: unknown[]
  gtag?: Gtag
  /** Set once the tag has been configured for this document load. */
  __psBookGtagInit?: boolean
}

/**
 * Configure the Google tag for one allowed public page load and send the single sanitized
 * page_view. Returns the number of tag ids configured — 0 means skipped (nothing configured,
 * private/unknown path, already initialized, or an unexpected error: analytics must never break
 * the page).
 */
export function initBookAnalytics(tagIds: readonly string[], w: AnalyticsWindow): number {
  try {
    if (tagIds.length === 0) return 0
    if (!isPublicAnalyticsPath(w.location.pathname)) return 0
    if (w.__psBookGtagInit) return 0
    w.__psBookGtagInit = true
    const dataLayer = (w.dataLayer = w.dataLayer || [])
    if (typeof w.gtag !== 'function') {
      // gtag.js only processes `arguments` objects pushed onto the dataLayer — a plain array is ignored.
      // eslint-disable-next-line prefer-rest-params -- gtag's command queue expects an Arguments object.
      w.gtag = function () { dataLayer.push(arguments) }
    }
    const page = {
      page_location: sanitizedPageLocation(w.location),
      page_referrer: sanitizedPageReferrer(w.document.referrer, w.location.origin),
    }
    w.gtag('js', new Date())
    for (const id of tagIds) w.gtag('config', id, { ...page, send_page_view: false })
    w.gtag('event', 'page_view', page)
    return tagIds.length
  } catch {
    return 0
  }
}
