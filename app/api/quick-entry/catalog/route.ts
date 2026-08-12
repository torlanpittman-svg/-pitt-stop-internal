/** GET /api/quick-entry/catalog — read-only buttons for the Quick Entry screen. */
import { NextResponse } from 'next/server'
import { getFullCatalog } from '@/apps/quick-entry/db'
import { isPlateLookupEnabled } from '@/apps/quick-entry/plate-lookup'
import { nlEnabled, voiceEnabled } from '@/apps/settings/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Employee-facing Quick Entry menu: only these items (order + display label), plus
// a client-side "Other". Resolved by slug against the FULL catalog so entries of any
// kind (e.g. Wax, an add-on) can be surfaced without changing their catalog record.
// Everything not listed here is hidden. Catalog records are never modified.
const QUICK_ENTRY_MENU: { slug: string; label?: string }[] = [
  { slug: 'interior_detail' },
  { slug: 'exterior_wash' },
  { slug: 'paint_correction_1step', label: 'Polish' },
  { slug: 'exterior_wax', label: 'Wax' },
  { slug: 'mini_detail' },
]

export async function GET() {
  try {
    const full = await getFullCatalog()
    const bySlug = new Map(full.map((f) => [f.item.slug, f]))
    const menu = QUICK_ENTRY_MENU.flatMap(({ slug, label }) => {
      const f = bySlug.get(slug); if (!f || !f.item.active) return []
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
      // tech instructions intentionally omitted from Quick Entry for now; the
      // technician_instructions table / repo remain intact for later re-enable.
      tech: [],
      plateLookupEnabled: isPlateLookupEnabled(),
      nlEnabled: await nlEnabled(),
      voiceEnabled: await voiceEnabled(),
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
