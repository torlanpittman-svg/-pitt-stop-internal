/**
 * Renaming a catalog service together with its EXISTING QuickBooks Service item (name + canonical
 * description only). Verified, idempotent, audited; never creates/re-maps items or touches price.
 * PGlite + real schema; QuickBooks mocked (requests recorded).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
type Item = { Id: string; Name: string; Description?: string; Active: boolean; Type: string; SyncToken: string; UnitPrice: number }
const qb = vi.hoisted(() => ({
  items: {} as Record<string, { Id: string; Name: string; Description?: string; Active: boolean; Type: string; SyncToken: string; UnitPrice: number }>,
  posts: [] as Array<{ method?: string; path: string; body: Record<string, unknown> }>,
  dropWrite: false,
}))
vi.mock('@/apps/quickbooks/client', () => ({
  qboEscape: (v: string) => v.replace(/'/g, "\\'"),
  queryQBO: async (q: string) => {
    const id = q.match(/Id = '([^']+)'/)?.[1] ?? ''
    return { Item: qb.items[id] ? [{ ...qb.items[id] }] : [] }
  },
  qbApiRequest: async (req: { method?: string; path: string; body: Record<string, unknown> }) => {
    qb.posts.push(req)
    const it = qb.items[String(req.body.Id)]
    if (!qb.dropWrite) {
      if (typeof req.body.Name === 'string') it.Name = req.body.Name
      if (typeof req.body.Description === 'string') it.Description = req.body.Description
      it.SyncToken = String(Number(it.SyncToken) + 1)
    }
    return { Item: { ...it } }
  },
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { renameCatalogService } from './catalog-item-rename'
import { serviceCatalog, serviceCatalogEvents } from '@/drizzle/schema'

const OLD = 'Interior Component Steam Cleaning'
const NEW = 'Interior Component Steam Cleaning & Sanitizing'
const DESC = 'Steam cleaning and sanitizing of the vehicle’s seats, console, door panels, trim, and other applicable interior surfaces.'
const OLD_DESC = "Steam cleaning of the vehicle's seats, console, door panels, trim, and other applicable interior surfaces."

let db: PgliteDatabase<typeof schema>
let CAT: Record<string, string>
let steamId: string
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  CAT = await seedProductionCatalog(db)
  // Production as inspected read-only on 2026-11-10: manager-created service mapped to item #123, $475.
  const [row] = await db.insert(serviceCatalog).values({
    slug: 'interior_component_steam_cleaning', name: OLD, kind: 'addon', defaultPriceCents: 47500, source: 'manager',
    qbItemRef: '123', qbItemStatus: 'existing', qbSyncEnabled: true, qbDescription: DESC, sortOrder: 500,
  }).returning()
  steamId = row.id
  qb.posts = []
  qb.dropWrite = false
  qb.items = {
    '123': { Id: '123', Name: OLD, Description: OLD_DESC, Active: true, Type: 'Service', SyncToken: '0', UnitPrice: 475 },
    '68': { Id: '68', Name: 'Odor Treatment', Active: true, Type: 'Service', SyncToken: '1', UnitPrice: 300 },
  } satisfies Record<string, Item>
})
const audit = async () => (await db.select().from(serviceCatalogEvents)).filter((e) => e.eventType === 'catalog_renamed')
const catalogRow = async () => (await db.select().from(serviceCatalog).where(eq(serviceCatalog.id, steamId)))[0]

describe('renameCatalogService — item #123 gains “& Sanitizing”', () => {
  it('sends ONE sparse Name + Description update (SyncToken-guarded), renames the catalog row, keeps mapping and price, and audits', async () => {
    const r = await renameCatalogService(steamId, `  ${NEW}  `, 'Torlan')
    expect(qb.posts).toEqual([{ method: 'POST', path: '/item', body: { Id: '123', SyncToken: '0', sparse: true, Name: NEW, Description: DESC } }])
    expect(r).toEqual({ changed: true, catalog: { before: OLD, after: NEW },
      qbItem: { id: '123', before: { name: OLD, description: OLD_DESC }, after: { name: NEW, description: DESC }, changed: true } })
    expect(await catalogRow()).toMatchObject({ name: NEW, slug: 'interior_component_steam_cleaning', qbItemRef: '123', qbItemStatus: 'existing',
      qbSyncEnabled: true, defaultPriceCents: 47500, qbDescription: DESC })
    expect(qb.items['123'].UnitPrice).toBe(475)
    expect(qb.items['68'].Name).toBe('Odor Treatment')   // other items untouched
    const [ev] = await audit()
    expect(ev).toMatchObject({ catalogId: steamId, actor: 'Torlan' })
    expect(JSON.parse(ev.note!)).toMatchObject({ before: { name: OLD }, after: { name: NEW }, qbItem: { id: '123', changed: true } })
  })

  it('is idempotent: a repeat makes no QuickBooks call and no second audit row', async () => {
    await renameCatalogService(steamId, NEW, 'Torlan')
    const again = await renameCatalogService(steamId, NEW, 'Torlan')
    expect(again.changed).toBe(false)
    expect(qb.posts).toHaveLength(1)
    expect(await audit()).toHaveLength(1)
  })

  it('finishes only the catalog side when QuickBooks was already renamed (retry after a failed catalog write)', async () => {
    qb.items['123'].Name = NEW; qb.items['123'].Description = DESC
    const r = await renameCatalogService(steamId, NEW, 'Torlan')
    expect(qb.posts).toEqual([])
    expect(r).toMatchObject({ changed: true, qbItem: { changed: false } })
    expect((await catalogRow()).name).toBe(NEW)
  })

  it('leaves the catalog name alone when QuickBooks does not confirm the rename', async () => {
    qb.dropWrite = true
    await expect(renameCatalogService(steamId, NEW, 'Torlan')).rejects.toThrow(/did not confirm/)
    expect((await catalogRow()).name).toBe(OLD)
    expect(await audit()).toEqual([])
  })

  it('refuses bad names, a name another service uses, unmapped/retired services and missing/inactive/non-service items — nothing sent', async () => {
    await expect(renameCatalogService(steamId, '   ', 'Torlan')).rejects.toThrow(/Enter the service name/)
    await expect(renameCatalogService(steamId, 'x'.repeat(101), 'Torlan')).rejects.toThrow(/100 characters/)
    await expect(renameCatalogService(steamId, 'Interior: Steam', 'Torlan')).rejects.toThrow(/colon/)
    await expect(renameCatalogService(steamId, 'odor treatment', 'Torlan')).rejects.toThrow(/already has that name/)
    await expect(renameCatalogService(CAT.complete_odor_treatment, NEW, 'Torlan')).rejects.toThrow(/not in the active catalog/)
    await expect(renameCatalogService(CAT.paint_touch_up, 'Paint Touch Up Plus', 'Torlan')).rejects.toThrow(/not found or is inactive/)
    qb.items['123'].Type = 'Inventory'
    await expect(renameCatalogService(steamId, NEW, 'Torlan')).rejects.toThrow(/not a service item/)
    qb.items['123'].Type = 'Service'; qb.items['123'].Active = false
    await expect(renameCatalogService(steamId, NEW, 'Torlan')).rejects.toThrow(/not found or is inactive/)
    await db.update(serviceCatalog).set({ qbSyncEnabled: false, qbItemStatus: 'mapping_review' }).where(eq(serviceCatalog.id, steamId))
    await expect(renameCatalogService(steamId, NEW, 'Torlan')).rejects.toThrow(/not mapped to a QuickBooks item/)
    expect(qb.posts).toEqual([])
    expect(await audit()).toEqual([])
    expect((await catalogRow()).name).toBe(OLD)
  })
})
