/**
 * Service catalog IDENTITY → QuickBooks payload preservation.
 *
 * Reproduces and guards the reported bug: editing a service LABEL (e.g. "Full Detail" →
 * "Full Detail - customer vehicle") must NOT change the QuickBooks Product/Service item or the
 * canonical qb_description on the invoice line. The service carries a stable job_services.catalog_id
 * identity, and the SHARED retail payload (buildRetailWorkPayload — used for standalone QB estimates
 * AND invoice create/sync) resolves the item from that identity, not the label.
 *
 * Driven against an in-memory PGlite pushed from the real Drizzle schema, with QuickBooks IO mocked
 * (no external credentials/DB, no network, no sends). Exercises the real rename SQL, the real
 * live-item mapping, and — for the backfill — the ACTUAL migration 0051 .sql file.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { sql } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

// Fees disabled + non-taxable detailing → the draft total is exactly the sum of service prices,
// so the payload's Σlines === total invariant holds without fee/tax lines in the way.
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({
    shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0,
    paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825,
  }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))

// Live QuickBooks item list (loadRetailItemIndex) — the catalog's mapped items plus unrelated ones.
let LIVE_ITEMS: Array<{ Id: string; Name: string; Active?: boolean }> = []
vi.mock('@/apps/quickbooks/client', () => ({
  queryQBO: async () => ({ Item: LIVE_ITEMS }),
}))
// The generic Labor / Fees items are resolved separately; stub them (no QB write).
vi.mock('@/apps/quickbooks/retail-invoice-write', () => ({
  resolveRetailItems: async () => ({ labor: 'ITEM-LABOR', fees: 'ITEM-FEES' }),
}))

import { getOrCreateEstimate, promoteTextServices, setServicePrice, getFullEstimate, renameService, updateService, getEstimateView, addService, recomputeEstimate, removeEstimateService, prepareEstimateView } from '@/apps/workflow/estimate-db'
import { buildRetailWorkPayload } from '@/apps/quickbooks/retail-invoice-service'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import type { OrderWithContext } from '@/apps/workflow/db'
import { serviceOrders, vehicles, serviceCatalog, serviceAliases, jobServices, jobLineItems, jobEstimates, serviceOrderEvents } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0
// Catalog ids (set per test run).
let FD = '', OLD = '', SH = '', CC = '', FM = ''

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})

beforeEach(async () => {
  for (const t of ['job_line_items', 'job_services', 'job_estimates', 'service_order_events', 'service_orders', 'vehicles', 'service_aliases', 'service_catalog']) {
    await db.execute(`DELETE FROM ${t}`)
  }
  LIVE_ITEMS = [
    { Id: 'QBI-FULL', Name: 'Full Detail', Active: true },
    { Id: 'QBI-WASH', Name: 'Express Wash', Active: true },
    { Id: 'QBI-OLD', Name: 'Legacy Package', Active: true },
    { Id: 'QBI-SHAMPOO', Name: 'Interior Shampoo', Active: true },
    { Id: 'QBI-CERAMIC', Name: 'Ceramic Coating', Active: true },
    { Id: 'QBI-DEALERCERAMIC', Name: 'Dealer Ceramic', Active: true },
    { Id: 'QBI-MATS', Name: 'Floor Mats', Active: true },
  ]
  const [fd] = await db.insert(serviceCatalog).values({ slug: 'full-detail', name: 'Full Detail', kind: 'package', qbItemRef: 'QBI-FULL', qbDescription: 'Complete interior & exterior detail', qbSyncEnabled: true }).returning()
  await db.insert(serviceCatalog).values({ slug: 'express-wash', name: 'Express Wash', kind: 'package', qbItemRef: 'QBI-WASH', qbDescription: 'Exterior express hand wash', qbSyncEnabled: true })
  const [old] = await db.insert(serviceCatalog).values({ slug: 'legacy-package', name: 'Legacy Package', kind: 'package', qbItemRef: 'QBI-OLD', qbDescription: 'Legacy package', qbSyncEnabled: true, archivedAt: new Date() }).returning()
  // A catalog item with NO managed description → the line falls back to the canonical NAME, never
  // the editable label (finding 3).
  const [sh] = await db.insert(serviceCatalog).values({ slug: 'interior-shampoo', name: 'Interior Shampoo', kind: 'addon', qbItemRef: 'QBI-SHAMPOO', qbDescription: null, qbSyncEnabled: true }).returning()
  // A canonical NAME that another catalog carries as an ALIAS → the name must win (finding: no
  // Labor regression for an exact canonical name).
  const [cc] = await db.insert(serviceCatalog).values({ slug: 'ceramic-coating', name: 'Ceramic Coating', kind: 'package', qbItemRef: 'QBI-CERAMIC', qbDescription: 'Ceramic coating package', qbSyncEnabled: true }).returning()
  const [dealer] = await db.insert(serviceCatalog).values({ slug: 'dealer-ceramic', name: 'Dealer Ceramic', kind: 'package', qbItemRef: 'QBI-DEALERCERAMIC', qbDescription: 'Dealer ceramic', qbSyncEnabled: true }).returning()
  // A catalog item with QB mapping deliberately DISABLED → Labor fallback with its own canonical text.
  const [fm] = await db.insert(serviceCatalog).values({ slug: 'floor-mats', name: 'Floor Mats', kind: 'addon', qbItemRef: 'QBI-MATS', qbDescription: 'Floor mats', qbSyncEnabled: false }).returning()
  FD = fd.id; OLD = old.id; SH = sh.id; CC = cc.id; FM = fm.id
  await db.insert(serviceAliases).values({ catalogId: fd.id, alias: 'Full Service Detail' })   // alias identity
  await db.insert(serviceAliases).values({ catalogId: dealer.id, alias: 'Ceramic Coating' })    // alias colliding with a NAME
})

async function makeOrder(services: string[]) {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2020', vin: '1FTFW1E50LFA00001' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: `CI-TEST-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived',
    customerName: 'Jane Customer', services,
  }).returning()
  const est = await getOrCreateEstimate(o.id, 'Manager')
  await promoteTextServices(est.id, o.id)
  return { orderId: o.id, estimateId: est.id }
}

/** The OrderWithContext shape buildInvoiceDraft / buildRetailWorkPayload read (vehicle + labels). */
function orderContext(orderId: string, services: string[]): OrderWithContext {
  return {
    id: orderId, customerName: 'Jane Customer', services, source: 'quick_entry', serviceType: 'retail',
    vehicle: { year: '2020', make: 'Ford', model: 'F-150', vin: '1FTFW1E50LFA00001', licensePlate: null },
  } as unknown as OrderWithContext
}

/** Build the real shared retail payload for an order (the exact builder used by QB create/sync + estimates). */
async function payloadFor(orderId: string, services: string[]) {
  const full = await getFullEstimate(orderId)
  const draft = buildInvoiceDraft({ order: orderContext(orderId, services), full, paymentLabel: 'Card charge', role: 'admin' })
  const { payload, fallbacks } = await buildRetailWorkPayload({ estimateId: full!.estimate.id, order: orderContext(orderId, services), full, draft })
  return { payload, fallbacks, draft }
}

async function priceByTitle(orderId: string, estimateId: string, title: string, cents: number) {
  const view = await getEstimateView(orderId)
  const svc = view.services.find((s) => s.title === title)!
  await setServicePrice(estimateId, svc.id, cents, 'Manager')
  return svc.id
}

describe('catalog identity preserves the QB item + canonical description across label edits', () => {
  it('stamps catalog identity on promote and uses the catalog item + description (not the label)', async () => {
    const { orderId, estimateId } = await makeOrder(['Full Detail'])
    await priceByTitle(orderId, estimateId, 'Full Detail', 25000)
    const [svc] = await db.select().from(jobServices).where(sql`title = 'Full Detail'`)
    expect(svc.catalogId).toBe(FD)

    const { payload, fallbacks } = await payloadFor(orderId, ['Full Detail'])
    expect(fallbacks).toEqual([])
    expect(payload.lines).toHaveLength(1)
    expect(payload.lines[0]).toMatchObject({ itemId: 'QBI-FULL', description: 'Complete interior & exterior detail', amountCents: 25000 })
    expect(payload.totalCents).toBe(25000)
  })

  it('renaming the label keeps the SAME QB item, canonical description, and price', async () => {
    const services = ['Full Detail', 'Express Wash']
    const { orderId, estimateId } = await makeOrder(services)
    const fdId = await priceByTitle(orderId, estimateId, 'Full Detail', 25000)
    await priceByTitle(orderId, estimateId, 'Express Wash', 4000)

    const before = await payloadFor(orderId, services)
    await renameService(orderId, fdId, 'Full Detail - customer vehicle', 'Manager')   // the reported edit

    const after = await payloadFor(orderId, ['Full Detail - customer vehicle', 'Express Wash'])
    const beforeFull = before.payload.lines.find((l) => l.itemId === 'QBI-FULL')!
    const afterFull = after.payload.lines.find((l) => l.itemId === 'QBI-FULL')!
    expect(afterFull).toEqual(beforeFull)                      // same item, description, amount
    expect(afterFull.description).toBe('Complete interior & exterior detail')
    expect(after.fallbacks).toEqual([])                        // never fell back to Labor
    expect(after.payload.totalCents).toBe(29000)
    const [svc] = await db.select().from(jobServices).where(sql`id = ${fdId}::uuid`)
    expect(svc).toMatchObject({ title: 'Full Detail - customer vehicle', catalogId: FD })
  })

  it('rename survives removing another service and reopening: same QB item + description, removed line gone', async () => {
    const services = ['Full Detail', 'Express Wash']
    const { orderId, estimateId } = await makeOrder(services)
    const fdId = await priceByTitle(orderId, estimateId, 'Full Detail', 25000)
    const ewId = await priceByTitle(orderId, estimateId, 'Express Wash', 4000)

    await renameService(orderId, fdId, 'Full Detail - customer vehicle', 'Manager')
    await removeEstimateService(orderId, ewId, 'Manager')
    await prepareEstimateView(orderId, 'Manager')   // leave + reopen: nothing is re-promoted
    await prepareEstimateView(orderId, 'Manager')

    const [o] = await db.select().from(serviceOrders).where(sql`id = ${orderId}::uuid`)
    expect(o.services).toEqual(['Full Detail - customer vehicle'])
    const { payload, fallbacks } = await payloadFor(orderId, o.services!)
    expect(fallbacks).toEqual([])
    expect(payload.lines).toHaveLength(1)
    expect(payload.lines[0]).toMatchObject({ itemId: 'QBI-FULL', description: 'Complete interior & exterior detail', amountCents: 25000 })
    expect(payload.totalCents).toBe(25000)
    const [svc] = await db.select().from(jobServices).where(sql`id = ${fdId}::uuid`)
    expect(svc).toMatchObject({ title: 'Full Detail - customer vehicle', catalogId: FD })
  })

  it('repeated renames — including to ANOTHER catalog item name — never repoint the original item', async () => {
    const { orderId, estimateId } = await makeOrder(['Full Detail'])
    const fdId = await priceByTitle(orderId, estimateId, 'Full Detail', 25000)
    await renameService(orderId, fdId, 'Express Wash', 'Manager')          // another catalog item's name
    await renameService(orderId, fdId, 'Express Wash - rush', 'Manager')   // and again
    const { payload } = await payloadFor(orderId, ['Express Wash - rush'])
    expect(payload.lines[0]).toMatchObject({ itemId: 'QBI-FULL', description: 'Complete interior & exterior detail' })
    const [svc] = await db.select().from(jobServices).where(sql`id = ${fdId}::uuid`)
    expect(svc.catalogId).toBe(FD)   // locked to the original identity
  })

  it('a custom typo that originally did not match resolves when corrected to a catalog name', async () => {
    const { orderId, estimateId } = await makeOrder(['Ful Detail'])
    const sid = await priceByTitle(orderId, estimateId, 'Ful Detail', 25000)
    const [before] = await db.select().from(jobServices).where(sql`id = ${sid}::uuid`)
    expect(before.catalogId).toBeNull()                       // genuine typo → no identity yet
    expect((await payloadFor(orderId, ['Ful Detail'])).payload.lines[0]).toMatchObject({ itemId: 'ITEM-LABOR' })

    await renameService(orderId, sid, 'Full Detail', 'Manager')
    const { payload, fallbacks } = await payloadFor(orderId, ['Full Detail'])
    expect(fallbacks).toEqual([])
    expect(payload.lines[0]).toMatchObject({ itemId: 'QBI-FULL', description: 'Complete interior & exterior detail' })
    const [after] = await db.select().from(jobServices).where(sql`id = ${sid}::uuid`)
    expect(after.catalogId).toBe(FD)
  })

  it('a genuinely custom service keeps the Labor fallback across renames', async () => {
    const { orderId, estimateId } = await makeOrder(['Headlight restoration'])
    const sid = await priceByTitle(orderId, estimateId, 'Headlight restoration', 8000)
    await renameService(orderId, sid, 'Headlight restore', 'Manager')
    const { payload, fallbacks } = await payloadFor(orderId, ['Headlight restore'])
    expect(payload.lines[0]).toMatchObject({ itemId: 'ITEM-LABOR', description: 'Headlight restore', amountCents: 8000 })
    expect(fallbacks).toEqual(['Headlight restore→Labor'])
    const [svc] = await db.select().from(jobServices).where(sql`id = ${sid}::uuid`)
    expect(svc.catalogId).toBeNull()
  })

  it('an archived catalog identity falls back to Labor and never substitutes another live item', async () => {
    // A service stamped with a catalog item that was LATER archived — and whose label now equals a
    // DIFFERENT live catalog item ("Full Detail"). It must NOT remap to QBI-FULL.
    const { orderId, estimateId } = await makeOrder([])
    const [svc] = await db.insert(jobServices).values({ jobEstimateId: estimateId, title: 'Full Detail', source: 'manual', catalogId: OLD }).returning()
    await db.insert(jobLineItems).values({ jobServiceId: svc.id, type: 'labor', name: 'Full Detail', qty: '1', unit: 'each', priceCents: 15000, taxable: false, taxCategory: 'detailing' })
    await recomputeEstimate(estimateId)

    const { payload } = await payloadFor(orderId, ['Full Detail'])
    expect(payload.lines[0].itemId).toBe('ITEM-LABOR')        // Labor fallback, NOT QBI-FULL / QBI-OLD
    expect(payload.lines[0].description).toBe('Legacy package')   // own canonical text, not another item's
  })

  it('resolves identity by an approved alias too', async () => {
    const { orderId, estimateId } = await makeOrder([])
    const svc = await addService(estimateId, 'Full Service Detail')
    await setServicePrice(estimateId, svc.id, 20000, 'Manager')
    expect(svc.catalogId).toBe(FD)
    const { payload, fallbacks } = await payloadFor(orderId, ['Full Service Detail'])
    expect(fallbacks).toEqual([])
    expect(payload.lines[0]).toMatchObject({ itemId: 'QBI-FULL', description: 'Complete interior & exterior detail' })
  })

  it('a catalog item with no managed description uses the canonical NAME, stable across renames (finding 3)', async () => {
    const { orderId, estimateId } = await makeOrder(['Interior Shampoo'])
    const sid = await priceByTitle(orderId, estimateId, 'Interior Shampoo', 9000)
    const first = await payloadFor(orderId, ['Interior Shampoo'])
    expect(first.payload.lines[0]).toMatchObject({ itemId: 'QBI-SHAMPOO', description: 'Interior Shampoo' })   // name, not label

    await renameService(orderId, sid, 'Interior Shampoo - seats only', 'Manager')
    const after = await payloadFor(orderId, ['Interior Shampoo - seats only'])
    expect(after.payload.lines[0]).toMatchObject({ itemId: 'QBI-SHAMPOO', description: 'Interior Shampoo' })   // STILL the name
    const [svc] = await db.select().from(jobServices).where(sql`id = ${sid}::uuid`)
    expect(svc.catalogId).toBe(SH)
  })

  it('an exact canonical NAME beats a cross-item alias (no Labor regression)', async () => {
    const { orderId, estimateId } = await makeOrder(['Ceramic Coating'])
    await priceByTitle(orderId, estimateId, 'Ceramic Coating', 50000)
    const [svc] = await db.select().from(jobServices).where(sql`title = 'Ceramic Coating'`)
    expect(svc.catalogId).toBe(CC)   // the NAME's catalog, not the dealer alias's
    const { payload, fallbacks } = await payloadFor(orderId, ['Ceramic Coating'])
    expect(fallbacks).toEqual([])
    expect(payload.lines[0]).toMatchObject({ itemId: 'QBI-CERAMIC', description: 'Ceramic coating package' })
  })

  it('updateService title edits capture identity for an unmatched row and never overwrite an existing one', async () => {
    const { estimateId } = await makeOrder([])
    // Unmatched typo → identity resolves from the corrected title on a generic title edit.
    const typo = await addService(estimateId, 'Ful Detail')
    expect(typo.catalogId).toBeNull()
    await updateService(typo.id, { title: 'Full Detail' })
    expect((await db.select().from(jobServices).where(sql`id = ${typo.id}::uuid`))[0]).toMatchObject({ title: 'Full Detail', catalogId: FD })

    // Already identified → relabeling (even to another catalog name) keeps the original identity.
    const known = await addService(estimateId, 'Full Detail')
    expect(known.catalogId).toBe(FD)
    await updateService(known.id, { title: 'Express Wash' })
    expect((await db.select().from(jobServices).where(sql`id = ${known.id}::uuid`))[0]).toMatchObject({ title: 'Express Wash', catalogId: FD })
  })

  it('a catalog item with QB mapping disabled uses Labor with its canonical description, stable across renames', async () => {
    const { orderId, estimateId } = await makeOrder(['Floor Mats'])
    const sid = await priceByTitle(orderId, estimateId, 'Floor Mats', 3000)
    expect((await db.select().from(jobServices).where(sql`id = ${sid}::uuid`))[0].catalogId).toBe(FM)   // identity still pinned
    const first = await payloadFor(orderId, ['Floor Mats'])
    expect(first.payload.lines[0]).toMatchObject({ itemId: 'ITEM-LABOR', description: 'Floor mats' })   // disabled → Labor, canonical text
    expect(first.fallbacks).toEqual(['Floor Mats→Labor'])

    await renameService(orderId, sid, 'Floor Mats - driver side', 'Manager')
    const after = await payloadFor(orderId, ['Floor Mats - driver side'])
    expect(after.payload.lines[0]).toMatchObject({ itemId: 'ITEM-LABOR', description: 'Floor mats' })   // unchanged by the label
  })
})

// ── Migration 0051: execute the ACTUAL .sql file against a fresh PGlite ──────────────────────────
describe('migration 0051 — actual SQL file (column/FK/index + backfill + idempotency)', () => {
  const migrationSql = readFileSync(new URL('../../drizzle/migrations/manual/0051_job_service_catalog_identity.sql', import.meta.url), 'utf8')
  let pg: PGlite
  let mdb: PgliteDatabase<typeof schema>

  const BS = String.fromCharCode(92)   // a single backslash, assembled so no literal escape is in source

  // Seed a legacy job_services row WITHOUT catalog_id: raw parameterized INSERT naming ONLY the
  // pre-migration columns (the column is dropped to simulate production, so a Drizzle insert — which
  // lists every modeled column — would reference the missing catalog_id).
  const legacy = async (title: string, estimateId: string, source = 'promoted') => {
    const id = randomUUID()
    await pg.query('INSERT INTO job_services (id, job_estimate_id, title, source) VALUES ($1, $2, $3, $4)', [id, estimateId, title, source])
    return id
  }
  const renameEvent = async (orderId: string, serviceId: string, from: string, to: string, at: Date) => {
    await mdb.insert(serviceOrderEvents).values({ serviceOrderId: orderId, eventType: 'service_renamed', employeeName: 'Manager', note: JSON.stringify({ serviceId, from, to }), createdAt: at })
  }
  // A note inserted verbatim (malformed JSON, bad UUID, invalid-unicode escape, etc.).
  const rawEvent = async (orderId: string, note: string, at: Date) => {
    await mdb.insert(serviceOrderEvents).values({ serviceOrderId: orderId, eventType: 'service_renamed', employeeName: 'Manager', note, createdAt: at })
  }
  const catOf = async (id: string) =>
    (await mdb.select({ catalogId: jobServices.catalogId }).from(jobServices).where(sql`id = ${id}::uuid`))[0].catalogId

  beforeAll(async () => {
    pg = new PGlite()
    mdb = drizzle(pg, { schema })
    const { apply } = await pushSchema(schema, mdb as unknown as Parameters<typeof pushSchema>[1])
    await apply()
    // Pre-migration production had no catalog_id; dropping it also drops the Drizzle-modeled index,
    // so the migration re-creates the column, the SQL-only FK, and the index for real.
    await pg.exec('ALTER TABLE job_services DROP COLUMN IF EXISTS catalog_id')
  })

  it('creates column/FK/index, backfills by name/alias/history safely, is idempotent, and never overwrites', async () => {
    // Catalog (quotes in a name to prove JSON unescaping; a name also carried as a cross-item alias;
    // and a DUPLICATE exact name that must stay ambiguous/unfilled).
    const cat = async (slug: string, name: string, aliases: string[] = []) => {
      const [c] = await mdb.insert(serviceCatalog).values({ slug, name, kind: 'package', qbItemRef: `QB-${slug}` }).returning({ id: serviceCatalog.id })
      for (const al of aliases) await mdb.insert(serviceAliases).values({ catalogId: c.id, alias: al })
      return c.id
    }
    const full = await cat('full', 'Full Detail', ['Full Service Detail'])
    const premium = await cat('premium', 'Interior "Premium"')
    const ceramic = await cat('ceramic', 'Ceramic Coating')
    const paintProtect = await cat('paint-protect', 'Paint' + BS + 'Protect')   // backslash in the name
    await cat('dealer-ceramic', 'Dealer Ceramic', ['Ceramic Coating'])   // alias collides with a NAME
    await cat('dup-a', 'Buff And Polish')
    await cat('dup-b', 'Buff And Polish')                                 // duplicate exact name → ambiguous
    await cat('amb-a', 'Amb A', ['Mystery Combo'])                        // alias shared across two catalogs,
    await cat('amb-b', 'Amb B', ['Mystery Combo'])                        // with NO canonical name → ambiguous
    await cat('express', 'Express Wash')

    // Order + estimate (and a SEPARATE order whose event must be ignored for cross-order safety).
    const [veh] = await mdb.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2020' }).returning({ id: vehicles.id })
    const [ord] = await mdb.insert(serviceOrders).values({ orderNumber: 'MIG-1', vehicleId: veh.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived', customerName: 'X' }).returning({ id: serviceOrders.id })
    const [est] = await mdb.insert(jobEstimates).values({ serviceOrderId: ord.id }).returning({ id: jobEstimates.id })
    const [veh2] = await mdb.insert(vehicles).values({ make: 'Ford', model: 'F-250', year: '2021' }).returning({ id: vehicles.id })
    const [ord2] = await mdb.insert(serviceOrders).values({ orderNumber: 'MIG-2', vehicleId: veh2.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived', customerName: 'Y' }).returning({ id: serviceOrders.id })
    await mdb.insert(jobEstimates).values({ serviceOrderId: ord2.id })

    const sName = await legacy('Full Detail', est.id)
    const sAlias = await legacy('Full Service Detail', est.id)
    const sCustom = await legacy('Bespoke Thing', est.id)
    const sQuoteNow = await legacy('Interior "Premium"', est.id)                  // quoted NAME, current label
    const sQuoteHist = await legacy('Totally Different', est.id)                  // quoted name via history JSON
    const sRelabel = await legacy('Express Wash', est.id)                         // current label is ANOTHER catalog name
    const sTypo = await legacy('Full Detail - vehicle', est.id)                   // typo→corrected→renamed
    const sCeramic = await legacy('Ceramic Coating', est.id)                     // name must beat dealer alias
    const sDup = await legacy('Buff And Polish', est.id)                          // duplicate name → stay null
    const sAmbAlias = await legacy('Mystery Combo', est.id)                       // alias with no name → ambiguous
    const sBackslash = await legacy('Relabeled Paint', est.id)                    // recover a backslash NAME via history
    const sBadUuid = await legacy('Mystery', est.id)                             // invalid serviceId in note
    const sUnicode = await legacy('Unicode Mystery', est.id)                     // valid-looking note, invalid jsonb
    const sCrossOrder = await legacy('Nope', est.id)                             // event logged under a DIFFERENT order
    const sSystem = await legacy('Fees & Charges', est.id, 'system')             // system rows never stamped
    // A price line on sName whose amount/qty must survive the migration untouched.
    await mdb.insert(jobLineItems).values({ jobServiceId: sName, type: 'labor', name: 'Full Detail', qty: '2', unit: 'each', priceCents: 12345, taxable: false, taxCategory: 'detailing' })

    const t0 = Date.now()
    await renameEvent(ord.id, sQuoteHist, 'Interior "Premium"', 'Totally Different', new Date(t0 - 5000))
    await renameEvent(ord.id, sRelabel, 'Full Detail', 'Express Wash', new Date(t0 - 5000))
    await renameEvent(ord.id, sBackslash, 'Paint' + BS + 'Protect', 'Relabeled Paint', new Date(t0 - 5000))
    await renameEvent(ord.id, sTypo, 'Ful Detail', 'Full Detail', new Date(t0 - 4000))   // earliest: typo, no match
    await renameEvent(ord.id, sTypo, 'Full Detail', 'Full Detail - vehicle', new Date(t0 - 3000))  // then matches
    // invalid serviceId (not a UUID) → ignored, must not abort.
    await rawEvent(ord.id, JSON.stringify({ serviceId: 'not-a-uuid', from: 'Full Detail', to: 'Mystery' }), new Date(t0 - 2000))
    // malformed JSON note → ignored, must not abort.
    await rawEvent(ord.id, '{ not valid json', new Date(t0 - 2000))
    // a syntactically-valid JSON object that is NOT valid jsonb (carries an invalid unicode escape) → ignored,
    // must not abort. Assembled with a literal backslash so no NUL byte enters the source.
    await rawEvent(ord.id, '{"serviceId":"' + sUnicode + '","from":"Full Detail","to":"Later' + BS + 'u0000"}', new Date(t0 - 2000))
    await renameEvent(ord2.id, sCrossOrder, 'Full Detail', 'Nope', new Date(t0 - 2000))  // CROSS-ORDER → ignore

    // Run the real migration file (idempotent exec; DO-block + multi-statement supported by pg.exec).
    await pg.exec(migrationSql)

    // Column / FK / index actually exist.
    const col = await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name='job_services' AND column_name='catalog_id'`)
    expect(col.rows[0].c).toBe(1)
    const fk = await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM information_schema.table_constraints WHERE constraint_name='job_services_catalog_id_fk'`)
    expect(fk.rows[0].c).toBe(1)
    const idx = await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_indexes WHERE indexname='job_services_catalog_idx'`)
    expect(idx.rows[0].c).toBe(1)

    // Backfill outcomes.
    expect(await catOf(sName)).toBe(full)           // exact name
    expect(await catOf(sAlias)).toBe(full)          // alias
    expect(await catOf(sCustom)).toBeNull()         // genuinely custom
    expect(await catOf(sQuoteNow)).toBe(premium)    // quoted NAME via current label
    expect(await catOf(sQuoteHist)).toBe(premium)   // quoted name recovered via JSON history (unescaped)
    expect(await catOf(sRelabel)).toBe(full)        // earliest history beats a current label that is another catalog name
    expect(await catOf(sTypo)).toBe(full)           // earliest MATCHING step (the corrected one) wins
    expect(await catOf(sCeramic)).toBe(ceramic)     // exact name beats the cross-item alias
    expect(await catOf(sDup)).toBeNull()            // duplicate exact name → ambiguous → unfilled
    expect(await catOf(sAmbAlias)).toBeNull()       // shared alias with no canonical name stays unfilled
    expect(await catOf(sBackslash)).toBe(paintProtect) // JSON unescapes the original backslash
    expect(await catOf(sUnicode)).toBeNull()        // invalid jsonb is ignored without aborting
    expect(await catOf(sBadUuid)).toBeNull()        // bad uuid ignored, no abort
    expect(await catOf(sCrossOrder)).toBeNull()     // cross-order event ignored
    expect(await catOf(sSystem)).toBeNull()         // system rows untouched

    // Original data preserved on the migrated row.
    const [nameRow] = await mdb.select().from(jobServices).where(sql`id = ${sName}::uuid`)
    expect(nameRow.title).toBe('Full Detail')
    const [line] = await mdb.select().from(jobLineItems).where(sql`job_service_id = ${sName}::uuid`)
    expect(line).toMatchObject({ priceCents: 12345, qty: '2.00', name: 'Full Detail' })

    // Pin an identity deliberately, then re-run: the migration must NEVER overwrite it and must be a
    // no-op for everything already resolved (idempotency).
    await pg.exec(`UPDATE job_services SET catalog_id = '${ceramic}' WHERE id = '${sName}'`)
    await pg.exec(migrationSql)
    expect(await catOf(sName)).toBe(ceramic)        // pinned identity preserved
    expect(await catOf(sAlias)).toBe(full)          // unchanged
    expect(await catOf(sCustom)).toBeNull()         // still custom
    expect(await catOf(sDup)).toBeNull()            // still ambiguous
  })
})
