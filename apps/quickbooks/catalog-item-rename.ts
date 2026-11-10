/**
 * Rename a catalog service AND its EXISTING mapped QuickBooks Service item, so future selections and
 * future invoice/estimate lines use the corrected wording (e.g. a scope that now includes sanitizing).
 *
 * Narrow on purpose:
 *  - only a live (non-archived, active) catalog service that is mapped to an existing QuickBooks item;
 *  - a sparse update of the item's Name + Description alone (price, income account, tax and type are
 *    untouched; the item is never created, merged or re-mapped), guarded by its SyncToken, then verified;
 *  - the item Description is set to the catalog's managed canonical description (never invented here);
 *  - QuickBooks first, then the catalog name — if the catalog write fails, a retry finds QuickBooks
 *    already correct and only finishes the catalog side (idempotent; no-op when nothing differs);
 *  - refuses a name already used by another live catalog service;
 *  - audited in service_catalog_events ('catalog_renamed', before/after, actor).
 * Applies to FUTURE additions: existing Job/estimate lines keep their own title and captured description,
 * and posted QuickBooks transactions are not edited. Manager/admin only (enforced by the calling route).
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { serviceCatalog, serviceCatalogEvents } from '@/apps/quick-entry/schema'
import { qbApiRequest, queryQBO, qboEscape } from './client'

interface QbItem { Id: string; Name: string; Description?: string; Active?: boolean; Type?: string; SyncToken?: string; UnitPrice?: number }

export interface CatalogRenameResult {
  changed: boolean
  catalog: { before: string; after: string }
  qbItem: { id: string; before: { name: string; description: string | null }; after: { name: string; description: string | null }; changed: boolean }
}

/** QuickBooks item names: max 100 chars, and ':' is the sub-item separator. */
export function cleanServiceName(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

export async function renameCatalogService(catalogId: string, rawName: string, actor: string | null): Promise<CatalogRenameResult> {
  const name = cleanServiceName(rawName)
  if (!name) throw new Error('Enter the service name.')
  if (name.length > 100) throw new Error('Service name must be 100 characters or fewer.')
  if (name.includes(':')) throw new Error('Service names can’t contain a colon.')
  const db = getDb()
  const [c] = await db.select().from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, catalogId), isNull(serviceCatalog.archivedAt), eq(serviceCatalog.active, true))).limit(1)
  if (!c) throw new Error('That service is not in the active catalog.')
  if (!c.qbItemRef || !c.qbSyncEnabled || c.qbItemStatus !== 'existing') throw new Error(`“${c.name}” is not mapped to a QuickBooks item yet.`)
  const [clash] = await db.select({ id: serviceCatalog.id }).from(serviceCatalog)
    .where(and(ne(serviceCatalog.id, catalogId), isNull(serviceCatalog.archivedAt), sql`lower(${serviceCatalog.name}) = ${name.toLowerCase()}`)).limit(1)
  if (clash) throw new Error('Another service already has that name.')

  const item = (await queryQBO<{ Item?: QbItem[] }>(`select * from Item where Id = '${qboEscape(c.qbItemRef)}'`)).Item?.[0]
  if (!item || item.Active === false) throw new Error(`QuickBooks item #${c.qbItemRef} for “${c.name}” was not found or is inactive.`)
  if (item.Type && item.Type !== 'Service') throw new Error(`QuickBooks item “${item.Name}” is not a service item.`)

  const description = (c.qbDescription && c.qbDescription.trim()) || null
  const qbBefore = { name: item.Name, description: item.Description ?? null }
  const qbAfter = { name, description: description ?? qbBefore.description }
  const qbChanged = qbBefore.name !== qbAfter.name || qbBefore.description !== qbAfter.description
  if (qbChanged) {
    const updated = await qbApiRequest<{ Item?: QbItem }>({
      method: 'POST', path: '/item',
      body: { Id: item.Id, SyncToken: item.SyncToken, sparse: true, Name: name, ...(description ? { Description: description } : {}) },
    })
    if (updated.Item?.Name !== name || (description && updated.Item?.Description !== description)) {
      throw new Error('QuickBooks did not confirm the item rename.')
    }
  }

  const catalogChanged = c.name !== name
  if (catalogChanged) await db.update(serviceCatalog).set({ name, updatedAt: new Date() }).where(eq(serviceCatalog.id, c.id))
  const result: CatalogRenameResult = {
    changed: qbChanged || catalogChanged, catalog: { before: c.name, after: name },
    qbItem: { id: item.Id, before: qbBefore, after: qbAfter, changed: qbChanged },
  }
  if (result.changed) {
    await db.insert(serviceCatalogEvents).values({
      catalogId: c.id, eventType: 'catalog_renamed', actor,
      note: JSON.stringify({ before: { name: c.name }, after: { name }, qbItem: result.qbItem,
        scope: 'future selections and future transactions; existing lines and posted transactions are not edited' }),
    })
  }
  return result
}
