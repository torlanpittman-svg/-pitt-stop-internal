import { requireMarketingManager, MarketingShell, Section, StatTile, StatusChip, EmptyRow } from '@/app/marketing/_components'
import { money, shortDate } from '@/app/lib/format'
import { listLeads, leadCountsByStatus } from '@/apps/marketing/leads'
import { createLeadAction, updateLeadAction } from '@/app/marketing/actions'
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

export default async function MarketingLeadsPage() {
  await requireMarketingManager('/marketing/leads')

  const counts = await leadCountsByStatus()
  const leads = await listLeads({ limit: 200 })

  return (
    <MarketingShell active="/marketing/leads" title="Leads">
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

      <Section title="Leads">
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
                  <th className="pb-2 text-right">Est. value</th>
                  <th className="pb-2 text-right">Attributed</th>
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
                    <td className="py-2 text-right">{money(lead.estimatedValueCents)}</td>
                    <td className="py-2 text-right text-emerald-400">{money(lead.attributedRevenueCents)}</td>
                    <td className="py-2 text-gray-400">{shortDate(lead.createdAt ? lead.createdAt.toISOString().slice(0, 10) : null)}</td>
                    <td className="py-2">
                      <form action={updateLeadAction} className="flex items-center gap-2">
                        <input type="hidden" name="id" value={lead.id} />
                        <select name="status" defaultValue={lead.status} className="rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs">
                          {LEAD_STATUSES.map((s) => (
                            <option key={s} value={s}>{prettyStatus(s)}</option>
                          ))}
                        </select>
                        <input
                          name="attributedRevenue"
                          placeholder="$ revenue"
                          className="w-24 rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs"
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
          </div>
        )}
      </Section>
    </MarketingShell>
  )
}
