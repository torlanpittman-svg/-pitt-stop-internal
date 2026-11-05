/**
 * "How did you hear about us?" — the customer's SELF-REPORTED answer, asked (optionally) at retail intake.
 *
 * Kept deliberately separate from captured attribution: a booking's gclid / utm_* / fbclid live in
 * appointments.attribution → marketing_attribution and prove a click happened; this value is only what the
 * customer said at the counter. Reporting shows both side by side and never merges them.
 */
export const REFERRAL_SOURCES = [
  { key: 'google',    label: 'Google (search or Maps)' },
  { key: 'social',    label: 'Facebook / Instagram / TikTok' },
  { key: 'referral',  label: 'Friend or family' },
  { key: 'returning', label: 'Been here before' },
  { key: 'drive_by',  label: 'Drove by / sign' },
  { key: 'business',  label: 'Dealer or business referral' },
  { key: 'other',     label: 'Other' },
] as const
export type ReferralSource = (typeof REFERRAL_SOURCES)[number]['key']

const KEYS = new Set<string>(REFERRAL_SOURCES.map((r) => r.key))

/** Accepts only a known key; anything else (blank, unknown, non-string) → null, i.e. "not answered". */
export function normalizeReferralSource(v: unknown): ReferralSource | null {
  if (typeof v !== 'string') return null
  const k = v.trim().toLowerCase()
  return KEYS.has(k) ? (k as ReferralSource) : null
}

export function referralSourceLabel(key: string | null | undefined): string {
  if (!key) return '—'
  return REFERRAL_SOURCES.find((r) => r.key === key)?.label ?? key
}
