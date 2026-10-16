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

import { seedProductionCatalog, runMigration0053, LIVE_QB_ITEMS, CLEAR_TABLES } from './catalog-fixture.test-support'
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
      // The one flag the invoice builder reads to pick the item vs. the generic Labor fallback.
      expect((await choiceBySlug(slug)).qbMapped, slug).toBe(true)
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
  it('Complete Odor Treatment keeps the approved ducts+ozone wording and its odor_complete role', async () => {
    const row = await rowBySlug('complete_odor_treatment')
    expect(row.serviceRole).toBe('odor_complete')
    expect((await choiceBySlug('complete_odor_treatment')).description)
      .toBe('Complete odor treatment, including air duct cleaning and ozone treatment.')
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

  it('odor wording resolves to the three owner-defined options only (never the combined legacy row)', async () => {
    const r = async (t: string) => (await interpretServiceEntry(t, { useAi: false })).interpretation
    expect(await r('ozone')).toMatchObject({ status: 'resolved', candidates: [{ catalogId: CAT.ozone_treatment }] })
    expect(await r('air ducts + ozone')).toMatchObject({ status: 'resolved', candidates: [{ catalogId: CAT.complete_odor_treatment }] })
    expect(await r('air duct cleaning')).toMatchObject({ status: 'resolved', candidates: [{ catalogId: CAT.air_duct_cleaning }] })
    const smell = await r('car smells bad')
    expect(smell.status).toBe('choose')
    expect(smell.candidates.map((c) => c.catalogId).sort()).toEqual([CAT.air_duct_cleaning, CAT.complete_odor_treatment, CAT.ozone_treatment].sort())
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
