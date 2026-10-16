/**
 * REGRESSION (red): the seven catalog rows left in `mapping_review` must be finished onto the
 * APPROPRIATE EXISTING QuickBooks items so they stop billing as generic Labor — WITHOUT copying a
 * historical, component-specific QuickBooks description onto an unrelated job, and WITHOUT breaking
 * the owner's odor definitions.
 *
 * The plan below reuses only verified, already-active QuickBooks items (no new products). It encodes
 * the end state the coordinator will apply (catalog data change via the manager app + fixture update).
 * This test guards both that end state and its SAFETY:
 *   - every target is an EXISTING item and the row becomes qbMapped (so the invoice uses that item,
 *     not the generic Labor item '53');
 *   - canonical descriptions preserve SCOPE (Seat Shampoo is not stamped "Clean rear seats"; Painting
 *     keeps a general description, not the historical bumper/hood wording);
 *   - odor definitions hold: Complete = ducts + ozone (approved wording), Air Duct Cleaning = ducts
 *     only, and the legacy "Odor / Ozone Treatment" keeps its fabric-steam description and is never
 *     silently relabeled ozone-only.
 *
 * In-memory PGlite from the real Drizzle schema + production-shaped catalog + migration 0052. No QB
 * network. Fails on baseline: all seven rows are still qbSyncEnabled=false / mapping_review.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

import { seedProductionCatalog, runMigration0053, runMigration0056, LIVE_QB_ITEMS, CLEAR_TABLES } from './catalog-fixture.test-support'
import { interpretServiceEntry } from './service-match-db'
import { listShortcuts } from './shortcuts'
import { loadEligibleCatalog } from './service-match-db'
import { serviceCatalog, serviceAliases, serviceCatalogEvents, serviceShortcuts, vehicles, serviceOrders, jobServices, jobLineItems } from '@/drizzle/schema'
import { getOrCreateEstimate, addService, setServicePrice, getEstimateView } from '@/apps/workflow/estimate-db'

/** Proposed finished mapping: catalog slug → the EXISTING QuickBooks item it should bill under. */
const MAPPING_PLAN: Record<string, string> = {
  air_duct_cleaning: '76',              // "Air duct"       — ducts only
  cabin_air_filter_replacement: '88',   // "Cabin air filter"
  paint_touch_up: '35',                 // "Paint touch up"
  installation_labor: '73',             // "Install"
  seat_shampoo: '23',                   // "Clean seats"
  paint_refinish: '57',                 // "Paint"
  complete_odor_treatment: '68',        // "Odor Treatment" (generic odor item; scope set by our wording)
}
const EXISTING_QB_IDS = new Set(LIVE_QB_ITEMS.map((i) => i.Id))

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
  CAT = await seedProductionCatalog(db)
})

const rowBySlug = async (slug: string) => (await db.select().from(serviceCatalog).where(eq(serviceCatalog.slug, slug)))[0]
async function choiceBySlug(slug: string) {
  const { choices } = await loadEligibleCatalog()
  return [...choices.values()].find((c) => c.slug === slug)!
}

describe('the seven mapping-review rows are finished onto existing QuickBooks items (no more generic Labor)', () => {
  it('each row bills under its intended EXISTING item and is qbMapped', async () => {
    for (const [slug, ref] of Object.entries(MAPPING_PLAN)) {
      expect(EXISTING_QB_IDS.has(ref)).toBe(true)   // reuse only existing items — never a new product
      const row = await rowBySlug(slug)
      expect(row, slug).toBeTruthy()
      expect({ slug, status: row.qbItemStatus, sync: row.qbSyncEnabled, ref: row.qbItemRef })
        .toEqual({ slug, status: 'existing', sync: true, ref })
      // The one flag the invoice builder reads to pick the item vs. the generic Labor fallback. (The
      // Complete Odor Treatment package was retired by 0056 — its mapping is kept for history only.)
      if (slug !== 'complete_odor_treatment') expect((await choiceBySlug(slug)).qbMapped, slug).toBe(true)
    }
  })

  it('none of the seven is left mapping to the generic Labor item (53) or to the NonInventory Part (1010000001)', async () => {
    for (const slug of Object.keys(MAPPING_PLAN)) {
      const ref = (await rowBySlug(slug)).qbItemRef
      expect(ref).not.toBe('53')
      expect(ref).not.toBe('1010000001')
    }
  })
})

describe('canonical descriptions preserve scope (never copy a component-specific historical QB description)', () => {
  it('Seat Shampoo is not stamped with the rear-only "Clean seats" wording', async () => {
    const desc = (await choiceBySlug('seat_shampoo')).description.toLowerCase()
    expect(desc.length).toBeGreaterThan(0)
    expect(desc).not.toBe('clean rear seats')
    expect(desc).not.toContain('rear')         // scope must stay general to "seats"
  })

  it('Painting / Refinishing keeps a general description, not the historical bumper/hood wording', async () => {
    const desc = (await choiceBySlug('paint_refinish')).description.toLowerCase()
    expect(desc).not.toContain('bumper')
    expect(desc).not.toContain('hood')
  })
})

describe('odor definitions survive the mapping', () => {
  it('the retired Complete Odor Treatment record is preserved for history, never repurposed (0056)', async () => {
    const row = await rowBySlug('complete_odor_treatment')
    expect(row).toMatchObject({ name: 'Complete Odor Treatment', serviceRole: 'odor_complete', qbItemRef: '68', active: false, archivedAt: null,
      qbDescription: 'Complete odor treatment, including air duct cleaning and ozone treatment.' })
    expect(await choiceBySlug('complete_odor_treatment')).toBeUndefined()   // never offered for new picks
  })

  it('Air Duct Cleaning is ducts-only: role odor_duct, no ozone/fabric-steam wording', async () => {
    const row = await rowBySlug('air_duct_cleaning')
    expect(row.serviceRole).toBe('odor_duct')
    const desc = (await choiceBySlug('air_duct_cleaning')).description.toLowerCase()
    expect(desc).toMatch(/duct|vent/)
    expect(desc).not.toContain('ozone')
  })

  it('the legacy "Odor / Ozone Treatment" is NOT relabeled ozone-only: fabric-steam description + alias preserved', async () => {
    const row = await rowBySlug('odor_ozone')
    expect(row.serviceRole).toBe('odor_ozone')
    const desc = (row.qbDescription ?? '').toLowerCase()
    expect(desc).toContain('steam')    // fabric steam cleaning scope must remain
    const aliases = (await db.select().from(serviceAliases).where(eq(serviceAliases.catalogId, CAT.odor_ozone))).map((a) => a.alias)
    expect(aliases).toContain('Odor Treatment')
  })
})

describe('0053 — ozone-only service; the legacy combined row keeps its history', () => {
  it('adds "Ozone Treatment" (ozone only, existing QB item #24, price entered per job) and retires the combined row from NEW picks only', async () => {
    const oz = await rowBySlug('ozone_treatment')
    expect(oz).toMatchObject({ name: 'Ozone Treatment', qbItemRef: '24', qbItemStatus: 'existing', qbSyncEnabled: true, qbDescription: 'Ozone treatment.',
      defaultPriceCents: null, serviceRole: 'odor_ozone', active: true })
    expect(oz.roleConfirmedAt).not.toBeNull()
    const legacy = await rowBySlug('odor_ozone')
    // History preserved: same item, price, description, aliases — only no longer offered for new jobs.
    expect(legacy).toMatchObject({ name: 'Odor / Ozone Treatment', qbItemRef: '24', defaultPriceCents: 30000, active: false, archivedAt: null })
    expect((await db.select().from(serviceAliases).where(eq(serviceAliases.catalogId, legacy.id))).map((a) => a.alias).sort()).toEqual(['Odor Treatment', 'Ozone', 'Ozone Treatment'])
    const { choices } = await loadEligibleCatalog()
    expect(choices.has(legacy.id)).toBe(false)
    expect(choices.get(oz.id)).toMatchObject({ qbMapped: true, description: 'Ozone treatment.' })
  })

  it('the "Ozone Treatment" shortcut now points at the ozone-only service — same label, group and order', async () => {
    const sc = (await listShortcuts()).find((s) => s.label === 'Ozone Treatment')!
    expect(sc).toMatchObject({ catalogId: CAT.ozone_treatment, group: 'Odor' })
    expect((await db.select().from(serviceShortcuts).where(eq(serviceShortcuts.catalogId, CAT.odor_ozone)))).toHaveLength(0)
  })

  it('odor wording resolves to the three separate services only (never the combined legacy row or the package)', async () => {
    const r = async (t: string) => (await interpretServiceEntry(t, { useAi: false })).interpretation
    expect(await r('ozone')).toMatchObject({ status: 'resolved', candidates: [{ catalogId: CAT.ozone_treatment }] })
    expect(await r('air duct cleaning')).toMatchObject({ status: 'resolved', candidates: [{ catalogId: CAT.air_duct_cleaning }] })
    expect(await r('odor treatment')).toMatchObject({ status: 'resolved', candidates: [{ catalogId: CAT.odor_treatment }] })
    const both = await r('air ducts + ozone')
    expect(both.status).toBe('choose')
    expect(both.candidates.map((c) => c.catalogId)).toEqual([CAT.ozone_treatment, CAT.air_duct_cleaning])
    const smell = await r('car smells bad')
    expect(smell.status).toBe('choose')
    expect(smell.candidates.map((c) => c.catalogId)).toEqual([CAT.odor_treatment, CAT.ozone_treatment, CAT.air_duct_cleaning])
  })

  it('is idempotent: running 0053 again changes nothing and adds no audit rows', async () => {
    const snap = async () => ({
      cats: (await db.select().from(serviceCatalog)).map((c) => ({ ...c, updatedAt: null })).sort((a, b) => a.slug.localeCompare(b.slug)),
      events: (await db.select().from(serviceCatalogEvents)).length,
      shortcuts: (await db.select().from(serviceShortcuts)).map((s) => ({ ...s, updatedAt: null })).sort((a, b) => a.id.localeCompare(b.id)),
      aliases: (await db.select().from(serviceAliases)).length,
    })
    const before = await snap()
    await runMigration0053(db)
    expect(await snap()).toEqual(before)
    // 7 mappings + ozone seeded + legacy retired + shortcut repointed.
    const types = (await db.select().from(serviceCatalogEvents)).filter((e) => e.actor === 'migration 0053').map((e) => e.eventType)
    expect(types.filter((t) => t === 'qb_item_mapped')).toHaveLength(7)
    expect(types.filter((t) => t !== 'qb_item_mapped').sort()).toEqual(['catalog_retired', 'catalog_seeded', 'shortcut_repointed'])
  })
})

describe('0053 never overrides a manager decision or historical lines', () => {
  beforeEach(async () => {
    for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
    CAT = await seedProductionCatalog(db, { upTo: 52 })
  })

  it('a mapping a manager already chose (or a different candidate) is left exactly as the manager set it', async () => {
    await db.update(serviceCatalog).set({ qbItemRef: '62', qbItemStatus: 'existing', qbSyncEnabled: true }).where(eq(serviceCatalog.slug, 'seat_shampoo'))
    await db.update(serviceCatalog).set({ qbCandidateRef: '99' }).where(eq(serviceCatalog.slug, 'paint_refinish'))
    await runMigration0053(db)
    expect((await rowBySlug('seat_shampoo')).qbItemRef).toBe('62')
    expect(await rowBySlug('paint_refinish')).toMatchObject({ qbItemRef: null, qbItemStatus: 'mapping_review' })
    expect((await rowBySlug('air_duct_cleaning')).qbItemRef).toBe('76')
  })

  it('if a manager already confirmed the legacy row as the ozone option, no second ozone service is created', async () => {
    await db.update(serviceCatalog).set({ roleConfirmedAt: new Date(), roleConfirmedBy: 'Owner' }).where(eq(serviceCatalog.slug, 'odor_ozone'))
    await runMigration0053(db)
    expect(await rowBySlug('ozone_treatment')).toBeUndefined()
    expect((await rowBySlug('odor_ozone')).active).toBe(true)
  })

  it('an existing estimate line on the legacy combined service keeps its item, wording, and price after 0053', async () => {
    const [v] = await db.insert(vehicles).values({ make: 'Kia' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: 'OZ-1', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
    const est = await getOrCreateEstimate(o.id, 'M')
    const svc = await addService(est.id, 'Odor / Ozone Treatment', { catalogId: CAT.odor_ozone, actor: 'M' })
    await setServicePrice(est.id, svc.id, 30000, 'M')
    const before = { svc: (await db.select().from(jobServices).where(eq(jobServices.id, svc.id)))[0], line: (await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, svc.id)))[0] }
    await runMigration0053(db)
    expect((await db.select().from(jobServices).where(eq(jobServices.id, svc.id)))[0]).toEqual(before.svc)
    expect((await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, svc.id)))[0]).toEqual(before.line)
    expect((await getEstimateView(o.id)).services[0]).toMatchObject({ catalogId: CAT.odor_ozone, qbMapped: true, priceCents: 30000,
      description: expect.stringContaining('steam cleaning') })
  })
})

describe('0056 — three separate odor services; the package is retired, never repurposed', () => {
  const ODOR_DESC = 'Steam cleaning the entire interior and using smoke odor removal products to get rid of the smells.'
  const snapRow = async (slug: string) => { const r = await rowBySlug(slug); return r && { ...r, updatedAt: null, notes: null } }

  it('adds Odor Treatment on the existing QuickBooks "Odor Treatment" item (#68, not Ozone #24), owner wording, no default price', async () => {
    const odor = await rowBySlug('odor_treatment')
    expect(odor).toMatchObject({ name: 'Odor Treatment', qbItemRef: '68', qbItemStatus: 'existing', qbSyncEnabled: true, qbDescription: ODOR_DESC,
      defaultPriceCents: null, serviceRole: 'odor_treatment', active: true, archivedAt: null, reviewFlag: false })
    expect(odor.roleConfirmedAt).not.toBeNull()
    expect(LIVE_QB_ITEMS.find((i) => i.Id === '68')).toMatchObject({ Name: 'Odor Treatment', Active: true })
    expect(await choiceBySlug('odor_treatment')).toMatchObject({ qbMapped: true, description: ODOR_DESC, defaultPriceCents: null })
  })

  it('the three odor services are the only odor choices offered; retired records are not', async () => {
    const { choices } = await loadEligibleCatalog()
    const odorish = [...choices.values()].filter((c) => /odor|ozone|duct/i.test(c.name)).map((c) => c.slug).sort()
    expect(odorish).toEqual(['air_duct_cleaning', 'odor_treatment', 'ozone_treatment'])
  })

  it('Ozone Treatment and Air Duct Cleaning are left exactly as they were (approved descriptions kept)', async () => {
    for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
    CAT = await seedProductionCatalog(db, { upTo: 53 })
    const before = { oz: await snapRow('ozone_treatment'), duct: await snapRow('air_duct_cleaning'), legacy: await snapRow('odor_ozone') }
    await runMigration0056(db)
    expect({ oz: await snapRow('ozone_treatment'), duct: await snapRow('air_duct_cleaning'), legacy: await snapRow('odor_ozone') }).toEqual(before)
    expect((await rowBySlug('ozone_treatment')).qbDescription).toBe('Ozone treatment.')
  })

  it('retires Complete Odor Treatment from new picks without changing what the record means', async () => {
    const pkg = await rowBySlug('complete_odor_treatment')
    expect(pkg).toMatchObject({ name: 'Complete Odor Treatment', active: false, archivedAt: null, qbItemRef: '68', serviceRole: 'odor_complete',
      qbDescription: 'Complete odor treatment, including air duct cleaning and ozone treatment.' })
  })

  it('points the package shortcut at Odor Treatment, relabelled, same group and order', async () => {
    const sc = (await db.select().from(serviceShortcuts)).filter((x) => x.catalogId === CAT.odor_treatment)
    expect(sc).toHaveLength(1)
    expect(sc[0]).toMatchObject({ label: 'Odor Treatment', groupName: 'Odor', sortOrder: 30, hiddenAt: null })
    expect((await db.select().from(serviceShortcuts)).filter((x) => x.catalogId === CAT.complete_odor_treatment)).toHaveLength(0)
  })

  it('is idempotent and audited: re-running changes nothing; exactly one seeded / retired / repointed event', async () => {
    const snap = async () => ({
      cats: (await db.select().from(serviceCatalog)).map((c) => ({ ...c, updatedAt: null })).sort((a, b) => a.slug.localeCompare(b.slug)),
      events: (await db.select().from(serviceCatalogEvents)).length,
      shortcuts: (await db.select().from(serviceShortcuts)).map((x) => ({ ...x, updatedAt: null })).sort((a, b) => a.id.localeCompare(b.id)),
      aliases: (await db.select().from(serviceAliases)).length,
    })
    const before = await snap()
    await runMigration0056(db)
    expect(await snap()).toEqual(before)
    const types = (await db.select().from(serviceCatalogEvents)).filter((e) => e.actor === 'migration 0056').map((e) => e.eventType).sort()
    expect(types).toEqual(['catalog_retired', 'catalog_seeded', 'shortcut_repointed'])
  })

  it('never overwrites a manager decision: an existing Odor Treatment record and shortcut are left as the manager set them', async () => {
    for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
    CAT = await seedProductionCatalog(db, { upTo: 53 })
    const [mine] = await db.insert(serviceCatalog).values({ slug: 'odor_treatment', name: 'Odor Treatment', kind: 'addon', quickEntry: true, defaultPriceCents: 12500,
      sortOrder: 300, source: 'manager', qbItemRef: '68', qbItemStatus: 'existing', qbSyncEnabled: true, qbDescription: 'Manager wording.' }).returning()
    await db.insert(serviceShortcuts).values({ catalogId: mine.id, label: 'Odor (manager)', groupName: 'Odor', sortOrder: 5, createdBy: 'Manager' })
    await runMigration0056(db)
    expect(await rowBySlug('odor_treatment')).toMatchObject({ id: mine.id, defaultPriceCents: 12500, qbDescription: 'Manager wording.' })
    // The package shortcut is not moved onto a service that already has one (it stays, on the retired record, for the manager to hide).
    expect((await db.select().from(serviceShortcuts)).filter((x) => x.catalogId === mine.id).map((x) => x.label)).toEqual(['Odor (manager)'])
  })

  it('an existing estimate line on the package keeps its identity, wording and price after 0056', async () => {
    for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
    CAT = await seedProductionCatalog(db, { upTo: 53 })
    const [v] = await db.insert(vehicles).values({ make: 'Ford' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: 'PKG-1', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
    const est = await getOrCreateEstimate(o.id, 'M')
    const line = await addService(est.id, 'Complete Odor Treatment', { catalogId: CAT.complete_odor_treatment, actor: 'M' })
    await setServicePrice(est.id, line.id, 35000, 'M')
    await runMigration0056(db)
    const [after] = await db.select().from(jobServices).where(eq(jobServices.id, line.id))
    expect(after.catalogId).toBe(CAT.complete_odor_treatment)
    expect((await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, line.id)))[0].priceCents).toBe(35000)
    expect((await getEstimateView(o.id)).services[0]).toMatchObject({ catalogName: 'Complete Odor Treatment', description: 'Complete odor treatment, including air duct cleaning and ozone treatment.', matchState: 'choose' })
  })
})
