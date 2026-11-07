/**
 * PUBLIC quote / estimate request — /quote?service=<QuoteService> (+ utm_* / gclid / lp captured like /book).
 * ?service=vandalism|overspray|water_damage|glass are the insurance-restoration damage types the five
 * website landing pages link to (website/wordpress/insurance-restoration); the heading, copy and metadata
 * switch to "estimate" language for them. No employee auth; served on the booking host too
 * (apps/appointments/public-host.ts). Nothing here states a price or promises insurance coverage: estimates
 * are written by the shop after reviewing the vehicle and photos.
 */
import type { Metadata } from 'next'
import { getBookingConfig } from '@/apps/appointments/db'
import { ATTRIBUTION_KEYS } from '@/apps/appointments/attribution'
import { QUOTE_SERVICES, isRestorationService, type QuoteService } from '@/apps/marketing/quote-shared'
import { BookShell } from '@/app/book/BookShell'
import QuoteForm from './QuoteForm'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type SP = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
// Object.hasOwn, not `in`: ?service=toString / __proto__ must fall back, not leak an inherited key.
const pickService = (svc: string): QuoteService => (Object.hasOwn(QUOTE_SERVICES, svc) ? svc : 'ceramic') as QuoteService

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const svc = pickService(one((await searchParams).service))
  if (isRestorationService(svc)) {
    return {
      title: `Request an Estimate — ${QUOTE_SERVICES[svc].label} — Pitt Stop Detail & Auto Sales`,
      description: `Request a written, itemized ${QUOTE_SERVICES[svc].label.toLowerCase()} estimate from Pitt Stop Detail & Auto Sales in Bryan–College Station, TX. Upload photos and we will reply with next steps.`,
      robots: { index: false, follow: true }, // the WordPress landing pages are the indexable surface; the form is the destination
    }
  }
  return {
    title: 'Request a Quote — Pitt Stop Detail & Auto Sales',
    description: 'Request a ceramic coating or headliner quote from Pitt Stop Detail & Auto Sales in Bryan–College Station, TX.',
  }
}

export default async function QuotePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams
  const cfg = await getBookingConfig()
  const attribution = Object.fromEntries(ATTRIBUTION_KEYS.map((k) => [k, one(sp[k]).slice(0, 120)]).filter(([, v]) => v))
  const preselect = pickService(one(sp.service))
  return (
    <BookShell phone={cfg.phone} address={cfg.address} heading={isRestorationService(preselect) ? 'Request an Estimate' : 'Request a Quote'}>
      <QuoteForm preselect={preselect} attribution={attribution} phone={cfg.phone} />
    </BookShell>
  )
}
