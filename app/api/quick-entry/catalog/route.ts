/** GET /api/quick-entry/catalog — read-only buttons for the Quick Entry screen. */
import { NextResponse } from 'next/server'
import { getFullCatalog } from '@/apps/quick-entry/db'
import { isPlateLookupEnabled } from '@/apps/quick-entry/plate-lookup'
import { nlEnabled, voiceEnabled } from '@/apps/settings/db'
import { listShortcuts } from '@/apps/quick-entry/shortcuts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Employee-facing Quick Entry menu = the manager-managed service shortcuts (Manage services,
// service_shortcuts, migration 0052), each resolved to its catalog record for size/condition tiers
// and default price. FALLBACK ONLY (shortcut table unavailable): the original five-item menu below.
// Catalog records are never modified.
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
    const shortcuts = await listShortcuts().catch(() => null)
    const entries = shortcuts && shortcuts.length
      ? shortcuts.map((sc) => ({ slug: sc.slug, label: sc.label, group: sc.group }))
      : QUICK_ENTRY_MENU.map((m) => ({ ...m, group: undefined as string | undefined }))
    const menu = entries.flatMap(({ slug, label, group }) => {
      const f = bySlug.get(slug); if (!f || !f.item.active) return []
      return [{
        id: f.item.id, slug: f.item.slug, name: label ?? f.item.name, group: group ?? null,
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
