/**
 * "How did you hear about us?" on the PUBLIC booking form — REQUIRED (owner request 2026-11-07; optional for
 * staff phone entries). It is the customer's OWN answer, stored on appointments.referral_source/_detail
 * (migration 0077), copied to the marketing lead, and carried to the Job at check-in
 * (service_orders.referral_source — the same column Quick Entry fills at the counter).
 *
 * It is kept apart from captured click attribution (appointments.attribution: utm_* / gclid / fbclid / ref →
 * marketing_attribution). Neither value is ever derived from, or overwritten by, the other.
 *
 * Keys are the shared retail vocabulary (apps/quick-entry/referral-source.ts) so one report covers every
 * intake path; the labels here are the customer-facing wording for the booking page.
 */
import { normalizeReferralSource, referralSourceLabel, type ReferralSource } from '@/apps/quick-entry/referral-source'

export const BOOKING_REFERRAL_OPTIONS = [
  { key: 'google',    label: 'Google Search / Google Maps' },
  { key: 'facebook',  label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'referral',  label: 'Friend or Family' },
  { key: 'returning', label: 'Returning Customer' },
  { key: 'drive_by',  label: 'Drove By / Saw Our Sign' },
  { key: 'other',     label: 'Other' },
] as const satisfies ReadonlyArray<{ key: ReferralSource; label: string }>
export type BookingReferralKey = (typeof BOOKING_REFERRAL_OPTIONS)[number]['key']

export const BOOKING_REFERRAL_PLACEHOLDER = 'Select an option'
export const REFERRAL_DETAIL_MAX = 120
export const REFERRAL_REQUIRED_MESSAGE = 'Tell us how you heard about us.'
export const REFERRAL_DETAIL_MESSAGE = 'Please tell us where you heard about us.'

const BOOKING_KEYS = new Set<string>(BOOKING_REFERRAL_OPTIONS.map((o) => o.key))

/** What the form holds: the chosen key ('' = nothing yet) and the "Other" text. */
export interface ReferralAnswer { source: string; detail: string }
/** What the server stores: a booking option or null (not answered); detail trimmed and capped, kept only with a source. */
export interface BookingReferral { source: BookingReferralKey | null; detail: string }
export interface ReferralErrors { referral?: string; referralDetail?: string }

export function normalizeBookingReferral(raw: { source?: unknown; detail?: unknown }): BookingReferral {
  const k = normalizeReferralSource(raw.source)
  const source = k && BOOKING_KEYS.has(k) ? (k as BookingReferralKey) : null
  const detail = source && typeof raw.detail === 'string' ? raw.detail.trim().slice(0, REFERRAL_DETAIL_MAX) : ''
  return { source, detail }
}

/**
 * The ONE rule, run by the form before "Continue to review" and again by createAppointment: with `required`
 * (public bookings) an option must be chosen; "Other" always needs nonblank text. Keys match the form's field ids.
 */
export function validateBookingReferral(raw: { source?: unknown; detail?: unknown }, opts: { required: boolean }): ReferralErrors {
  const { source, detail } = normalizeBookingReferral(raw)
  if (!source) return opts.required ? { referral: REFERRAL_REQUIRED_MESSAGE } : {}
  if (source === 'other' && !detail) return { referralDetail: REFERRAL_DETAIL_MESSAGE }
  return {}
}

/** Customer-facing label for a stored key (falls back to the shared retail label for keys not offered online). */
export function bookingReferralLabel(key: string | null | undefined): string {
  if (!key) return referralSourceLabel(key)
  return BOOKING_REFERRAL_OPTIONS.find((o) => o.key === key)?.label ?? referralSourceLabel(key)
}

/** "Facebook" or "Other — church bulletin": how staff screens show the answer. */
export function referralSummary(a: { referralSource: string | null; referralDetail: string | null }): string {
  if (!a.referralSource) return ''
  return a.referralDetail ? `${bookingReferralLabel(a.referralSource)} — ${a.referralDetail}` : bookingReferralLabel(a.referralSource)
}
