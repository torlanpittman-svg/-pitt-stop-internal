import { requireMarketingManager, MarketingShell, Section, StatusChip, EmptyRow } from '@/app/marketing/_components'
import { shortDate } from '@/app/lib/format'
import { TWELVE_WEEK_ROTATION, WEEKLY_FACEBOOK_PLAN, rotationMix } from '@/apps/marketing/calendar'
import { listCampaigns } from '@/apps/marketing/db'
import { listPosts } from '@/apps/marketing/content'
import { SERVICE_CATEGORY_LABELS, PREMIUM_CATEGORIES, type ServiceCategory } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const toYmd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null)
const isPremium = (c: ServiceCategory): boolean => PREMIUM_CATEGORIES.includes(c)

interface ScheduledItem {
  key: string
  type: 'Campaign' | 'Post'
  label: string
  ymd: string | null
  status: string
}

export default async function MarketingCalendar() {
  await requireMarketingManager('/marketing/calendar')
  const [campaigns, posts] = await Promise.all([
    listCampaigns({ limit: 100 }),
    listPosts({ limit: 100 }),
  ])

  const mix = rotationMix()
  const mixMax = Math.max(1, ...Object.values(mix))

  const scheduled: ScheduledItem[] = [
    ...campaigns
      .filter((c) => c.scheduledAt != null || ['scheduled', 'ready'].includes(c.status))
      .map((c) => ({ key: `c-${c.id}`, type: 'Campaign' as const, label: c.name, ymd: toYmd(c.scheduledAt), status: c.status })),
    ...posts
      .filter((p) => p.scheduledAt != null)
      .map((p) => ({ key: `p-${p.id}`, type: 'Post' as const, label: p.pillar, ymd: toYmd(p.scheduledAt), status: p.status })),
  ].sort((a, b) => {
    if (a.ymd && b.ymd) return a.ymd.localeCompare(b.ymd)
    if (a.ymd) return -1
    if (b.ymd) return 1
    return 0
  })

  return (
    <MarketingShell active="/marketing/calendar" title="Marketing Calendar">
      <p className="mb-4 text-sm text-gray-500">
        A deterministic 12-week rotation biased toward premium work (ceramic, paint correction, interior),
        merged with what&apos;s actually scheduled this cycle.
      </p>

      <Section title="12-week premium-service rotation">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500">
              <th className="pb-2">Week</th>
              <th className="pb-2">Focus</th>
              <th className="pb-2">Theme</th>
              <th className="pb-2">Campaign angle</th>
            </tr>
          </thead>
          <tbody>
            {TWELVE_WEEK_ROTATION.map((w) => (
              <tr key={w.week} className={`border-t border-gray-800 ${isPremium(w.focus) ? 'bg-gray-950/60' : ''}`}>
                <td className="py-2 font-semibold">{w.week}</td>
                <td className="py-2">
                  <span className={isPremium(w.focus) ? 'font-semibold text-emerald-400' : 'text-gray-300'}>
                    {SERVICE_CATEGORY_LABELS[w.focus]}
                  </span>
                </td>
                <td className="py-2 text-gray-400">{w.theme}</td>
                <td className="py-2 text-gray-400">{w.campaignAngle || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Rotation mix">
        <p className="mb-3 text-xs text-gray-500">How the 12 weeks distribute across services — weighted toward premium.</p>
        <div className="space-y-2">
          {(Object.keys(mix) as ServiceCategory[])
            .filter((cat) => mix[cat] > 0)
            .sort((a, b) => mix[b] - mix[a])
            .map((cat) => (
              <div key={cat} className="flex items-center gap-3">
                <div className="w-40 shrink-0 text-xs text-gray-400">{SERVICE_CATEGORY_LABELS[cat]}</div>
                <div className="h-3 flex-1 rounded bg-gray-950">
                  <div
                    className={`h-3 rounded ${isPremium(cat) ? 'bg-emerald-500' : 'bg-gray-600'}`}
                    style={{ width: `${(mix[cat] / mixMax) * 100}%` }}
                  />
                </div>
                <div className="w-8 shrink-0 text-right text-xs font-semibold text-white">{mix[cat]}</div>
              </div>
            ))}
        </div>
      </Section>

      <Section title="Scheduled this cycle">
        {scheduled.length === 0 ? (
          <EmptyRow>Nothing scheduled yet. Schedule a campaign or a post to see it here.</EmptyRow>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500">
                <th className="pb-2">Date</th>
                <th className="pb-2">Type</th>
                <th className="pb-2">Name / pillar</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {scheduled.map((s) => (
                <tr key={s.key} className="border-t border-gray-800">
                  <td className="py-2 whitespace-nowrap text-gray-400">{shortDate(s.ymd)}</td>
                  <td className="py-2 uppercase text-gray-500">{s.type}</td>
                  <td className="py-2">{s.label}</td>
                  <td className="py-2"><StatusChip status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Weekly Facebook cadence">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {WEEKLY_FACEBOOK_PLAN.map((p) => (
            <div key={p.day} className="rounded-xl border border-gray-800 bg-gray-950 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">{p.day}</span>
                <StatusChip status={p.pillar} />
              </div>
              <p className="mt-2 text-xs text-gray-400">{p.note}</p>
            </div>
          ))}
        </div>
      </Section>
    </MarketingShell>
  )
}
