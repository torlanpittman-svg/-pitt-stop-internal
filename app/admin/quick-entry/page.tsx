import Link from 'next/link'
import { getFullCatalog, listTechnicianInstructions, listUnresolvedQbMappings, type FullCatalogItem, type CatalogRow } from '@/apps/quick-entry/db'
import { partitionCatalog, startingPriceLabel, centsToDollars } from '@/apps/quick-entry/catalog'

export const dynamic = 'force-dynamic'

// ── badges ───────────────────────────────────────────────────────────────────
function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'green' | 'amber' | 'red' | 'gray' | 'blue' }) {
  const c = { green: 'bg-green-500/15 text-green-400', amber: 'bg-amber-500/15 text-amber-400',
    red: 'bg-red-500/15 text-red-400', gray: 'bg-gray-700/40 text-gray-400', blue: 'bg-blue-500/15 text-blue-400' }[tone]
  return <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${c}`}>{children}</span>
}
function qbBadge(item: CatalogRow) {
  if (item.qbItemStatus === 'existing') return <Badge tone={item.qbSyncEnabled ? 'green' : 'amber'}>QB #{item.qbItemRef} · sync {item.qbSyncEnabled ? 'on' : 'off'}</Badge>
  if (item.qbItemStatus === 'new_create_at_golive') return <Badge tone="amber">QB: new item needed · sync off</Badge>
  return <Badge tone="amber">QB: mapping review{item.qbItemRef ? ` (#${item.qbItemRef})` : ''} · sync off</Badge>
}
function remainingAction(i: CatalogRow): string {
  if (i.qbItemStatus === 'new_create_at_golive') return `Create a new QuickBooks item “${i.name}”, map it, then enable sync.`
  if (i.qbItemStatus === 'mapping_review') {
    return i.defaultPriceCents == null
      ? `Owner: set a price and confirm the QuickBooks item${i.qbItemRef ? ` (#${i.qbItemRef})` : ''}, then enable sync.`
      : `Confirm existing QuickBooks item #${i.qbItemRef} is safe to reuse, then enable sync.`
  }
  return 'Enable sync when ready.'
}

// ── service card ─────────────────────────────────────────────────────────────
function ServiceCard({ f }: { f: FullCatalogItem }) {
  const { item, tiers, aliases } = f
  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-white font-semibold">{item.name}</p>
        <span className="text-white font-bold text-sm shrink-0">{startingPriceLabel(item, tiers)}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        <Badge tone={item.active ? 'green' : 'gray'}>{item.active ? 'Active' : 'Inactive'}</Badge>
        {item.quickEntry && <Badge tone="blue">Quick Entry</Badge>}
        {item.reviewFlag && <Badge tone="amber">Owner review</Badge>}
        {qbBadge(item)}
        <Badge tone="gray">AutoLeap: pending API</Badge>
        {item.source && <Badge tone="gray">src: {item.source}</Badge>}
      </div>

      {tiers.length > 0 && (
        <div className="mt-3 rounded-xl bg-gray-950 border border-gray-800 divide-y divide-gray-800">
          {tiers.map((t) => (
            <div key={t.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
              <span className="text-gray-400">{t.size.replace(/_/g, ' ')}{t.condition ? ` · ${t.condition}` : ''}</span>
              <span className="text-white font-medium">{centsToDollars(t.startPriceCents)}</span>
            </div>
          ))}
        </div>
      )}

      {aliases.length > 0 && (
        <div className="mt-3">
          <p className="text-gray-500 text-[11px] uppercase tracking-widest">Historical aliases</p>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {aliases.map((a) => (
              <span key={a.id} className={`text-[11px] rounded px-1.5 py-0.5 ${a.source === 'legacy_terminology' ? 'text-amber-300/80 bg-amber-900/30' : 'text-gray-300 bg-gray-800'}`}>
                {a.alias}{a.source === 'legacy_terminology' ? ' · legacy' : ''}
              </span>
            ))}
          </div>
          <p className="text-amber-400/80 text-[11px] mt-1">AI use: not approved yet · aliases never override current catalog/pricing</p>
        </div>
      )}

      {item.notes && <p className="text-gray-600 text-[11px] mt-2">{item.notes}</p>}
    </div>
  )
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest">{title}</h2>
      {sub && <p className="text-gray-600 text-xs mb-3">{sub}</p>}
      <div className="space-y-3 mt-3">{children}</div>
    </section>
  )
}

const GROUP_LABEL: Record<string, string> = {
  intake_condition_flags: 'Intake condition flags', pre_work_checks: 'Pre-work checks',
  process_instructions: 'Process instructions', customer_communication: 'Customer communication', free_text: 'Free text',
}

export default async function QuickEntryCatalogPage() {
  const [full, tech, unresolved] = await Promise.all([getFullCatalog(), listTechnicianInstructions(), listUnresolvedQbMappings()])

  if (full.length === 0) {
    return (
      <main className="min-h-screen bg-gray-950 px-5 pt-10 pb-16">
        <div className="max-w-2xl mx-auto">
          <Link href="/admin" className="text-gray-500 text-sm">← Admin</Link>
          <h1 className="text-2xl font-bold text-white mt-4">Quick Entry Catalog</h1>
          <p className="text-gray-500 mt-6">No catalog items found. The catalog has not been seeded.</p>
        </div>
      </main>
    )
  }

  const byId = new Map(full.map((f) => [f.item.id, f]))
  const parts = partitionCatalog(full.map((f) => f.item))
  const card = (item: CatalogRow) => <ServiceCard key={item.id} f={byId.get(item.id)!} />
  const techGroups = [...new Set(tech.map((t) => t.groupName))]

  return (
    <main className="min-h-screen bg-gray-950 px-5 pt-10 pb-20">
      <div className="max-w-2xl mx-auto">
        <Link href="/admin" className="text-gray-500 text-sm block mb-4 hover:text-gray-300">← Admin</Link>
        <h1 className="text-2xl font-bold text-white">Quick Entry Catalog</h1>
        <p className="text-gray-500 text-sm mt-1 mb-8">
          Read-only review of the V1 service catalog. No edits, approvals, sync, or mapping changes are possible here.
        </p>

        <Section title="Retail Packages" sub={`${parts.retailPackages.length} packages`}>{parts.retailPackages.map(card)}</Section>

        <Section title="Dealer Packages" sub="Prices come from the Dealer Check-In rules engine (source = dealer_rules).">{parts.dealerPackages.map(card)}</Section>

        <Section title="Add-Ons — Quick Entry" sub={`${parts.quickAddons.length} common add-ons`}>{parts.quickAddons.map(card)}</Section>
        <Section title="Add-Ons — Custom Service only" sub="Available via “Add Custom Service”, not a quick button.">{parts.customAddons.map(card)}</Section>

        <Section title="Technician Instructions" sub="Non-billable — these never become invoice lines.">
          {techGroups.map((g) => (
            <div key={g} className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
              <div className="flex items-center justify-between">
                <p className="text-white font-semibold text-sm">{GROUP_LABEL[g] ?? g}</p>
                <Badge tone="gray">non-billable</Badge>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tech.filter((t) => t.groupName === g).map((t) => (
                  <span key={t.id} className="text-[11px] text-gray-300 bg-gray-800 rounded px-2 py-1">{t.label}</span>
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section title="Unresolved QuickBooks Mappings" sub={`${unresolved.length} items with sync disabled — action required before go-live.`}>
          {unresolved.map((i) => (
            <div key={i.id} className="rounded-2xl bg-amber-950/30 border border-amber-800/50 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-white font-semibold text-sm">{i.name}</p>
                <Badge tone="amber">sync off</Badge>
              </div>
              <p className="text-amber-200/90 text-sm mt-1">{remainingAction(i)}</p>
            </div>
          ))}
        </Section>
      </div>
    </main>
  )
}
