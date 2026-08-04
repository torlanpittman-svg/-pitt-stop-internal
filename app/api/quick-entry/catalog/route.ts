/** GET /api/quick-entry/catalog — read-only buttons for the Quick Entry screen. */
import { NextResponse } from 'next/server'
import { getQuickEntryCatalog } from '@/apps/quick-entry/jobs-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { packages, addons, tech } = await getQuickEntryCatalog()
    const pkg = (f: (typeof packages)[number]) => ({
      id: f.item.id, slug: f.item.slug, name: f.item.name, hasSize: f.item.hasSize, hasCondition: f.item.hasCondition,
      defaultPriceCents: f.item.defaultPriceCents,
      tiers: f.tiers.map((t) => ({ size: t.size, condition: t.condition, startPriceCents: t.startPriceCents })),
    })
    return NextResponse.json({
      ok: true,
      packages: packages.map(pkg),
      addons: addons.map(pkg),
      tech: tech.map((t) => ({ slug: t.slug, label: t.label, group: t.groupName })),
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
