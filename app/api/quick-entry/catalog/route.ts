/** GET /api/quick-entry/catalog — read-only buttons for the Quick Entry screen. */
import { NextResponse } from 'next/server'
import { getQuickEntryCatalog } from '@/apps/quick-entry/jobs-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Employee-facing Quick Entry menu: only these packages (order + display label),
// plus a client-side "Other". Add-ons are hidden. Catalog records are unchanged.
const QUICK_ENTRY_MENU: { slug: string; label?: string }[] = [
  { slug: 'interior_detail' },
  { slug: 'exterior_wash' },
  { slug: 'paint_correction_1step', label: 'Polish' },
  { slug: 'mini_detail' },
]

export async function GET() {
  try {
    const { packages, tech } = await getQuickEntryCatalog()
    const bySlug = new Map(packages.map((f) => [f.item.slug, f]))
    const menu = QUICK_ENTRY_MENU.flatMap(({ slug, label }) => {
      const f = bySlug.get(slug); if (!f) return []
      return [{
        id: f.item.id, slug: f.item.slug, name: label ?? f.item.name,
        hasSize: f.item.hasSize, hasCondition: f.item.hasCondition, defaultPriceCents: f.item.defaultPriceCents,
        tiers: f.tiers.map((t) => ({ size: t.size, condition: t.condition, startPriceCents: t.startPriceCents })),
      }]
    })
    return NextResponse.json({
      ok: true,
      packages: menu,
      addons: [], // hidden from Quick Entry (catalog records preserved)
      tech: tech.map((t) => ({ slug: t.slug, label: t.label, group: t.groupName })),
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
