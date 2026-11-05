/**
 * Public quote requests (ceramic coating / headliner / other) from /quote.
 *
 * One path, no new infrastructure:
 *   validate → marketing_leads row (always, so nothing is lost) → email to the shop's quote inbox through the
 *   SAME Postmark transactional provider the booking notices use (apps/appointments/notify.ts), with
 *   Reply-To = the customer's address so a reply from the inbox goes straight back to them → the caller
 *   reports honestly whether the email was accepted by Postmark (the lead is saved either way).
 *
 * Click attribution (gclid / utm_*) is recorded against the lead in marketing_attribution; the customer's
 * own words never touch it. The optional "How did you hear about us?" answer is stored on the lead row
 * (referral_source / referral_detail) as what the customer SAID — reported beside, never merged with, attribution.
 */
import { createLead } from './leads'
import { recordAttribution } from './attribution'
import { cleanAttribution, classifySource, attributionConfidence, type BookingAttribution } from '@/apps/appointments/attribution'
import { isValidUsPhone, isValidEmail, formatUsPhone } from '@/apps/appointments/contact'
import { transactionalEmailProvider, type TransactionalEmailProvider, type EmailAttachment } from '@/apps/appointments/notify'
import { normalizeReferralSource, referralSourceLabel, type ReferralSource } from '@/apps/quick-entry/referral-source'

export const QUOTE_SERVICES = {
  ceramic:   { label: 'Ceramic coating', category: 'ceramic' },
  headliner: { label: 'Headliner repair or replacement', category: 'headliner' },
  other:     { label: 'Other detailing', category: 'other' },
} as const
export type QuoteService = keyof typeof QUOTE_SERVICES

/** Where quote requests are delivered. Override with QUOTE_INBOX; the default is the monitored shop group. */
export const DEFAULT_QUOTE_INBOX = 'service@pittstopbcs.com'
export const quoteInbox = (env: NodeJS.ProcessEnv = process.env): string => (env.QUOTE_INBOX ?? '').trim() || DEFAULT_QUOTE_INBOX

export const MAX_PHOTOS = 2
export const MAX_PHOTO_BYTES = 1_200_000          // after client-side downscale; keeps the request well under Vercel's body cap
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

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

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Normalises + validates an untrusted body. Returns the clean request or field errors — never both. */
export function parseQuoteRequest(body: unknown): { ok: true; req: QuoteRequest } | { ok: false; errors: QuoteErrors } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const errors: QuoteErrors = {}
  const service = str(b.service, 20) as QuoteService
  if (!(service in QUOTE_SERVICES)) errors.service = 'Choose a service.'
  const name = str(b.name, 80)
  if (name.length < 2) errors.name = 'Enter your name.'
  const phone = str(b.phone, 40)
  if (!isValidUsPhone(phone)) errors.phone = 'Enter a 10-digit phone number.'
  const email = str(b.email, 240).toLowerCase()
  if (!isValidEmail(email)) errors.email = 'Enter a valid email so we can send your quote.'
  const vehicleYear = str(b.vehicleYear, 4)
  if (!/^(19|20)\d\d$/.test(vehicleYear)) errors.vehicleYear = 'Enter the vehicle year.'
  const vehicleMake = str(b.vehicleMake, 40)
  if (!vehicleMake) errors.vehicleMake = 'Enter the make.'
  const vehicleModel = str(b.vehicleModel, 40)
  if (!vehicleModel) errors.vehicleModel = 'Enter the model.'
  const message = str(b.message, 1500)
  const referralSource = normalizeReferralSource(b.referralSource)
  const referralDetail = referralSource ? str(b.referralDetail, 120) : ''
  const rawPhotos = Array.isArray(b.photos) ? b.photos : []
  if (rawPhotos.length > MAX_PHOTOS) errors.photos = `Up to ${MAX_PHOTOS} photos.`
  const photos: QuotePhoto[] = []
  for (const p of rawPhotos.slice(0, MAX_PHOTOS)) {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    const contentType = str(o.contentType, 20)
    const contentBase64 = typeof o.contentBase64 === 'string' ? o.contentBase64.replace(/\s+/g, '') : ''
    if (!PHOTO_TYPES.has(contentType) || !/^[A-Za-z0-9+/=]+$/.test(contentBase64)) { errors.photos = 'Photos must be JPEG, PNG or WebP.'; continue }
    if (contentBase64.length * 0.75 > MAX_PHOTO_BYTES) { errors.photos = 'Each photo must be under about 1 MB.'; continue }
    photos.push({ name: str(o.name, 80).replace(/[^\w.-]+/g, '_') || `photo-${photos.length + 1}.jpg`, contentType, contentBase64 })
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, req: { service, name, phone: formatUsPhone(phone), email, vehicleYear, vehicleMake, vehicleModel, message, photos, referralSource, referralDetail } }
}

export const vehicleLabel = (r: Pick<QuoteRequest, 'vehicleYear' | 'vehicleMake' | 'vehicleModel'>) => [r.vehicleYear, r.vehicleMake, r.vehicleModel].filter(Boolean).join(' ')

/** "Ceramic coating quote request — 2020 Cadillac XT6 — Jane Doe" */
export function quoteSubject(r: QuoteRequest): string {
  return `${QUOTE_SERVICES[r.service].label} quote request — ${vehicleLabel(r)} — ${r.name}`
}

export function quoteEmailText(r: QuoteRequest, meta: { leadId: string; source: string; receivedAt: Date }): string {
  const lines = [
    `New quote request from the website (${QUOTE_SERVICES[r.service].label}).`,
    '',
    `Name:     ${r.name}`,
    `Phone:    ${r.phone}`,
    `Email:    ${r.email}   (reply to this email to answer the customer)`,
    `Vehicle:  ${vehicleLabel(r)}`,
    `Service:  ${QUOTE_SERVICES[r.service].label}`,
    '',
    'Customer notes:',
    r.message || '(none)',
    '',
    `Heard about us (customer's own answer): ${r.referralSource ? referralSourceLabel(r.referralSource) + (r.referralDetail ? ` — ${r.referralDetail}` : '') : '(not answered)'}`,
    '',
    r.photos.length ? `${r.photos.length} photo(s) attached.` : 'No photos attached.',
    '',
    `Received ${meta.receivedAt.toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT · source: ${meta.source} · lead ${meta.leadId}`,
  ]
  return lines.join('\n')
}

export interface SubmitResult { leadId: string; emailed: 'sent' | 'failed' | 'not_configured' | 'uncertain' | 'blocked'; inbox: string; error?: string | null }

export async function submitQuoteRequest(
  req: QuoteRequest,
  rawAttribution: unknown,
  deps: { provider?: TransactionalEmailProvider; now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<SubmitResult> {
  const now = deps.now ?? new Date()
  const attribution: BookingAttribution = cleanAttribution(rawAttribution)
  const source = classifySource(attribution)
  const lead = await createLead({
    name: req.name, phone: req.phone, email: req.email, vehicle: vehicleLabel(req),
    requestedService: QUOTE_SERVICES[req.service].category, source,
    referralSource: req.referralSource, referralDetail: req.referralDetail || null,
    notes: [`Quote request via /quote`, req.message ? `Customer notes: ${req.message}` : null, req.photos.length ? `${req.photos.length} photo(s) emailed` : null].filter(Boolean).join('\n'),
  }, 'website:quote')
  if (attribution.gclid || attribution.utm_source || attribution.fbclid) {
    await recordAttribution({
      source, medium: attribution.utm_medium ?? null, campaign: attribution.utm_campaign ?? null,
      utmSource: attribution.utm_source ?? null, utmMedium: attribution.utm_medium ?? null, utmCampaign: attribution.utm_campaign ?? null,
      clickId: attribution.gclid ?? attribution.fbclid ?? null, confidence: attributionConfidence(attribution), leadId: lead.id, occurredAt: now,
    }, 'website:quote').catch(() => undefined) // attribution is a bonus — never blocks the request
  }
  const provider = deps.provider ?? transactionalEmailProvider(deps.env ?? process.env)
  const inbox = quoteInbox(deps.env ?? process.env)
  const attachments: EmailAttachment[] = req.photos.map((p) => ({ name: p.name, contentType: p.contentType, contentBase64: p.contentBase64 }))
  const result = await provider.send({ to: inbox, subject: quoteSubject(req), text: quoteEmailText(req, { leadId: lead.id, source, receivedAt: now }), replyTo: req.email, attachments })
  const emailed: SubmitResult['emailed'] = result.status === 'sent' ? 'sent'
    : result.status === 'not_configured' ? 'not_configured'
    : result.status === 'uncertain' ? 'uncertain'
    : result.status === 'blocked' ? 'blocked' : 'failed'
  const error = result.status === 'failed' || result.status === 'uncertain' ? result.error : result.status === 'blocked' ? result.reason : null
  return { leadId: lead.id, emailed, inbox, error }
}
