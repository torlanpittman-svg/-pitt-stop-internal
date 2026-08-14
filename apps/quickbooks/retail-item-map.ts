/**
 * Retail service → QuickBooks Product/Service mapping (Phase 1a: live-item matching).
 *
 * A service resolves to its actual QB item by matching the LIVE QuickBooks item list:
 *   1. the catalog's qb_item_ref, validated against a live + active QB item
 *   2. else an exact (normalized) QB item name
 *   3. else an approved alias's QB item name
 * The first live match wins — regardless of a stale qb_item_status (that's what made
 * Exterior Wash / Exterior Wax fall back to Labor before). Only a service with NO live QB
 * item (genuinely custom / one-off) uses the generic "Labor" fallback. No QB items are
 * created here and no duplicates arise from capitalization/spacing/aliases.
 */
import { getDb } from '@/platform/db'
import { isNull } from 'drizzle-orm'
import { serviceCatalog, serviceAliases } from '@/apps/quick-entry/schema'
import { queryQBO } from './client'

const norm = (s?: string | null) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export interface ItemMatch { itemRef: string | null; itemName: string; usable: boolean; description: string | null; via?: string; reason?: string }
export interface RetailItemIndex { match(title: string): ItemMatch }

interface LiveItem { id: string; name: string }

export async function loadRetailItemIndex(): Promise<RetailItemIndex> {
  const db = getDb()
  const [cats, aliases, live] = await Promise.all([
    db.select().from(serviceCatalog).where(isNull(serviceCatalog.archivedAt)),
    db.select().from(serviceAliases),
    queryQBO<{ Item?: Array<{ Id: string; Name: string; Active?: boolean }> }>(`SELECT Id, Name, Active FROM Item MAXRESULTS 1000`),
  ])
  type Cat = typeof cats[number]
  const byId = new Map<string, Cat>(cats.map((c) => [c.id, c]))

  // Live QB items (active only).
  const liveById = new Map<string, LiveItem>()
  const liveByName = new Map<string, LiveItem>()
  for (const it of live.Item ?? []) {
    if (it.Active === false) continue
    const item = { id: String(it.Id), name: it.Name }
    liveById.set(item.id, item)
    if (!liveByName.has(norm(it.Name))) liveByName.set(norm(it.Name), item)
  }

  // Catalog lookup by exact name + approved aliases.
  const catByKey = new Map<string, Cat>()
  const aliasesOf = new Map<string, string[]>()
  for (const c of cats) catByKey.set(norm(c.name), c)
  for (const a of aliases) {
    const c = byId.get(a.catalogId); if (!c) continue
    if (!catByKey.has(norm(a.alias))) catByKey.set(norm(a.alias), c)
    ;(aliasesOf.get(c.id) ?? aliasesOf.set(c.id, []).get(c.id))!.push(a.alias)
  }

  return {
    match(title: string): ItemMatch {
      const c = catByKey.get(norm(title))
      if (!c) return { itemRef: null, itemName: 'Labor', usable: false, description: null, reason: 'no catalog match → Labor' }
      const description = c.qbDescription ?? null   // managed canonical description (Phase 1b)
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
    },
  }
}
