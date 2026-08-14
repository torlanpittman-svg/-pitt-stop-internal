/**
 * Retail service → QuickBooks Product/Service mapping (P-D3.1 revised).
 *
 * SAFE, reuse-only: a service resolves to its confidently-mapped catalog QB item
 * (service_catalog.qb_item_ref, when qb_item_status='existing' and qb_sync_enabled) — no
 * new QB items are created and no duplicates arise from capitalization/spacing/aliases.
 * Anything not confidently mapped (unmapped catalog service, mapping_review, or a custom /
 * typo'd service) falls back to the generic "Labor" item. Adding an alias or resolving a
 * catalog mapping (owner-driven) is how a service earns its own QB item — this module never
 * guesses one into existence.
 */
import { getDb } from '@/platform/db'
import { isNull } from 'drizzle-orm'
import { serviceCatalog, serviceAliases } from '@/apps/quick-entry/schema'

const norm = (s?: string | null) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export interface ItemMatch { itemRef: string | null; itemName: string; usable: boolean; reason?: string }
export interface RetailItemIndex { match(title: string): ItemMatch }

export async function loadRetailItemIndex(): Promise<RetailItemIndex> {
  const db = getDb()
  const [cats, aliases] = await Promise.all([
    db.select().from(serviceCatalog).where(isNull(serviceCatalog.archivedAt)),
    db.select().from(serviceAliases),
  ])
  type Cat = typeof cats[number]
  const byId = new Map<string, Cat>(cats.map((c) => [c.id, c]))
  const lookup = new Map<string, Cat>()
  for (const c of cats) lookup.set(norm(c.name), c)                       // exact catalog name
  for (const a of aliases) { const c = byId.get(a.catalogId); if (c && !lookup.has(norm(a.alias))) lookup.set(norm(a.alias), c) } // approved aliases

  return {
    match(title: string): ItemMatch {
      const c = lookup.get(norm(title))
      if (!c) return { itemRef: null, itemName: 'Labor', usable: false, reason: 'no catalog match → Labor' }
      const usable = c.qbItemStatus === 'existing' && !!c.qbItemRef && c.qbSyncEnabled === true
      if (!usable) return { itemRef: null, itemName: 'Labor', usable: false, reason: `catalog "${c.name}" status=${c.qbItemStatus} ref=${c.qbItemRef ?? '-'} → Labor` }
      return { itemRef: String(c.qbItemRef), itemName: c.name, usable: true }
    },
  }
}
