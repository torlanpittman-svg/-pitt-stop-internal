/**
 * Client-safe constants and types for the public quote / estimate request form (/quote).
 * This file must stay free of server-only imports (no DB, no email provider, no node: modules):
 * app/quote/QuoteForm.tsx is a client component and imports it directly.
 *
 * 2026-11-07: insurance-restoration damage types added (vandalism / overspray / water damage / glass). They share the
 * ONE existing funnel (quote_requests → marketing_leads → shop inbox); nothing parallel. Restoration requests also
 * carry a self-declared claim status and an optional incident date — never an insurer name, policy or claim number.
 */
import type { ReferralSource } from '@/apps/quick-entry/referral-source'

export const QUOTE_SERVICES = {
  // ── Insurance-related restoration (acquisition project) ──
  vandalism:    { label: 'Vandalism or break-in restoration', category: 'restoration', group: 'restoration', slug: 'car-vandalism-repair' },
  overspray:    { label: 'Paint overspray removal',           category: 'restoration', group: 'restoration', slug: 'car-overspray-removal' },
  water_damage: { label: 'Water damage restoration',          category: 'restoration', group: 'restoration', slug: 'car-water-damage' },
  glass:        { label: 'Broken glass + interior cleanup',   category: 'restoration', group: 'restoration', slug: 'auto-glass-repair' },
  // ── Everything the form already offered ──
  ceramic:      { label: 'Ceramic coating',                   category: 'ceramic',     group: 'detailing',   slug: null },
  headliner:    { label: 'Headliner repair or replacement',   category: 'headliner',   group: 'detailing',   slug: null },
  other:        { label: 'Other detailing',                   category: 'other',       group: 'detailing',   slug: null },
} as const
export type QuoteService = keyof typeof QUOTE_SERVICES
export type QuoteServiceGroup = (typeof QUOTE_SERVICES)[QuoteService]['group']

/** Damage types = the restoration services, in display order. */
export const RESTORATION_SERVICES = (Object.keys(QUOTE_SERVICES) as QuoteService[]).filter((k) => QUOTE_SERVICES[k].group === 'restoration')
export const isRestorationService = (s: QuoteService): boolean => QUOTE_SERVICES[s].group === 'restoration'

/**
 * Customer-declared insurance claim status. Informational only: it changes nothing about pricing or the
 * estimate and is never a promise of coverage. `null` = not asked (non-restoration services) or not answered.
 */
export const CLAIM_STATUSES = [
  { key: 'not_filed',   label: 'I have not contacted my insurance' },
  { key: 'considering', label: 'Deciding whether to file a claim' },
  { key: 'filed',       label: 'Claim filed, waiting on the adjuster' },
  { key: 'approved',    label: 'Claim approved' },
  { key: 'paying_self', label: 'Paying out of pocket' },
  { key: 'unsure',      label: 'Not sure yet' },
] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]['key']

export const MAX_PHOTOS = 4
export const MAX_PHOTO_BYTES = 1_000_000          // after client-side downscale; 4 × 1 MB keeps the JSON body under Vercel's request cap

export interface QuotePhoto { name: string; contentType: string; contentBase64: string }
export interface QuoteRequest {
  service: QuoteService
  name: string
  phone: string
  email: string
  vehicleYear: string
  vehicleMake: string
  vehicleModel: string
  message: string
  photos: QuotePhoto[]
  /** Optional self-reported answer; null = not answered. */
  referralSource: ReferralSource | null
  referralDetail: string
  /** Restoration only. null for other services or when not answered. */
  claimStatus: ClaimStatus | null
  /** Restoration only, optional: YYYY-MM-DD the damage happened / was discovered, or ''. */
  incidentDate: string
}
export type QuoteErrors = Partial<Record<keyof QuoteRequest | 'form', string>>

/** Headline + helper copy per service for the public form (kept here so the server email can reuse labels). */
export const QUOTE_PROMPTS: Record<QuoteService, { messageLabel: string; messageHint?: string }> = {
  vandalism:    { messageLabel: 'What happened, and what do you see?', messageHint: 'Keyed panels, broken glass inside, torn seats, spray paint, odor — anything you noticed. A police report number is helpful for your claim but not needed for the estimate.' },
  overspray:    { messageLabel: 'Where is the overspray, and do you know the source?', messageHint: 'Which panels and glass are affected, how long it has been on, and whether a contractor or nearby painting job caused it.' },
  water_damage: { messageLabel: 'How did the water get in, and how wet is it now?', messageHint: 'Rain through an open window or sunroof, a leak, or rising water. Tell us how high the water got — water above the seat bottoms or into the dash changes what we can do.' },
  glass:        { messageLabel: 'Which window is broken, and is the glass still inside?', messageHint: 'Side, rear or quarter glass; whether the opening is covered; glass in seats, carpet or vents.' },
  ceramic:      { messageLabel: 'Anything we should know? (paint condition, scratches, how the car is kept)' },
  headliner:    { messageLabel: 'What’s happening with the headliner? (sagging, torn, stained, how much of it)' },
  other:        { messageLabel: 'What would you like done?' },
}
