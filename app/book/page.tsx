/**
 * PUBLIC customer booking (replaces the AutoLeap "Schedule a Drop-Off" / Google "Book online" link).
 * No employee auth and intentionally NOT in the proxy matcher. Only the customer-safe config is sent to
 * the browser. ?service=<key> preselects a service (website pricing-card deep links); utm_* / gclid /
 * fbclid / ps_cid / ref are captured for Marketing Agent attribution.
 */
import type { Metadata } from 'next'
import { getBookingConfig } from '@/apps/appointments/db'
import { ATTRIBUTION_KEYS } from '@/apps/appointments/attribution'
import BookingFlow from './BookingFlow'
import { flowProps } from './flow-props'

export const metadata: Metadata = {
  title: 'Schedule a Drop-Off — Pitt Stop Detail & Auto Sales',
  description: 'Book a drop-off time with Pitt Stop Detail & Auto Sales in College Station, TX.',
}
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function BookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const props = await flowProps(await getBookingConfig())
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
  const attribution = Object.fromEntries(ATTRIBUTION_KEYS.map((k) => [k, one(sp[k]).slice(0, 120)]).filter(([, v]) => v))
  const preselect = one(sp.service).split(',').filter((k) => props.services.some((s) => s.key === k))
  return <BookingFlow {...props} preselect={preselect} attribution={attribution} />
}
