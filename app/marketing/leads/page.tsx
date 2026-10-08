import { requireMarketingManager, MarketingShell, Section, StatTile, StatusChip, EmptyRow, Pager, FlashBanner } from '@/app/marketing/_components'
import { money, shortDate } from '@/app/lib/format'
import { listLeads, leadCountsByStatus, countLeads } from '@/apps/marketing/leads'
import { searchLinkableOrders } from '@/apps/marketing/search'
import { createLeadAction, updateLeadAction, linkLeadOrderAction } from '@/app/marketing/actions'
import {
  LEAD_STATUSES,
  ATTRIBUTION_SOURCES,
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_LABELS,
} from '@/apps/marketing/types'
import type { ServiceCategory } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const inputCls = 'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm'
const primaryBtn = 'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500'

const prettyStatus = (s: string): string => s.replace(/_/g, ' ')
const catLabel = (c: string): string => SERVICE_CATEGORY_LABELS[c as ServiceCategory] ?? c

const PAGE_SIZE = 50

export default async function MarketingLeadsPage({ searchParams }: {
  searchParams: Promise<{ page?: string; err?: string; msg?: string; linkLead?: string; q?: string }>
}) {
  await requireMarketingManager('/marketing/leads')

  const { page: pageRaw, err, msg, linkLead, q } = await searchParams
  const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1)
  const counts = await leadCountsByStatus()
  const total = await countLeads()
  const leads = await listLeads({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })

  const query = (q ?? '').trim()
  const matches = linkLead && query ? await searchLinkableOrders(query, 20) : []
  const selectedLead = linkLead ? leads.find((l) => l.id === linkLead) : undefined

  return (
    <MarketingShell active="/marketing/leads" title="Leads">
      <FlashBanner err={err} msg={msg} />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="New" value={counts.new ?? 0} />
        <StatTile label="Booked" value={counts.booked ?? 0} />
        <StatTile label="Won" value={counts.won ?? 0} />
        <StatTile label="Lost" value={counts.lost ?? 0} />
      </div>

      <Section title="Add lead">
        <form action={createLeadAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input name="name" placeholder="Name" className={inputCls} />
          <input name="phone" placeholder="Phone" className={inputCls} />
          <input name="email" placeholder="Email" className={inputCls} />
          <input name="vehicle" placeholder="Vehicle" className={inputCls} />
          <select name="requestedService" defaultValue="" className={inputCls}>
            <option value="">Requested service…</option>
            {SERVICE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{catLabel(c)}</option>
            ))}
          </select>
          <select name="source" defaultValue="unknown" className={inputCls}>
            {ATTRIBUTION_SOURCES.map((s) => (
              <option key={s} value={s}>{prettyStatus(s)}</option>
            ))}
          </select>
          <div className="sm:col-span-2 lg:col-span-3">
            <button type="submit" className={primaryBtn}>Add lead</button>
          </div>
        </form>
      </Section>

      <Section title="Link a lead to an order">
        <p className="mb-3 text-xs text-gray-500">
          Pick a lead, then search real orders by order number, customer name, or vehicle — no ids to copy, no manual revenue.
          Revenue appears automatically once the job completes and is invoiced. Re-linking supersedes the prior link (append-only).
        </p>
        {leads.length === 0 ? (
          <EmptyRow>Add a lead first, then link it to an order here.</EmptyRow>
        ) : (
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="page" value={page} />
            <label className="text-xs text-gray-500">Lead
              <select name="linkLead" defaultValue={linkLead ?? ''} className="ml-1 rounded-lg border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm">
                <option value="">Select a lead…</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>{l.name ?? 'Lead'}{l.vehicle ? ` · ${l.vehicle}` : ''} ({prettyStatus(l.source)})</option>
                ))}
              </select>
            </label>
            <input name="q" defaultValue={query} placeholder="order #, customer, or vehicle" className="w-64 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
            <button type="submit" className={primaryBtn}>Search orders</button>
          </form>
        )}

        {linkLead && !selectedLead && <p className="mt-3 text-xs text-amber-400">That lead isn&apos;t on this page — paginate to it, then search.</p>}
        {selectedLead && query && (
          <div className="mt-4">
            <div className="mb-2 text-xs text-gray-500">Matches for &ldquo;{query}&rdquo; — linking to <span className="text-gray-200">{selectedLead.name ?? 'lead'}</span>:</div>
            {matches.length === 0 ? (
              <EmptyRow>No matching orders. Try an order number, customer name, or vehicle.</EmptyRow>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-gray-500">
                      <th className="pb-2">Order #</th>
                      <th className="pb-2">Customer</th>
                      <th className="pb-2">Vehicle</th>
                      <th className="pb-2">Status</th>
                      <th className="pb-2">Completed</th>
                      <th className="pb-2 text-right">Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m) => (
                      <tr key={m.serviceOrderId} className="border-t border-gray-800">
                        <td className="py-2">{m.orderNumber ?? '—'}</td>
                        <td className="py-2 text-gray-400">{m.customerName ?? '—'}</td>
                        <td className="py-2 text-gray-400">{m.vehicle ?? '—'}</td>
                        <td className="py-2"><StatusChip status={m.status} /></td>
                        <td className="py-2 text-gray-500">{shortDate(m.completedAt ? m.completedAt.toISOString().slice(0, 10) : null)}</td>
                        <td className="py-2 text-right">
                          <form action={linkLeadOrderAction} className="inline">
                            <input type="hidden" name="leadId" value={selectedLead.id} />
                            <input type="hidden" name="serviceOrderId" value={m.serviceOrderId} />
                            <button type="submit" className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-500">Link</button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Leads">
        <p className="mb-3 text-xs text-gray-500">Status + a reference figure. Revenue in the report is canonical (completed + QB-invoiced) via the order link above — not this field.</p>
        {leads.length === 0 ? (
          <EmptyRow>No leads yet. Add one above as calls and messages come in.</EmptyRow>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Vehicle</th>
                  <th className="pb-2">Requested</th>
                  <th className="pb-2">Source</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Linked</th>
                  <th className="pb-2 text-right">Ref. value</th>
                  <th className="pb-2">Created</th>
                  <th className="pb-2">Update</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-t border-gray-800 align-top">
                    <td className="py-2 font-medium text-white">{lead.name ?? '—'}</td>
                    <td className="py-2 text-gray-400">{lead.vehicle ?? '—'}</td>
                    <td className="py-2 text-gray-400">{lead.requestedService ? catLabel(lead.requestedService) : '—'}</td>
                    <td className="py-2 text-gray-400">{prettyStatus(lead.source)}</td>
                    <td className="py-2"><StatusChip status={lead.status} /></td>
                    <td className="py-2">{lead.serviceOrderId ? <span className="text-emerald-400">✓ order</span> : <span className="text-gray-600">—</span>}</td>
                    <td className="py-2 text-right text-gray-400">{money(lead.attributedRevenueCents)}</td>
                    <td className="py-2 text-gray-400">{shortDate(lead.createdAt ? lead.createdAt.toISOString().slice(0, 10) : null)}</td>
                    <td className="py-2">
                      <form action={updateLeadAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="id" value={lead.id} />
                        <select name="status" defaultValue={lead.status} className="rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs">
                          {LEAD_STATUSES.map((s) => (
                            <option key={s} value={s}>{prettyStatus(s)}</option>
                          ))}
                        </select>
                        <input
                          name="attributedRevenue"
                          placeholder="ref $"
                          className="w-20 rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs"
                        />
                        <button type="submit" className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-500">
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager basePath="/marketing/leads" page={page} pageSize={PAGE_SIZE} total={total} />
          </div>
        )}
      </Section>
    </MarketingShell>
  )
}
