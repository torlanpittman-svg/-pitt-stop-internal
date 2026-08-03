/**
 * Quick Entry catalog — READ-ONLY repository (SELECT only).
 * No writes here; seeding lives in scripts/seed-quick-entry.ts. Price changes
 * (once the UI exists) will be audited separately.
 */
import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { serviceCatalog, servicePriceTiers, serviceAliases, technicianInstructions } from './schema'

export type CatalogRow = typeof serviceCatalog.$inferSelect
export type TierRow    = typeof servicePriceTiers.$inferSelect
export type AliasRow   = typeof serviceAliases.$inferSelect
export type TechRow    = typeof technicianInstructions.$inferSelect

const LIVE = () => and(eq(serviceCatalog.active, true), isNull(serviceCatalog.archivedAt))

/** All live catalog items (optionally filtered by kind), ordered for display. */
export async function listCatalog(kind?: 'package' | 'addon' | 'placeholder'): Promise<CatalogRow[]> {
  const db = getDb()
  const where = kind ? and(LIVE(), eq(serviceCatalog.kind, kind)) : LIVE()
  return db.select().from(serviceCatalog).where(where).orderBy(asc(serviceCatalog.sortOrder), asc(serviceCatalog.name))
}

/** Quick-Entry buttons of a kind (package/addon), live only. */
export async function listQuickEntry(kind: 'package' | 'addon'): Promise<CatalogRow[]> {
  const db = getDb()
  return db.select().from(serviceCatalog)
    .where(and(LIVE(), eq(serviceCatalog.kind, kind), eq(serviceCatalog.quickEntry, true)))
    .orderBy(asc(serviceCatalog.sortOrder), asc(serviceCatalog.name))
}

export async function getCatalogItem(slug: string): Promise<CatalogRow | null> {
  const db = getDb()
  const [row] = await db.select().from(serviceCatalog).where(eq(serviceCatalog.slug, slug)).limit(1)
  return row ?? null
}

export async function listTiers(catalogId: string): Promise<TierRow[]> {
  const db = getDb()
  return db.select().from(servicePriceTiers).where(eq(servicePriceTiers.catalogId, catalogId)).orderBy(asc(servicePriceTiers.sortOrder))
}

/** A catalog item with its price tiers + aliases (read-only detail view). */
export async function getCatalogItemDetail(slug: string): Promise<{ item: CatalogRow; tiers: TierRow[]; aliases: AliasRow[] } | null> {
  const item = await getCatalogItem(slug)
  if (!item) return null
  const db = getDb()
  const [tiers, aliases] = await Promise.all([
    listTiers(item.id),
    db.select().from(serviceAliases).where(eq(serviceAliases.catalogId, item.id)),
  ])
  return { item, tiers, aliases }
}

/** Aliases the owner has approved the AI to match against (empty until approved). */
export async function listAiApprovedAliases(): Promise<AliasRow[]> {
  const db = getDb()
  return db.select().from(serviceAliases).where(eq(serviceAliases.approvedForAi, true))
}

/** All active technician instructions, grouped-order (never billable). */
export async function listTechnicianInstructions(): Promise<TechRow[]> {
  const db = getDb()
  return db.select().from(technicianInstructions)
    .where(and(eq(technicianInstructions.active, true), isNull(technicianInstructions.archivedAt)))
    .orderBy(asc(technicianInstructions.groupName), asc(technicianInstructions.sortOrder))
}

export interface FullCatalogItem { item: CatalogRow; tiers: TierRow[]; aliases: AliasRow[] }

/** Whole catalog (non-archived) with tiers + aliases assembled — for the admin view. */
export async function getFullCatalog(): Promise<FullCatalogItem[]> {
  const db = getDb()
  const items = await db.select().from(serviceCatalog).where(isNull(serviceCatalog.archivedAt))
    .orderBy(asc(serviceCatalog.sortOrder), asc(serviceCatalog.name))
  const [allTiers, allAliases] = await Promise.all([
    db.select().from(servicePriceTiers).orderBy(asc(servicePriceTiers.sortOrder)),
    db.select().from(serviceAliases),
  ])
  return items.map((item) => ({
    item,
    tiers: allTiers.filter((t) => t.catalogId === item.id),
    aliases: allAliases.filter((a) => a.catalogId === item.id),
  }))
}

/** Items whose QuickBooks mapping is still unresolved (new item needed / mapping review). */
export async function listUnresolvedQbMappings(): Promise<CatalogRow[]> {
  const db = getDb()
  return db.select().from(serviceCatalog).where(eq(serviceCatalog.qbSyncEnabled, false)).orderBy(asc(serviceCatalog.sortOrder))
}
