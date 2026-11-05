/**
 * Client-safe constants and types for the public quote form (/quote).
 * This file must stay free of server-only imports (no DB, no email provider, no node: modules):
 * app/quote/QuoteForm.tsx is a client component and imports it directly.
 */
import type { ReferralSource } from '@/apps/quick-entry/referral-source'

export const QUOTE_SERVICES = {
  ceramic:   { label: 'Ceramic coating', category: 'ceramic' },
  headliner: { label: 'Headliner repair or replacement', category: 'headliner' },
  other:     { label: 'Other detailing', category: 'other' },
} as const
export type QuoteService = keyof typeof QUOTE_SERVICES

export const MAX_PHOTOS = 2
export const MAX_PHOTO_BYTES = 1_200_000          // after client-side downscale; keeps the request well under Vercel's body cap

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
}
export type QuoteErrors = Partial<Record<keyof QuoteRequest | 'form', string>>
