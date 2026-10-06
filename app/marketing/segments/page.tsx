import Link from 'next/link'
import { requireMarketingManager, MarketingShell, Section, StatusChip, EmptyRow } from '@/app/marketing/_components'
import { money, count, shortDate } from '@/app/lib/format'
import { contactAggregates, listMarketingContacts } from '@/apps/marketing/contacts'
import { listNamedSegments, estimateSegment } from '@/apps/marketing/segments'
import { SERVICE_CATEGORY_LABELS } from '@/apps/marketing/types'
import type { ServiceCategory } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function MarketingSegmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ segment?: string; q?: string; page?: string }>
}) {
  await requireMarketingManager('/marketing/segments')
  const sp = await searchParams

  const now = new Date().getTime()
  const aggs = await contactAggregates()
  const segments = listNamedSegments().map((seg) => ({
    seg,
    estimate: estimateSegment(aggs, seg.criteria, now),
  }))

  const activeSegment = sp.segment ?? null
  const q = sp.q ?? null
  const page = Math.max(1, Number(sp.page ?? 1) || 1)
  const pageSize = 50
  const { contacts, total } = await listMarketingContacts({
    segmentKey: activeSegment,
    search: q,
    page,
    pageSize,
    now,
  })

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const qp = (overrides: Record<string, string | number | null | undefined>): string => {
    const params = new URLSearchParams()
    if (activeSegment) params.set('segment', activeSegment)
    if (q) params.set('q', q)
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null || v === '') params.delete(k)
      else params.set(k, String(v))
    }
    const s = params.toString()
    return s ? `/marketing/segments?${s}` : '/marketing/segments'
  }

  const catLabel = (c: string): string =>
    SERVICE_CATEGORY_LABELS[c as ServiceCategory] ?? c

  return (
    <MarketingShell active="/marketing/segments" title="Customers & Segments">
      <Section title="Named segments">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {segments.map(({ seg, estimate }) => {
            const isActive = activeSegment === seg.key
            return (
              <div
                key={seg.key}
                className={`rounded-xl border p-3 ${isActive ? 'border-blue-600 bg-gray-950' : 'border-gray-800 bg-gray-950'}`}
              >
                <div className="text-sm font-semibold text-white">{seg.label}</div>
                <p className="mt-1 text-xs text-gray-400">{seg.description}</p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[10px] uppercase text-gray-500">Total</div>
                    <div className="text-sm font-bold">{count(estimate.total)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-gray-500">SMS</div>
                    <div className="text-sm font-bold text-emerald-400">{count(estimate.smsReachable)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-gray-500">Email</div>
                    <div className="text-sm font-bold text-emerald-400">{count(estimate.emailReachable)}</div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <Link href={`/marketing/segments?segment=${seg.key}`} className="text-xs text-blue-400 hover:underline">
                    {isActive ? 'Filtering ↓' : 'View contacts'}
                  </Link>
                  <Link href="/marketing/campaigns/new" className="text-xs text-blue-400 hover:underline">
                    Create campaign →
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      </Section>

      <Section
        title={activeSegment ? `Contacts · ${listNamedSegments().find((s) => s.key === activeSegment)?.label ?? activeSegment}` : 'All contacts'}
        right={
          <form method="GET" action="/marketing/segments" className="flex items-center gap-2">
            {activeSegment && <input type="hidden" name="segment" value={activeSegment} />}
            <input
              name="q"
              defaultValue={q ?? ''}
              placeholder="Search name, phone, email"
              className="w-56 rounded-lg border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm"
            />
            <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">
              Search
            </button>
          </form>
        }
      >
        <div className="mb-3 text-xs text-gray-500">{count(total)} contacts{activeSegment ? ' in segment' : ''}{q ? ` matching "${q}"` : ''}.</div>
        {contacts.length === 0 ? (
          <EmptyRow>No contacts match. Adjust the segment or search.</EmptyRow>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Phone</th>
                  <th className="pb-2">Email</th>
                  <th className="pb-2">Last visit</th>
                  <th className="pb-2 text-right">Visits</th>
                  <th className="pb-2 text-right">Lifetime</th>
                  <th className="pb-2 text-right">Avg ticket</th>
                  <th className="pb-2">Categories</th>
                  <th className="pb-2">Eligibility</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.customerId} className="border-t border-gray-800 align-top">
                    <td className="py-2 font-medium text-white">{c.name}</td>
                    <td className="py-2 text-gray-400">{c.phone ?? '—'}</td>
                    <td className="py-2 text-gray-400">{c.email ?? '—'}</td>
                    <td className="py-2 text-gray-400">{shortDate(c.lastVisitAt ? c.lastVisitAt.toISOString().slice(0, 10) : null)}</td>
                    <td className="py-2 text-right">{count(c.totalVisits)}</td>
                    <td className="py-2 text-right text-emerald-400">{money(c.lifetimeRevenueCents)}</td>
                    <td className="py-2 text-right">{money(c.avgTicketCents)}</td>
                    <td className="py-2 text-gray-400">{c.categories.length ? c.categories.map(catLabel).join(', ') : '—'}</td>
                    <td className="py-2">
                      {c.unsubscribed ? (
                        <StatusChip status="lost" />
                      ) : (
                        <span className="text-xs text-gray-400">
                          {c.smsEligible && c.phone ? 'SMS' : ''}
                          {c.smsEligible && c.phone && c.emailEligible && c.email ? ' · ' : ''}
                          {c.emailEligible && c.email ? 'Email' : ''}
                          {!(c.smsEligible && c.phone) && !(c.emailEligible && c.email) ? '—' : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            {page > 1 ? (
              <Link href={qp({ page: page - 1 })} className="rounded-lg border border-gray-700 px-3 py-1.5 text-gray-300 hover:border-gray-600">
                ← Prev
              </Link>
            ) : (
              <span className="rounded-lg border border-gray-900 px-3 py-1.5 text-gray-700">← Prev</span>
            )}
            <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
            {page < totalPages ? (
              <Link href={qp({ page: page + 1 })} className="rounded-lg border border-gray-700 px-3 py-1.5 text-gray-300 hover:border-gray-600">
                Next →
              </Link>
            ) : (
              <span className="rounded-lg border border-gray-900 px-3 py-1.5 text-gray-700">Next →</span>
            )}
          </div>
        )}
      </Section>
    </MarketingShell>
  )
}
