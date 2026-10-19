/**
 * PUBLIC customer booking (replaces the AutoLeap "Schedule a Drop-Off" / Google "Book online" link).
 * No employee auth and intentionally NOT in the proxy matcher. Only the customer-safe config is sent to
 * the browser. ?service=<key> preselects a service (website pricing-card deep links); utm_* / gclid /
 * fbclid / ps_cid / ref are captured for Marketing Agent attribution.
 */
import type { Metadata } from 'next'
import { getBookingConfig } from '@/apps/appointments/db'
import { publicBookingOpen } from '@/apps/appointments/policy'
import { ATTRIBUTION_KEYS } from '@/apps/appointments/attribution'
import { getMarketingConfig } from '@/apps/settings/db'
import { a2pProfile, optInCheckboxLabel } from '@/apps/marketing/compliance'
import BookingFlow from './BookingFlow'

export const metadata: Metadata = {
  title: 'Book a Drop-Off — Pitt Stop Detail & Auto Sales',
  description: 'Book a confirmed drop-off time with Pitt Stop Detail & Auto Sales in College Station.',
}
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function BookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const cfg = await getBookingConfig()
  const p = a2pProfile(await getMarketingConfig())
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
  const attribution = Object.fromEntries(ATTRIBUTION_KEYS.map((k) => [k, one(sp[k]).slice(0, 120)]).filter(([, v]) => v))
  const services = cfg.services.filter((s) => s.enabled).map((s) => ({ key: s.key, label: s.label, description: s.description }))
  const preselect = one(sp.service).split(',').filter((k) => services.some((s) => s.key === k))

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <BookingFlow
        open={publicBookingOpen(cfg)}
        services={services}
        preselect={preselect}
        attribution={attribution}
        shop={{ title: cfg.title, intro: cfg.intro, phone: cfg.phone, address: cfg.address, instructions: cfg.instructions, cancellationPolicy: cfg.cancellationPolicy }}
        smsLabel={optInCheckboxLabel(p)}
        privacyUrl="/privacy"
        termsUrl="/terms"
      />
    </main>
  )
}
