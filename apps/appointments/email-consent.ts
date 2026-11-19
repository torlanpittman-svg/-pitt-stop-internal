/**
 * Optional email-marketing permission on the PUBLIC booking form — a separate, UNCHECKED box. It is the only thing
 * that lets Pitt Stop send a customer follow-up/marketing email (e.g. Lead Recovery after a cancellation).
 * Appointment emails (confirmation, reminder, reschedule, cancellation) are operational notices and are NOT
 * affected by it either way. Ticking it appends an `opt_in` row to marketing_consent_events (channel 'email',
 * source 'website_form') with the exact wording, its version, the time, IP and browser — and the booking's own
 * append-only `booked` event records the choice too. PURE module: shared by the browser and the server.
 */
export const EMAIL_CONSENT_VERSION = 'booking-email-marketing-v1-2026-11-19'
export const EMAIL_CONSENT_TEXT = 'Email me follow-ups and occasional offers from Pitt Stop Detail & Auto Sales. I can unsubscribe at any time.'
