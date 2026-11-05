/**
 * "Booking confirmed" measurement — client side, fired by BookingFlow exactly once per NEW appointment
 * (the API returns created=false on an idempotent replay, and nothing fires then).
 *
 * Config (public, baked at build time; all optional — unset = that part is simply not loaded/sent):
 *   NEXT_PUBLIC_GA_MEASUREMENT_ID             G-XXXXXXX  → the website's GA4 property. The booking page sends a
 *                                                          `booking_confirmed` event; mark it a KEY EVENT in GA4 and
 *                                                          import it into Google Ads (the way this account measures
 *                                                          every other website conversion).
 *   NEXT_PUBLIC_GOOGLE_ADS_ID                 AW-XXXXXXX → optional direct Google Ads tag.
 *   NEXT_PUBLIC_GOOGLE_ADS_BOOKING_CONVERSION AW-XXXXXXX/AbCdEf → optional direct conversion send_to.
 *
 * transaction_id = the appointment reference. Caveat: GA4 only guarantees transaction_id
 * de-duplication for the standard `purchase` event — on a custom event like `booking_confirmed` it
 * is an identifying parameter, not a guaranteed de-dupe. Single-fire therefore rests on the
 * created=true gate in BookingFlow above all. A direct Google Ads conversion can also use the
 * transaction ID for duplicate detection; its Count setting is a separate configuration.
 */
export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || ''
export const GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID || ''
export const BOOKING_CONVERSION_SEND_TO = process.env.NEXT_PUBLIC_GOOGLE_ADS_BOOKING_CONVERSION || ''
export const BOOKING_EVENT = 'booking_confirmed'

type Gtag = (...args: unknown[]) => void
export interface ConversionConfig { ga?: string; sendTo?: string }

/** Returns the number of events sent (0 when nothing is configured or gtag.js is not loaded). */
export function fireBookingConversion(
  reference: string | undefined | null,
  w: { gtag?: Gtag } = typeof window === 'undefined' ? {} : (window as unknown as { gtag?: Gtag }),
  cfg: ConversionConfig = { ga: GA_MEASUREMENT_ID, sendTo: BOOKING_CONVERSION_SEND_TO },
): number {
  if (typeof w.gtag !== 'function') return 0
  const id = reference ? { transaction_id: reference } : {}
  let n = 0
  try {
    if (cfg.ga) { w.gtag('event', BOOKING_EVENT, { send_to: cfg.ga, ...id }); n++ }
    if (cfg.sendTo) { w.gtag('event', 'conversion', { send_to: cfg.sendTo, ...id }); n++ }
  } catch { /* measurement must never break the booking flow */ }
  return n
}
