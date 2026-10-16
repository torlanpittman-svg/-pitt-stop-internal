/**
 * Price suggestions come from a line's STABLE catalog identity, never from re-resolving its editable
 * name. Reproduces the production defect: "Ozone Treatment" (no default price) was offered $300 from the
 * retired "Odor / Ozone Treatment" package through that package's old "Ozone Treatment" alias.
 * PGlite + the production-shaped catalog (migrations 0052 + 0053); no QB/network.
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
  shopSuppliesLabel: async () => 'Shop supplies',
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, getEstimateView, seedSuggestedPrices, renameService } from '@/apps/workflow/estimate-db'
import { suggestedPricesForCatalogIds, suggestedPriceIndex } from '@/apps/quick-entry/db'
import { serviceOrders, vehicles, serviceCatalog, serviceAliases } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let ids: Record<string, string>
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  ids = await seedProductionCatalog(db)
})

async function freshEstimate() {
  const [v] = await db.insert(vehicles).values({ make: 'Ford' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `SG-${Math.floor(Math.random() * 1e9)}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
  return { orderId: o.id, est: await getOrCreateEstimate(o.id, 'M') }
}

describe('the production catalog reproduces the conflict', () => {
  it('the retired package still has a $300 default and an "Ozone Treatment" alias; the new Ozone row has no price', async () => {
    const [old] = await db.select().from(serviceCatalog).where(eq(serviceCatalog.slug, 'odor_ozone'))
    const [ozone] = await db.select().from(serviceCatalog).where(eq(serviceCatalog.slug, 'ozone_treatment'))
    expect(old).toMatchObject({ active: false, defaultPriceCents: 30000 })
    expect(ozone).toMatchObject({ active: true, defaultPriceCents: null, name: 'Ozone Treatment' })
    const aliases = await db.select().from(serviceAliases).where(eq(serviceAliases.catalogId, old.id))
    expect(aliases.map((a) => a.alias)).toContain('Ozone Treatment')
  })
})

describe('suggestions by catalog identity', () => {
  it('Ozone Treatment (no default price) gets NO suggestion — never the old package’s $300', async () => {
    const { orderId, est } = await freshEstimate()
    await addService(est.id, 'Ozone Treatment', { catalogId: ids.ozone_treatment, actor: 'M' })
    const v = await getEstimateView(orderId)
    expect(v.services[0]).toMatchObject({ title: 'Ozone Treatment', catalogName: 'Ozone Treatment', suggestedCents: null })
    expect(await suggestedPricesForCatalogIds([ids.ozone_treatment])).toEqual({})
  })

  it('a priced service suggests its own default, and keeps it after the line is renamed', async () => {
    const { orderId, est } = await freshEstimate()
    const svc = await addService(est.id, 'Headlight Restoration', { catalogId: ids.headlight_restoration, actor: 'M' })
    expect((await getEstimateView(orderId)).services[0].suggestedCents).toBe(15000)
    await renameService(orderId, svc.id, 'Both headlights — yellowed', 'M')
    const after = (await getEstimateView(orderId)).services[0]
    expect(after).toMatchObject({ title: 'Both headlights — yellowed', catalogName: 'Headlight Restoration', suggestedCents: 15000 })
  })

  it('a renamed Ozone line whose new name matches another priced service still gets no suggestion', async () => {
    const { orderId, est } = await freshEstimate()
    const svc = await addService(est.id, 'Ozone Treatment', { catalogId: ids.ozone_treatment, actor: 'M' })
    await renameService(orderId, svc.id, 'Headlight Restoration', 'M')
    expect((await getEstimateView(orderId)).services[0]).toMatchObject({ catalogName: 'Ozone Treatment', suggestedCents: null })
  })

  it('a custom line with no catalog identity gets no suggestion, even when its label equals a priced service', async () => {
    const { orderId, est } = await freshEstimate()
    await addService(est.id, 'Headlight Restoration', { custom: true, actor: 'M' })
    expect((await getEstimateView(orderId)).services[0]).toMatchObject({ catalogId: null, suggestedCents: null })
  })

  it('size-priced services suggest their lowest tier; archived rows suggest nothing', () => {
    expect(suggestedPriceIndex([{ id: 'a', defaultPriceCents: null }, { id: 'b', defaultPriceCents: 9000 }],
      [{ catalogId: 'a', startPriceCents: 30000 }, { catalogId: 'a', startPriceCents: 25000 }, { catalogId: 'b', startPriceCents: 1 }, { catalogId: 'gone', startPriceCents: 5 }]))
      .toEqual({ a: 25000, b: 9000 })
  })
})

describe('the three separate odor services use only their own approved defaults (0056)', () => {
  it('Odor Treatment and Air Duct Cleaning have no default → no suggestion and no automatic price; never another service’s price', async () => {
    const { orderId, est } = await freshEstimate()
    await addService(est.id, 'Odor Treatment', { catalogId: ids.odor_treatment, actor: 'M' })
    await addService(est.id, 'Air Duct Cleaning', { catalogId: ids.air_duct_cleaning, actor: 'M' })
    await addService(est.id, 'Ozone Treatment', { catalogId: ids.ozone_treatment, actor: 'M' })
    await seedSuggestedPrices(est.id)
    const v = await getEstimateView(orderId)
    expect(v.services.map((s) => [s.title, s.suggestedCents, s.priceCents])).toEqual([
      ['Odor Treatment', null, null], ['Air Duct Cleaning', null, null], ['Ozone Treatment', null, null]])
  })
})

describe('seeding a fresh Job uses the same identity rule (it saves prices, so it matters most)', () => {
  it('prices the priced service, leaves Ozone unpriced', async () => {
    const { orderId, est } = await freshEstimate()
    await addService(est.id, 'Ozone Treatment', { catalogId: ids.ozone_treatment, actor: 'M' })
    await addService(est.id, 'Headlight Restoration', { catalogId: ids.headlight_restoration, actor: 'M' })
    await seedSuggestedPrices(est.id)
    const v = await getEstimateView(orderId)
    expect(Object.fromEntries(v.services.map((s) => [s.title, s.priceCents]))).toEqual({ 'Ozone Treatment': null, 'Headlight Restoration': 15000 })
  })
})
