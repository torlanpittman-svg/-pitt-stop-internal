/**
 * PUBLIC quote request — /quote?service=ceramic|headliner (+ utm_* / gclid captured like /book).
 * No employee auth; served on the booking host too (apps/appointments/public-host.ts). Nothing here
 * states a price: quotes are written by the shop after reviewing the vehicle details.
 */
import type { Metadata } from 'next'
import { getBookingConfig } from '@/apps/appointments/db'
import { ATTRIBUTION_KEYS } from '@/apps/appointments/attribution'
import { QUOTE_SERVICES, type QuoteService } from '@/apps/marketing/quote-shared'
import { BookShell } from '@/app/book/BookShell'
import QuoteForm from './QuoteForm'

export const metadata: Metadata = {
  title: 'Request a Quote — Pitt Stop Detail & Auto Sales',
  description: 'Request a ceramic coating or headliner quote from Pitt Stop Detail & Auto Sales in Bryan–College Station, TX.',
}
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function QuotePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const cfg = await getBookingConfig()
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
  const attribution = Object.fromEntries(ATTRIBUTION_KEYS.map((k) => [k, one(sp[k]).slice(0, 120)]).filter(([, v]) => v))
  const svc = one(sp.service)
  const preselect = (svc in QUOTE_SERVICES ? svc : 'ceramic') as QuoteService
  return (
    <BookShell phone={cfg.phone} address={cfg.address} heading="Request a Quote">
      <QuoteForm preselect={preselect} attribution={attribution} phone={cfg.phone} />
    </BookShell>
  )
}
