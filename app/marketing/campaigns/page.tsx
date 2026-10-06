import Link from 'next/link'
import { requireMarketingManager, MarketingShell, Section, StatusChip, EmptyRow } from '@/app/marketing/_components'
import { count, shortDate } from '@/app/lib/format'
import { listCampaigns } from '@/apps/marketing/db'
import { SERVICE_CATEGORY_LABELS } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function CampaignsPage() {
  await requireMarketingManager('/marketing/campaigns')
  const campaigns = await listCampaigns({ limit: 100 })

  return (
    <MarketingShell active="/marketing/campaigns" title="Campaigns"
      actions={<Link href="/marketing/campaigns/new" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">New campaign</Link>}>

      <Section title="All campaigns">
        {campaigns.length === 0 ? <EmptyRow>No campaigns yet. Create your first revenue campaign.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Type</th>
                  <th className="pb-2">Target</th>
                  <th className="pb-2">Channel</th>
                  <th className="pb-2 text-right">Recipients</th>
                  <th className="pb-2 text-right">Sent</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2 text-right">Created</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-t border-gray-800">
                    <td className="py-2">
                      <Link href={`/marketing/campaigns/${c.id}`} className="font-semibold text-blue-400 hover:underline">{c.name}</Link>
                    </td>
                    <td className="py-2 text-gray-400">{c.campaignType.replace(/_/g, ' ')}</td>
                    <td className="py-2 text-gray-400">{c.targetService ? (SERVICE_CATEGORY_LABELS[c.targetService as keyof typeof SERVICE_CATEGORY_LABELS] ?? c.targetService) : '—'}</td>
                    <td className="py-2 text-gray-400">{c.channel}</td>
                    <td className="py-2 text-right">{count(c.recipientCount)}</td>
                    <td className="py-2 text-right">{count(c.sentCount)}</td>
                    <td className="py-2"><StatusChip status={c.status} /></td>
                    <td className="py-2 text-right text-gray-500">{shortDate(c.createdAt ? c.createdAt.toISOString().slice(0, 10) : null)}</td>
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
