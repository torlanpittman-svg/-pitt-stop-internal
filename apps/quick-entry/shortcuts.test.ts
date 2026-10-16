/**
 * Manage services: shortcut configuration + catalog edits. Permissions (route), persistence,
 * historical-record protection (existing estimate lines / QB mapping untouched), no duplicate QB
 * items, audit trail, and usage suggestions that never override manual choices.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies', nlEnabled: async () => false, voiceEnabled: async () => false,
}))
const qb = vi.hoisted(() => ({ live: [] as unknown[], writes: 0 }))
vi.mock('@/apps/quickbooks/client', () => ({
  qboEscape: (s: string) => s,
  queryQBO: async () => ({ Item: qb.live }),
  qbApiRequest: async () => { qb.writes++; throw new Error('no QB writes in tests') },
}))
const auth = vi.hoisted(() => ({ role: 'manager' as string | null }))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => (auth.role ? { name: `Test ${auth.role}`, role: auth.role } : null),
  isManagerRole: (r: string | null) => r === 'manager' || r === 'admin',
}))

import { seedProductionCatalog, LIVE_QB_ITEMS, CLEAR_TABLES } from './catalog-fixture.test-support'
import {
  listShortcuts, createShortcut, updateShortcut, moveShortcut, hideShortcut, restoreShortcut, updateCatalogService, approveAlias,
  removeAlias, usageSuggestions, catalogReviewQueue, confirmServiceRole,
} from './shortcuts'
import { GET as manageGET, POST as managePOST } from '@/app/api/quick-entry/services/route'
import { GET as catalogGET } from '@/app/api/quick-entry/catalog/route'
import { getOrCreateEstimate, addService, setServicePrice, getEstimateView } from '@/apps/workflow/estimate-db'
import { interpretServiceEntry } from './service-match-db'
import { serviceCatalog, serviceShortcuts, serviceCatalogEvents, serviceAliases, vehicles, serviceOrders } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let CAT: Record<string, string> = {}
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  qb.live = LIVE_QB_ITEMS; qb.writes = 0; auth.role = 'manager'
  CAT = await seedProductionCatalog(db)
})
const req = (body?: unknown) => new Request('http://x/api/quick-entry/services', body ? { method: 'POST', body: JSON.stringify(body) } : undefined)
const auditTypes = async () => (await db.select().from(serviceCatalogEvents)).map((e) => e.eventType).filter((t) => t !== 'catalog_seeded')

describe('permissions (server-side)', () => {
  it('employees and signed-out users cannot read or change service configuration', async () => {
    for (const role of ['employee', null]) {
      auth.role = role
      expect((await manageGET(req())).status).toBe(403)
      expect((await managePOST(req({ action: 'hide', id: 'x' }))).status).toBe(403)
    }
    expect(await auditTypes()).toEqual([])
  })
  it('managers and admins can; employees still SEE the active shortcuts on the intake screen', async () => {
    auth.role = 'admin'
    const g = await (await manageGET(req())).json()
    expect(g.ok).toBe(true)
    expect(g.shortcuts).toHaveLength(14)
    expect(g.qbItems.find((i: { id: string }) => i.id === '1010000001')).toMatchObject({ name: 'Part', type: 'NonInventory' })
    auth.role = 'employee'
    const menu = await (await catalogGET()).json()
    expect(menu.packages.map((p: { name: string }) => p.name)).toEqual([
      'Interior Detail', 'Exterior Wash', 'Mini Detail', 'Polish', 'Wax', 'Clay Bar', 'Headlight Restoration', 'Paint Touch-Up',
      'Leather Conditioner', 'Cabin Air Filter', 'Engine Bay', 'Air Duct Cleaning', 'Ozone Treatment', 'Complete Odor Treatment'])
    expect(menu.packages.find((p: { name: string }) => p.name === 'Polish')).toMatchObject({ id: CAT.paint_correction_1step, group: 'Paint & exterior' })
  })
})

describe('shortcut lifecycle — identity preserved, nothing historical rewritten', () => {
  it('rename / regroup / reorder / hide / restore only change the shortcut, never the catalog or QB mapping (audited)', async () => {
    const before = (await db.select().from(serviceCatalog).where(eq(serviceCatalog.id, CAT.exterior_wax)))[0]
    const wax = (await listShortcuts()).find((s) => s.catalogId === CAT.exterior_wax)!
    await updateShortcut(wax.id, { label: 'Hand Wax', group: 'Details & washes' }, 'Owner')
    await moveShortcut(wax.id, 'up', 'Owner')
    await hideShortcut(wax.id, 'Owner')
    expect((await listShortcuts()).some((s) => s.catalogId === CAT.exterior_wax)).toBe(false)
    expect((await listShortcuts({ includeHidden: true })).find((s) => s.id === wax.id)).toMatchObject({ hidden: true, label: 'Hand Wax' })
    await restoreShortcut(wax.id, 'Owner')
    const after = (await db.select().from(serviceCatalog).where(eq(serviceCatalog.id, CAT.exterior_wax)))[0]
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null })   // catalog row untouched
    expect(await auditTypes()).toEqual(['shortcut_updated', 'shortcut_moved', 'shortcut_hidden', 'shortcut_restored'])
  })

  it('hiding a shortcut keeps existing estimate lines and keeps the service searchable', async () => {
    const [v] = await db.insert(vehicles).values({ make: 'Kia' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: 'MS-1', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
    const est = await getOrCreateEstimate(o.id, 'M')
    const svc = await addService(est.id, 'Clay Bar', { catalogId: CAT.clay_bar, actor: 'M' })
    await setServicePrice(est.id, svc.id, 20000, 'M')
    const clay = (await listShortcuts()).find((s) => s.catalogId === CAT.clay_bar)!
    await hideShortcut(clay.id, 'Owner')
    expect((await getEstimateView(o.id)).services[0]).toMatchObject({ catalogId: CAT.clay_bar, priceCents: 20000 })
    expect((await interpretServiceEntry('clay bar', { useAi: false })).interpretation.candidates[0].catalogId).toBe(CAT.clay_bar)
  })

  it('changing default description/price applies to future additions; tiered prices are not edited here', async () => {
    await updateCatalogService(CAT.clay_bar, { description: 'Decontaminate paint with a clay bar.', priceMode: 'fixed', defaultPriceCents: 22500 }, 'Owner')
    const c = (await db.select().from(serviceCatalog).where(eq(serviceCatalog.id, CAT.clay_bar)))[0]
    expect(c).toMatchObject({ qbDescription: 'Decontaminate paint with a clay bar.', defaultPriceCents: 22500, qbItemRef: '67' })
    await expect(updateCatalogService(CAT.interior_detail, { priceMode: 'fixed', defaultPriceCents: 1 }, 'Owner')).rejects.toThrow(/size\/condition/)
    const ev = (await db.select().from(serviceCatalogEvents).where(eq(serviceCatalogEvents.eventType, 'catalog_updated')))[0]
    expect(JSON.parse(ev.note!)).toMatchObject({ before: { defaultPriceCents: 20000 }, after: { defaultPriceCents: 22500, description: 'Decontaminate paint with a clay bar.' } })
  })

  it('QuickBooks item is SELECTED from live items (validated) — never created; can be explicitly unmapped', async () => {
    await updateCatalogService(CAT.air_duct_cleaning, { qbItemRef: '76' }, 'Owner')
    expect((await db.select().from(serviceCatalog).where(eq(serviceCatalog.id, CAT.air_duct_cleaning)))[0]).toMatchObject({ qbItemRef: '76', qbItemStatus: 'existing', qbSyncEnabled: true })
    await expect(updateCatalogService(CAT.air_duct_cleaning, { qbItemRef: '999999' }, 'Owner')).rejects.toThrow(/not found/)
    await updateCatalogService(CAT.air_duct_cleaning, { qbItemRef: null }, 'Owner')
    expect((await db.select().from(serviceCatalog).where(eq(serviceCatalog.id, CAT.air_duct_cleaning)))[0]).toMatchObject({ qbItemStatus: 'mapping_review', qbSyncEnabled: false })
    expect(qb.writes).toBe(0)
  })

  it('adding a NEW service refuses duplicates of existing names/alternate names and makes the QB mapping explicit', async () => {
    await expect(createShortcut({ newService: { name: 'clay bar', priceMode: 'manual', qbItemRef: null } }, 'Owner')).rejects.toThrow(/already exists/)
    await expect(createShortcut({ newService: { name: 'Headlights', priceMode: 'manual', qbItemRef: null } }, 'Owner')).rejects.toThrow(/alternate name/)
    const id = await createShortcut({ newService: { name: 'Pet Hair Removal', description: 'Remove embedded pet hair from carpets and upholstery.', priceMode: 'manual', qbItemRef: null }, group: 'Interior & engine' }, 'Owner')
    const sc = (await listShortcuts()).find((s) => s.id === id)!
    expect(sc).toMatchObject({ label: 'Pet Hair Removal', priceBehavior: 'manual', qbMapped: false, description: 'Remove embedded pet hair from carpets and upholstery.' })
    expect((await catalogReviewQueue()).some((r) => r.catalogId === sc.catalogId)).toBe(true)   // visible as needing a QB item
    await expect(createShortcut({ catalogId: sc.catalogId }, 'Owner')).rejects.toThrow(/already has a shortcut/)
    expect(qb.writes).toBe(0)
  })

  it('refuses dealer packages', async () => {
    await expect(createShortcut({ catalogId: CAT.dealer_complete_detail_standard }, 'Owner')).rejects.toThrow(/Dealer/)
  })
})

describe('approved alternate names', () => {
  it('a manager-approved phrase becomes an established match; ambiguous phrases are refused', async () => {
    await approveAlias(CAT.seat_shampoo, 'shampoo seats', 'Owner')
    const r = await interpretServiceEntry('Shampoo  seats', { useAi: false })
    expect(r.interpretation).toMatchObject({ status: 'resolved', source: 'alias' })
    await expect(approveAlias(CAT.clay_bar, 'shampoo seats', 'Owner')).rejects.toThrow(/different service/)
    await expect(approveAlias(CAT.odor_ozone, 'remove smell', 'Owner')).rejects.toThrow(/odor/)
    await expect(approveAlias(CAT.clay_bar, 'Exterior Wash', 'Owner')).rejects.toThrow(/name of another service/)
    const [a] = await db.select().from(serviceAliases).where(eq(serviceAliases.alias, 'shampoo seats'))
    expect(a).toMatchObject({ source: 'manager', approvedBy: 'Owner' })
    await removeAlias(a.id, 'Owner')
    expect(await auditTypes()).toEqual(['alias_approved', 'alias_removed'])
    const [qbAlias] = await db.select().from(serviceAliases).where(eq(serviceAliases.alias, 'Clean Motor'))
    await expect(removeAlias(qbAlias.id, 'Owner')).rejects.toThrow(/Only alternate names approved in this app/)
  })
})

describe('review queue + usage suggestions', () => {
  it('lists unresolved catalog decisions, incl. the ambiguous Odor / Ozone name, until confirmed', async () => {
    const q = await catalogReviewQueue()
    const ozone = q.find((r) => r.catalogId === CAT.odor_ozone)!
    expect(ozone.reasons.join(' ')).toMatch(/Confirm it is the Ozone Treatment option/)
    expect(q.find((r) => r.catalogId === CAT.complete_odor_treatment)!.qbCandidateRef).toBe('68')
    await confirmServiceRole(CAT.odor_ozone, 'Owner')
    expect((await catalogReviewQueue()).some((r) => r.catalogId === CAT.odor_ozone)).toBe(false)
  })
  it('usage suggestions are read-only and never re-add a shortcut a manager hid', async () => {
    const wax = (await listShortcuts()).find((s) => s.catalogId === CAT.exterior_wax)!
    await hideShortcut(wax.id, 'Owner')
    const [v] = await db.insert(vehicles).values({ make: 'Kia' }).returning()
    for (let i = 0; i < 3; i++) {
      const [o] = await db.insert(serviceOrders).values({ orderNumber: `U-${i}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
      const est = await getOrCreateEstimate(o.id, 'M')
      await addService(est.id, 'Wax', { catalogId: CAT.exterior_wax, actor: 'M' })
    }
    const s = await usageSuggestions(90)
    expect(s.find((x) => x.catalogId === CAT.exterior_wax)).toMatchObject({ jobs: 3, hasShortcut: false })
    expect((await listShortcuts()).some((x) => x.catalogId === CAT.exterior_wax)).toBe(false)
    expect((await db.select().from(serviceShortcuts).where(eq(serviceShortcuts.catalogId, CAT.exterior_wax)))[0].hiddenAt).not.toBeNull()
  })
})
