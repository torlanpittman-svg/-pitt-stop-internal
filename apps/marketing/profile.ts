/**
 * THE single source of Pitt Stop marketing knowledge. Every AI prompt (campaign copy, social
 * posts, comment replies) and the comment assistant read from here — brand facts are never
 * scattered across prompt strings. Operational toggles (send limits, attribution window, the
 * enable flag) live in app_settings (apps/settings/db.ts, keys prefixed `marketing_`); this file
 * holds the durable brand/company knowledge that rarely changes.
 *
 * Pricing here is GUIDANCE for tone and ballparking only. Condition-dependent work is never quoted
 * to a customer as an exact price by the AI — see guardrails.ts and the comment assistant.
 */

export interface ServiceKnowledge {
  category: 'ceramic' | 'paint_correction' | 'interior' | 'general'
  name: string
  /** One-line plain-English description for prompts + FAQ answers. */
  summary: string
  /** Rough price guidance — for internal tone only, NOT an exact customer quote. */
  priceGuidance: string
  /** Why a customer would want it (benefit framing). */
  benefit: string
}

export interface MarketingProfile {
  companyName: string
  shortName: string
  serviceArea: string
  hours: string
  phone: string
  website: string
  brandVoice: string[]
  avoid: string[]
  services: ServiceKnowledge[]
  faqs: { q: string; a: string }[]
  prohibitedClaims: string[]
  promotionalGuardrails: string[]
  /** Priority order of what to promote (business objective). */
  servicePriority: Array<ServiceKnowledge['category']>
}

export const MARKETING_PROFILE: MarketingProfile = {
  companyName: 'Pitt Stop Detail & Auto Sales',
  shortName: 'Pitt Stop',
  serviceArea: 'Central Texas',
  hours: 'Mon–Sat, by appointment and walk-in',
  phone: '',          // set via app_settings / env — never hard-coded as a claim
  website: 'pittstopdetail.com',

  brandVoice: [
    'knowledgeable and straightforward — explain the "why" behind the work',
    'locally owned and confident, not corporate',
    'honest: recommend what the vehicle actually needs, not the biggest ticket',
    'professional, never cheesy or hypey',
  ],
  avoid: [
    'excessive emojis or all-caps',
    'fake urgency ("ACT NOW", countdowns that are not real)',
    'misleading or invented discounts',
    'clickbait and spammy phrasing',
    'unsupported or absolute claims ("guaranteed", "permanent", "like new forever")',
  ],

  services: [
    {
      category: 'ceramic',
      name: 'Ceramic Coating',
      summary: 'A durable protective coating that bonds to the paint for easier washing and lasting gloss.',
      priceGuidance: '1-year around $800; 3-year around $2,000 (varies by size and prep needed).',
      benefit: 'Longer-term protection, easier maintenance, and a deep, lasting gloss.',
    },
    {
      category: 'paint_correction',
      name: 'Paint Correction',
      summary: 'Machine polishing that removes swirl marks, oxidation, and haze to restore the paint that is already there.',
      priceGuidance: 'Typically $500–$650+; larger or harder vehicles can be $750–$900+.',
      benefit: 'Removes swirls and restores gloss, especially visible on dark paint under sunlight.',
    },
    {
      category: 'interior',
      name: 'Premium Interior Detailing & Restoration',
      summary: 'Deep interior cleaning and restoration — stains, odor/ozone treatment, upholstery, headliners, carpet.',
      priceGuidance: 'Scoped to condition; premium interior work, not a $100 quick clean.',
      benefit: 'Resets a worn or odorous interior to a clean, well-cared-for condition.',
    },
    {
      category: 'general',
      name: 'Detailing',
      summary: 'Full-service exterior and interior detailing to keep a vehicle maintained between bigger services.',
      priceGuidance: 'Entry point into the higher-value services; not positioned as a cheap discount detail.',
      benefit: 'Keeps a vehicle clean and protected and opens the door to correction/coating when needed.',
    },
  ],

  faqs: [
    { q: 'hours', a: 'We are open Monday through Saturday, by appointment and walk-in. Send us a message and we will get you scheduled.' },
    { q: 'location', a: 'We are located in Central Texas. Reply here or send your phone number and we will share directions and availability.' },
    { q: 'trucks', a: 'Yes — we work on trucks, SUVs, and larger vehicles regularly. Pricing depends on size and condition; send a few photos or your year/make/model for a tighter estimate.' },
    { q: 'ceramic', a: 'Ceramic coating bonds to your paint for longer-term protection, easier washing, and lasting gloss. We can inspect your vehicle and tell you honestly whether it is a good fit.' },
    { q: 'paint_correction', a: 'Paint correction removes swirl marks, oxidation, and haze by machine-polishing the paint you already have. It makes the biggest difference on dark paint that looks swirled under sunlight.' },
    { q: 'stains', a: 'We handle most interior stains and odor with a deep interior detail and, when needed, ozone treatment. Send a photo of the problem area and we will tell you what is realistic.' },
    { q: 'estimate', a: 'For a tight estimate, send a few photos or your phone number and year/make/model. Condition drives the price, so photos help us get you an accurate number.' },
    { q: 'availability', a: 'We usually have a few openings each week. Reply with what you are looking to get done and we will find a time.' },
  ],

  prohibitedClaims: [
    'guaranteed results or "100%" outcomes',
    'permanent or forever protection',
    'exact prices for condition-dependent work sight-unseen',
    'removes all scratches / makes paint brand new',
    'comparisons that disparage named competitors',
  ],

  promotionalGuardrails: [
    'offers must be real and approved — never invent a discount',
    'no pressure tactics or fake scarcity',
    'personalize with the customer’s vehicle/last service only when it is actually known',
    'always invite a photo or inspection for condition-dependent work instead of quoting blind',
  ],

  servicePriority: ['ceramic', 'paint_correction', 'interior', 'general'],
}

/** Compact brand context block injected into AI prompts (keeps prompts lean + consistent). */
export function brandContext(profile: MarketingProfile = MARKETING_PROFILE): string {
  const services = profile.services
    .map((s) => `- ${s.name} (${s.category}): ${s.summary} Benefit: ${s.benefit}`)
    .join('\n')
  return [
    `Business: ${profile.companyName} (${profile.shortName}), ${profile.serviceArea}. Hours: ${profile.hours}.`,
    `Brand voice: ${profile.brandVoice.join('; ')}.`,
    `Avoid: ${profile.avoid.join('; ')}.`,
    `Services (promote in this priority: ${profile.servicePriority.join(' > ')}):`,
    services,
    `Never claim: ${profile.prohibitedClaims.join('; ')}.`,
    `Promotional rules: ${profile.promotionalGuardrails.join('; ')}.`,
  ].join('\n')
}

export function serviceKnowledge(category: string): ServiceKnowledge | null {
  return MARKETING_PROFILE.services.find((s) => s.category === category) ?? null
}
