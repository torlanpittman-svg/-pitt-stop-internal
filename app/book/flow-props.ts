/** Server-side props shared by /book and /book/r/<token>: only customer-safe config reaches the browser. */
import type { BookingConfig } from '@/apps/appointments/policy'
import { publicBookingOpen } from '@/apps/appointments/policy'
import { getMarketingConfig } from '@/apps/settings/db'
import { a2pProfile, optInCheckboxLabel } from '@/apps/marketing/compliance'
import { yearsFor } from '@/apps/appointments/vehicles'
import { SAVE_NOTICE_TEXT, FOLLOW_UP_CONSENT_TEXT } from '@/apps/appointments/drafts'

export async function flowProps(cfg: BookingConfig) {
  const p = a2pProfile(await getMarketingConfig())
  return {
    open: publicBookingOpen(cfg),
    services: cfg.services.filter((s) => s.enabled).map((s) => ({ key: s.key, label: s.label, description: s.description })),
    shop: { title: cfg.title, intro: cfg.intro, phone: cfg.phone, address: cfg.address, instructions: cfg.instructions, cancellationPolicy: cfg.cancellationPolicy },
    years: yearsFor(),
    smsLabel: optInCheckboxLabel(p),
    privacyUrl: '/privacy',
    termsUrl: '/terms',
    saveNotice: SAVE_NOTICE_TEXT,
    followUpText: FOLLOW_UP_CONSENT_TEXT,
  }
}
