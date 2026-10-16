/**
 * Retail service → QuickBooks Product/Service mapping (Phase 1a: live-item matching).
 *
 * A service resolves to its actual QB item from its catalog row by matching the LIVE QuickBooks
 * item list:
 *   1. the catalog's qb_item_ref, validated against a live + active QB item
 *   2. else an exact (normalized) QB item name
 *   3. else an approved alias's QB item name
 * The first live match wins — regardless of a stale qb_item_status (that's what made
 * Exterior Wash / Exterior Wax fall back to Labor before). Only a service with NO live QB
 * item (genuinely custom / one-off) uses the generic "Labor" fallback. No QB items are
 * created here and no duplicates arise from capitalization/spacing/aliases.
 *
 * WHICH catalog row a service IS comes from its STABLE job_services.catalog_id identity
 * (`matchService`), not its editable label — so renaming "Full Detail" → "Full Detail -
 * customer vehicle" keeps the same QB item + canonical description. `match(title)` (name/alias
 * lookup) remains for legacy rows that have no stamped identity yet. The name/alias key index and
 * normalizer are shared with the catalog-identity matcher (one policy, not a parallel resolver).
 */
import { getDb } from '@/platform/db'
import { serviceCatalog, serviceAliases } from '@/apps/quick-entry/schema'
import { normalizeServiceKey as norm, buildCatalogKeyIndex } from '@/apps/quick-entry/catalog-identity'
import { queryQBO } from './client'

export interface ItemMatch { itemRef: string | null; itemName: string; usable: boolean; description: string | null; via?: string; reason?: string }
export interface RetailItemIndex {
  /** Legacy/fallback: resolve by the service label (name/alias) — for rows with no stamped identity. */
  match(title: string): ItemMatch
  /** Resolve by the STABLE stamped catalog identity (preferred); falls back to the label when null. */
  matchService(input: { catalogId?: string | null; title: string }): ItemMatch
  /** The EXISTING general QuickBooks parts item for special-order parts (NonInventory "Part",
   *  else an item named "Parts"), or null. Lookup only — a parts item is never created. */
  partsItem(): { itemRef: string; itemName: string } | null
}

interface LiveItem { id: string; name: string; type?: string }

export async function loadRetailItemIndex(): Promise<RetailItemIndex> {
  const db = getDb()
  const [cats, aliases, live] = await Promise.all([
    // ALL catalog rows, including archived — a service's stamped identity may point at a row that
    // was later archived; we must recognize it (and fall back to Labor) rather than silently remap.
    db.select().from(serviceCatalog),
    db.select().from(serviceAliases),
    queryQBO<{ Item?: Array<{ Id: string; Name: string; Active?: boolean; Type?: string }> }>(`SELECT Id, Name, Active, Type FROM Item MAXRESULTS 1000`),
  ])
  type Cat = typeof cats[number]
  const byId = new Map<string, Cat>(cats.map((c) => [c.id, c]))
  const liveCats = cats.filter((c) => c.archivedAt == null)

  // Live QB items (active only).
  const liveById = new Map<string, LiveItem>()
  const liveByName = new Map<string, LiveItem>()
  for (const it of live.Item ?? []) {
    if (it.Active === false) continue
    const item = { id: String(it.Id), name: it.Name, type: it.Type }
    liveById.set(item.id, item)
    if (!liveByName.has(norm(it.Name))) liveByName.set(norm(it.Name), item)
  }

  // Shared name/alias → catalogId index (non-archived catalog only) — same policy that stamps
  // job_services.catalog_id, so label-based lookup and identity resolution never disagree.
  const keyIndex = buildCatalogKeyIndex(liveCats, aliases)
  const aliasesOf = new Map<string, string[]>()
  for (const a of aliases) {
    if (!byId.has(a.catalogId)) continue
    ;(aliasesOf.get(a.catalogId) ?? aliasesOf.set(a.catalogId, []).get(a.catalogId))!.push(a.alias)
  }

  // Resolve a known catalog row to its live QB item (or Labor fallback). The description is ALWAYS
  // catalog-owned — the managed canonical qb_description, or (when blank/null) the catalog's
  // canonical NAME — never the editable service label. This keeps the invoice line description
  // stable across label edits even for catalog items that have no qb_description yet. (Genuinely
  // custom services that match no catalog row get a null description → the label, handled by the
  // caller — that is correct for one-offs.)
  const resolveFromCatalog = (c: Cat): ItemMatch => {
    const description = (c.qbDescription && c.qbDescription.trim()) ? c.qbDescription : c.name
    // An archived catalog item must never be (re)mapped by a label edit → Labor, keeping its own
    // canonical description (not substituted with another item's).
    if (c.archivedAt != null) return { itemRef: null, itemName: 'Labor', usable: false, description, reason: `catalog "${c.name}" archived → Labor` }
    // qb_sync_enabled=false = deliberately NOT part of the standard retail mapping (e.g.
    // Floor Mats) → Labor, even though the catalog row exists.
    if (c.qbSyncEnabled === false) return { itemRef: null, itemName: 'Labor', usable: false, description, reason: 'mapping disabled → Labor' }
    // 1) validated catalog ref
    if (c.qbItemRef && liveById.has(String(c.qbItemRef))) {
      const it = liveById.get(String(c.qbItemRef))!
      return { itemRef: it.id, itemName: it.name, usable: true, description, via: 'catalog-ref' }
    }
    // 2) exact live name
    const byName = liveByName.get(norm(c.name))
    if (byName) return { itemRef: byName.id, itemName: byName.name, usable: true, description, via: 'live-name' }
    // 3) alias → live item
    for (const a of aliasesOf.get(c.id) ?? []) {
      const hit = liveByName.get(norm(a))
      if (hit) return { itemRef: hit.id, itemName: hit.name, usable: true, description, via: 'live-alias' }
    }
    return { itemRef: null, itemName: 'Labor', usable: false, description, reason: `catalog "${c.name}" has no live QB item → Labor` }
  }

  const matchByTitle = (title: string): ItemMatch => {
    const id = keyIndex.get(norm(title))
    const c = id ? byId.get(id) : undefined
    if (!c) return { itemRef: null, itemName: 'Labor', usable: false, description: null, reason: 'no catalog match → Labor' }
    return resolveFromCatalog(c)
  }

  return {
    match: matchByTitle,
    matchService({ catalogId, title }) {
      if (catalogId) {
        const c = byId.get(String(catalogId))
        // A stamped identity whose catalog row no longer exists → Labor (never guess by label).
        if (!c) return { itemRef: null, itemName: 'Labor', usable: false, description: null, reason: 'catalog identity not found → Labor' }
        return resolveFromCatalog(c)
      }
      return matchByTitle(title)   // legacy / genuinely custom rows with no stamped identity
    },
    partsItem() {
      const all = [...liveById.values()]
      const pick = all.find((i) => norm(i.name) === 'part' && i.type === 'NonInventory')
        ?? all.find((i) => norm(i.name) === 'part')
        ?? all.find((i) => norm(i.name) === 'parts')
      return pick ? { itemRef: pick.id, itemName: pick.name } : null
    },
  }
}
