/**
 * "Estimate requested" measurement for /quote — client side, fired by QuoteForm exactly once per NEW
 * request (the API returns replayed=true on an idempotent retry, and nothing fires then).
 *
 * Same config and same privacy boundary as app/book/conversion.ts (GA4 id, optional direct Google Ads
 * conversion). The payload carries ONLY the damage/service type and the request's opaque lead id as
 * transaction_id — never a name, phone, email, vehicle, message or photo. Mark `quote_requested` a key
 * event in GA4 and import it into Google Ads as the restoration campaigns' primary conversion.
 */
import { GA_MEASUREMENT_ID } from '@/app/book/conversion'

export const QUOTE_EVENT = 'quote_requested'
export const QUOTE_CONVERSION_SEND_TO = process.env.NEXT_PUBLIC_GOOGLE_ADS_QUOTE_CONVERSION || ''

type Gtag = (...args: unknown[]) => void
export interface QuoteConversionConfig { ga?: string; sendTo?: string }

/** Returns the number of events sent (0 when nothing is configured or gtag.js is not loaded). */
export function fireQuoteConversion(
  input: { leadId?: string | null; service: string; replayed?: boolean },
  w: { gtag?: Gtag } = typeof window === 'undefined' ? {} : (window as unknown as { gtag?: Gtag }),
  cfg: QuoteConversionConfig = { ga: GA_MEASUREMENT_ID, sendTo: QUOTE_CONVERSION_SEND_TO },
): number {
  if (input.replayed) return 0                       // a retry of an already-recorded request is not a new lead
  if (typeof w.gtag !== 'function') return 0
  const params = { ...(input.leadId ? { transaction_id: input.leadId } : {}), service_type: input.service }
  let n = 0
  try {
    if (cfg.ga) { w.gtag('event', QUOTE_EVENT, { send_to: cfg.ga, ...params }); n++ }
    if (cfg.sendTo) { w.gtag('event', 'conversion', { send_to: cfg.sendTo, ...params }); n++ }
  } catch { /* measurement must never break the request flow */ }
  return n
}
