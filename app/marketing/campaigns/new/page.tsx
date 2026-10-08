import { requireMarketingManager, MarketingShell, Section, FlashBanner } from '@/app/marketing/_components'
import { createCampaignAction } from '@/app/marketing/actions'
import { listNamedSegments } from '@/apps/marketing/segments'
import { CAMPAIGN_TYPES, CHANNELS, SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  await requireMarketingManager('/marketing/campaigns')
  const { err } = await searchParams
  const segments = await listNamedSegments()

  return (
    <MarketingShell active="/marketing/campaigns" title="New campaign">
      <FlashBanner err={err} />
      <Section title="Campaign details">
        <form action={createCampaignAction} className="max-w-xl space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Name</label>
            <input name="name" type="text" required placeholder="Winter ceramic reactivation"
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Campaign type</label>
            <select name="campaignType" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm">
              {CAMPAIGN_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Target service</label>
            <select name="targetService" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm">
              <option value="">— Any —</option>
              {SERVICE_CATEGORIES.map((s) => (
                <option key={s} value={s}>{SERVICE_CATEGORY_LABELS[s] ?? s}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Segment</label>
            <select name="segmentKey" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm">
              <option value="">— No segment —</option>
              {segments.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Channel</label>
            <select name="channel" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm">
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>{ch}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Offer (optional)</label>
            <input name="offer" type="text" placeholder="e.g. $25 off ceramic coating"
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-gray-500">Leave blank unless an offer is actually approved — AI never invents one.</p>
          </div>

          <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Create draft</button>
        </form>
      </Section>
    </MarketingShell>
  )
}
