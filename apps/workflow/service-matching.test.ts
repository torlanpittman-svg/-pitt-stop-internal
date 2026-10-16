/**
 * Service matching, odor package, special-order parts + labor review, and the ACTUAL outgoing
 * QuickBooks invoice body — end to end against an in-memory PGlite built from the real Drizzle
 * schema, a production-shaped catalog, and the real migration 0052. QuickBooks is mocked at the
 * HTTP layer only (queryQBO / qbApiRequest), so the real payload builder + invoice writer run.
 * No real QuickBooks, email, or text is ever contacted.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq, and } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({
    shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0,
    paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825,
  }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
const qb = vi.hoisted(() => ({ posts: [] as Array<{ path: string; body: Record<string, unknown> }>, live: [] as unknown[] }))
vi.mock('@/apps/quickbooks/client', () => ({
  qboEscape: (s: string) => s.replace(/'/g, "\\'"),
  queryQBO: async (q: string) => {
    if (/from Item MAXRESULTS/i.test(q)) return { Item: qb.live }
    if (/from Item where Name = 'Labor'/i.test(q)) return { Item: [{ Id: '53', Name: 'Labor' }] }
    if (/from Item where Name = 'Fees'/i.test(q)) return { Item: [{ Id: '1010000012', Name: 'Fees' }] }
    if (/from Account/i.test(q)) return { Account: [{ Id: '1', Name: 'Services' }] }
    if (/from Invoice/i.test(q)) return { Invoice: [] }
    throw new Error(`unexpected QBO query: ${q}`)
  },
  qbApiRequest: async (req: { method?: string; path: string; body: Record<string, unknown> }) => {
    qb.posts.push({ path: req.path, body: req.body })
    if (req.path !== '/invoice') throw new Error(`unexpected QB write: ${req.path}`)
    const lines = req.body.Line as Array<{ Amount: number }>
    return { Invoice: { Id: 'INV-1', DocNumber: '100900', SyncToken: '0', TotalAmt: lines.reduce((s, l) => s + l.Amount, 0), Line: lines.map(() => ({ DetailType: 'SalesItemLineDetail' })) } }
  },
}))
vi.mock('@/apps/quickbooks/retail-customer', async (orig) => ({
  ...(await orig<object>()),
  resolveRetailCustomer: async () => ({ qbCustomerId: 'CUST-1', billEmail: 'test@example.invalid', matchedBy: 'test', created: false, emailConflict: false, emailStatus: 'ok' }),
}))

import { seedProductionCatalog, runMigration0052, LIVE_QB_ITEMS, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import {
  getOrCreateEstimate, promoteTextServices, addService, setServicePrice, getEstimateView, getFullEstimate, renameService, selectServiceMatch,
  setServiceDetail, removeEstimateService, prepareEstimateView,
} from '@/apps/workflow/estimate-db'
import { addEstimatePart, decidePartLabor, addTireWork, removeEstimatePart, updateEstimatePart } from '@/apps/parts/estimate-parts'
import { addPart, billPart } from '@/apps/parts/db'
import { updateCatalogService } from '@/apps/quick-entry/shortcuts'
import { buildRetailWorkPayload, createRetailQBInvoice } from '@/apps/quickbooks/retail-invoice-service'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { getOrderWithContext, transitionOrder } from '@/apps/workflow/db'
import { loadEstimateReview } from '@/apps/workflow/estimate-review'
import { serviceOrders, vehicles, serviceOrderEvents, jobServices, jobLineItems, jobParts, serviceCatalog, serviceShortcuts, serviceCatalogEvents } from '@/drizzle/schema'

const mirror = { description: 'Driver-side mirror assembly', fitment: '2019 Ford F-150', partNumber: 'FL3Z-17683', supplier: 'Ford dealer', quantity: 1, unitCostCents: 18000, sellPriceCents: 26500 }
let db: PgliteDatabase<typeof schema>
let CAT: Record<string, string> = {}
let seq = 0

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})

beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  qb.posts = []
  qb.live = LIVE_QB_ITEMS
  CAT = await seedProductionCatalog(db)
})

async function order(services: string[] = []) {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2019', vin: '1FTEW1E50KFA00001' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `SM-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived', customerName: 'Test Customer', services }).returning()
  const est = await getOrCreateEstimate(o.id, 'Manager')
  await promoteTextServices(est.id, o.id)
  return { orderId: o.id, estimateId: est.id }
}
async function payload(orderId: string) {
  const ctx = (await getOrderWithContext(orderId))!
  const full = await getFullEstimate(orderId)
  const draft = buildInvoiceDraft({ order: ctx, full, paymentLabel: 'Card charge', role: 'admin' })
  return { ...(await buildRetailWorkPayload({ estimateId: full!.estimate.id, order: ctx, full, draft })), draft }
}
const events = async (orderId: string, type: string) =>
  (await db.select().from(serviceOrderEvents).where(and(eq(serviceOrderEvents.serviceOrderId, orderId), eq(serviceOrderEvents.eventType, type)))).map((e) => JSON.parse(e.note ?? '{}'))
const svcLine = async (serviceId: string) => (await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, serviceId)))[0]

describe('migration 0052 (the real file)', () => {
  it('is idempotent and seeds the catalog rows, roles, and the 14 usage-based shortcuts exactly once', async () => {
    // The catalog exactly as 0052 left it (0053's follow-up is covered in apps/quick-entry/service-mapping.test.ts).
    for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
    CAT = await seedProductionCatalog(db, { upTo: 52 })
    await runMigration0052(db)   // second run (seedProductionCatalog already ran it once)
    for (const slug of ['complete_odor_treatment', 'installation_labor', 'seat_shampoo', 'paint_refinish']) expect(CAT[slug]).toBeTruthy()
    const cats = await db.select().from(serviceCatalog)
    expect(cats.filter((c) => c.slug === 'complete_odor_treatment')).toHaveLength(1)
    const complete = cats.find((c) => c.slug === 'complete_odor_treatment')!
    expect(complete).toMatchObject({ qbDescription: 'Complete odor treatment, including air duct cleaning and ozone treatment.', defaultPriceCents: null,
      qbItemRef: null, qbItemStatus: 'mapping_review', qbSyncEnabled: false, serviceRole: 'odor_complete' })
    expect(cats.find((c) => c.slug === 'odor_ozone')).toMatchObject({ serviceRole: 'odor_ozone', roleConfirmedAt: null, qbItemRef: '24' })
    expect(cats.find((c) => c.slug === 'air_duct_cleaning')).toMatchObject({ serviceRole: 'odor_duct', qbCandidateRef: '76' })
    const sc = await db.select().from(serviceShortcuts)
    expect(sc).toHaveLength(14)
    expect(new Set(sc.map((s) => s.catalogId)).size).toBe(14)
    expect((await db.select().from(serviceCatalogEvents)).filter((e) => e.eventType === 'catalog_seeded')).toHaveLength(4)
  })
})

describe('catalog identity + approved description', () => {
  it('a confirmed match keeps its QB item and canonical description (+ detail) through rename and reopen', async () => {
    const { orderId, estimateId } = await order()
    const svc = await addService(estimateId, 'Leather Conditioner', { catalogId: CAT.leather_conditioner, detail: 'driver seat', matchMethod: 'suggestion', entryText: 'condtnr dr seat', actor: 'Manager' })
    await setServicePrice(estimateId, svc.id, 5000, 'Manager')
    await renameService(orderId, svc.id, 'Leather treatment (customer asked)', 'Manager')
    await prepareEstimateView(orderId, 'Manager')   // reopen
    const view = await getEstimateView(orderId)
    expect(view.services[0]).toMatchObject({ title: 'Leather treatment (customer asked)', catalogId: CAT.leather_conditioner, matchState: 'matched', detail: 'driver seat',
      description: 'Apply leather conditioner to seats and applicable leather trim. — driver seat', entryText: 'condtnr dr seat' })
    const { payload: p } = await payload(orderId)
    expect(p.lines).toEqual([{ itemId: '66', description: 'Apply leather conditioner to seats and applicable leather trim. — driver seat', amountCents: 5000 }])
  })

  it('matching never sets a price: a catalog default is NOT applied unless entered', async () => {
    const { orderId, estimateId } = await order()
    await addService(estimateId, 'Mini Detail', { catalogId: CAT.mini_detail, matchMethod: 'exact', actor: 'Manager' })
    const v = await getEstimateView(orderId)
    expect(v.services[0].priceCents).toBeNull()
    expect(v.services[0].suggestedCents).toBe(15000)   // a hint only
  })

  it('a later catalog description edit applies to FUTURE additions only (existing line keeps its text)', async () => {
    const { orderId, estimateId } = await order()
    const a = await addService(estimateId, 'Clay Bar', { catalogId: CAT.clay_bar, actor: 'Manager' })
    await setServicePrice(estimateId, a.id, 20000, 'Manager')
    await updateCatalogService(CAT.clay_bar, { description: 'NEW clay bar wording.' }, 'Owner')
    const { payload: before } = await payload(orderId)
    expect(before.lines[0].description).toBe("Clay bar treatment to remove bonded contaminants from the vehicle's exterior surface.")
    const o2 = await order()
    const b = await addService(o2.estimateId, 'Clay Bar', { catalogId: CAT.clay_bar, actor: 'Manager' })
    await setServicePrice(o2.estimateId, b.id, 20000, 'Manager')
    expect((await payload(o2.orderId)).payload.lines[0].description).toBe('NEW clay bar wording.')
  })

  it('correcting a wrong match repoints the identity without touching price, qty, or tax — audited', async () => {
    const { orderId, estimateId } = await order()
    const svc = await addService(estimateId, 'Wax', { catalogId: CAT.exterior_wax, matchMethod: 'alias', actor: 'Manager' })
    await setServicePrice(estimateId, svc.id, 12500, 'Manager')
    const before = await svcLine(svc.id)
    await selectServiceMatch(orderId, svc.id, { catalogId: CAT.clay_bar, title: 'Clay Bar', matchMethod: 'manual' }, 'Manager')
    const after = await svcLine(svc.id)
    expect({ price: after.priceCents, qty: after.qty, taxable: after.taxable, cat: after.taxCategory }).toEqual({ price: before.priceCents, qty: before.qty, taxable: before.taxable, cat: before.taxCategory })
    const { payload: p } = await payload(orderId)
    expect(p.lines[0]).toMatchObject({ itemId: '67', amountCents: 12500 })
    expect(await events(orderId, 'service_matched')).toEqual([expect.objectContaining({ serviceId: svc.id, from: expect.objectContaining({ catalogId: CAT.exterior_wax }), to: expect.objectContaining({ catalogId: CAT.clay_bar }) })])
  })

  it('refuses a dealer package or unknown id as a retail selection; a confirmed custom line bills as Labor with its wording', async () => {
    const { orderId, estimateId } = await order()
    await expect(addService(estimateId, 'Dealer', { catalogId: CAT.dealer_complete_detail_standard })).rejects.toThrow(/not in the catalog/)
    const c = await addService(estimateId, 'Remove tree sap', { custom: true, detail: 'hood', actor: 'Manager' })
    await setServicePrice(estimateId, c.id, 3500, 'Manager')
    expect((await getEstimateView(orderId)).services[0]).toMatchObject({ matchState: 'custom', description: 'Remove tree sap — hood' })
    expect((await payload(orderId)).payload.lines).toEqual([{ itemId: '53', description: 'Remove tree sap — hood', amountCents: 3500 }])
  })

  it('a shortcut-tapped intake keeps the exact catalog identity (label is display only)', async () => {
    const [v] = await db.insert(vehicles).values({ make: 'Kia', model: 'Soul' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: `SM-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived', services: ['Ozone Treatment', 'Engine Bay'] }).returning()
    const est = await getOrCreateEstimate(o.id, 'Employee')
    await promoteTextServices(est.id, o.id, new Map([['ozone treatment', CAT.ozone_treatment], ['engine bay', CAT.engine_bay_clean]]))
    const rows = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, est.id))
    expect(rows.map((r) => [r.title, r.catalogId, r.matchMethod])).toEqual([['Ozone Treatment', CAT.ozone_treatment, 'shortcut'], ['Engine Bay', CAT.engine_bay_clean, 'shortcut']])
  })
})

describe('odor services — three separate services, no package (owner final definition, 0056)', () => {
  const ODOR_DESC = 'Steam cleaning the entire interior and using smoke odor removal products to get rid of the smells.'
  const ductText = async () => { const [r] = await db.select().from(serviceCatalog).where(eq(serviceCatalog.slug, 'air_duct_cleaning')); return r.qbDescription?.trim() || r.name }

  it('all three coexist on one estimate: separate lines, own prices, own items + approved wording; no warning, no duplicate charge', async () => {
    const { orderId, estimateId } = await order()
    const oz = await addService(estimateId, 'Ozone Treatment', { catalogId: CAT.ozone_treatment, matchMethod: 'exact', actor: 'Manager' })
    const duct = await addService(estimateId, 'Air Duct Cleaning', { catalogId: CAT.air_duct_cleaning, matchMethod: 'exact', actor: 'Manager' })
    const odor = await addService(estimateId, 'Odor Treatment', { catalogId: CAT.odor_treatment, matchMethod: 'exact', actor: 'Manager' })
    await setServicePrice(estimateId, oz.id, 9000, 'Manager')
    await setServicePrice(estimateId, duct.id, 7000, 'Manager')
    await setServicePrice(estimateId, odor.id, 12000, 'Manager')
    const v = await getEstimateView(orderId)
    expect(v.review).toMatchObject({ ready: true, issues: [] })
    expect(v.services.map((x) => [x.title, x.catalogName, x.matchState, x.priceCents])).toEqual([
      ['Ozone Treatment', 'Ozone Treatment', 'matched', 9000], ['Air Duct Cleaning', 'Air Duct Cleaning', 'matched', 7000], ['Odor Treatment', 'Odor Treatment', 'matched', 12000]])
    expect(v.workTotalCents).toBe(28000)
    const { payload: p, draft } = await payload(orderId)
    expect(p.lines).toEqual([
      { itemId: '24', description: 'Ozone treatment.', amountCents: 9000 },
      { itemId: '76', description: await ductText(), amountCents: 7000 },
      { itemId: '68', description: ODOR_DESC, amountCents: 12000 },
    ])
    expect(draft.workPriceCents).toBe(28000)
  })

  it('selecting Odor Treatment adds exactly one line, billed under its own item (#68 "Odor Treatment", never Ozone #24)', async () => {
    const { orderId, estimateId } = await order()
    const odor = await addService(estimateId, 'Odor Treatment', { catalogId: CAT.odor_treatment, matchMethod: 'shortcut', actor: 'Manager' })
    await setServicePrice(estimateId, odor.id, 15000, 'Manager')
    const v = await getEstimateView(orderId)
    expect(v.services).toHaveLength(1)
    expect(v.services[0]).toMatchObject({ suggestedCents: null, description: ODOR_DESC })   // no default price → entered per job
    const { payload: p } = await payload(orderId)
    expect(p.lines).toEqual([{ itemId: '68', description: ODOR_DESC, amountCents: 15000 }])
  })

  it('renaming the line keeps its identity, item, approved wording and price (and survives reopening)', async () => {
    const { orderId, estimateId } = await order()
    const odor = await addService(estimateId, 'Odor Treatment', { catalogId: CAT.odor_treatment, actor: 'Manager' })
    await setServicePrice(estimateId, odor.id, 15000, 'Manager')
    await renameService(orderId, odor.id, 'Smoke smell — full interior', 'Manager')
    await prepareEstimateView(orderId, 'Manager')
    expect((await getEstimateView(orderId)).services[0]).toMatchObject({ title: 'Smoke smell — full interior', catalogId: CAT.odor_treatment, matchState: 'matched', priceCents: 15000 })
    expect((await payload(orderId)).payload.lines).toEqual([{ itemId: '68', description: ODOR_DESC, amountCents: 15000 }])
  })

  it('removing one odor line leaves the others exactly as they were', async () => {
    const { orderId, estimateId } = await order()
    const oz = await addService(estimateId, 'Ozone Treatment', { catalogId: CAT.ozone_treatment, actor: 'Manager' })
    const odor = await addService(estimateId, 'Odor Treatment', { catalogId: CAT.odor_treatment, actor: 'Manager' })
    await setServicePrice(estimateId, oz.id, 9000, 'Manager')
    await setServicePrice(estimateId, odor.id, 12000, 'Manager')
    await removeEstimateService(orderId, oz.id, 'Manager')
    await prepareEstimateView(orderId, 'Manager')
    expect((await payload(orderId)).payload.lines).toEqual([{ itemId: '68', description: ODOR_DESC, amountCents: 12000 }])
  })

  it('generic odor wording from intake is not auto-stamped or reinterpreted; it must be chosen before invoicing', async () => {
    const { orderId, estimateId } = await order(['Odor Treatment'])
    const [row] = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
    expect(row.catalogId).toBeNull()
    await setServicePrice(estimateId, row.id, 30000, 'Manager')
    expect((await getEstimateView(orderId)).services[0]).toMatchObject({ matchState: 'choose', chooseReason: 'odor' })
    expect((await createRetailQBInvoice({ orderId, actor: 'Manager' })).error).toMatch(/Choose which service “Odor Treatment” is/)
    expect(qb.posts).toEqual([])
    // Retired records are not offered…
    await expect(selectServiceMatch(orderId, row.id, { catalogId: CAT.odor_ozone }, 'Manager')).rejects.toThrow(/not in the catalog/)
    await expect(selectServiceMatch(orderId, row.id, { catalogId: CAT.complete_odor_treatment }, 'Manager')).rejects.toThrow(/not in the catalog/)
    // …the manager's choice stamps the identity; price/qty untouched.
    await selectServiceMatch(orderId, row.id, { catalogId: CAT.odor_treatment, title: 'Odor Treatment' }, 'Manager')
    expect((await loadEstimateReview(orderId)).readiness.ready).toBe(true)
    expect((await svcLine(row.id)).priceCents).toBe(30000)
    expect((await payload(orderId)).payload.lines).toEqual([{ itemId: '68', description: ODOR_DESC, amountCents: 30000 }])
  })

  it('combined legacy wording ("Odor treatment/air duct cleaning") is reviewed, never split or reinterpreted automatically', async () => {
    const { orderId, estimateId } = await order(['Odor treatment/air duct cleaning'])
    const rows = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
    expect(rows).toHaveLength(1)
    expect(rows[0].catalogId).toBeNull()
    expect((await getEstimateView(orderId)).review!.issues.map((i) => i.code)).toEqual(['odor_choice'])
  })

  it('a line still on the retired Complete Odor Treatment package keeps its history and must be reviewed before invoicing', async () => {
    const { orderId, estimateId } = await order()
    const [pkg] = await db.insert(jobServices).values({ jobEstimateId: estimateId, title: 'Complete Odor Treatment', source: 'manual', sortOrder: 0, catalogId: CAT.complete_odor_treatment, matchMethod: 'rule' }).returning()
    await setServicePrice(estimateId, pkg.id, 35000, 'Manager')
    const v = await getEstimateView(orderId)
    expect(v.services[0]).toMatchObject({ matchState: 'choose', chooseReason: 'package', catalogName: 'Complete Odor Treatment' })
    expect(v.review!.issues[0]).toMatchObject({ code: 'odor_choice', message: expect.stringMatching(/no longer offered/) })
    expect((await createRetailQBInvoice({ orderId, actor: 'Manager' })).status).toBe('refused')
    // Not repurposed: the record still means the old package (history), it just isn't billed until reviewed.
    expect((await payload(orderId)).payload.lines).toEqual([{ itemId: '68', description: 'Complete odor treatment, including air duct cleaning and ozone treatment.', amountCents: 35000 }])
    await selectServiceMatch(orderId, pkg.id, { catalogId: CAT.odor_treatment, title: 'Odor Treatment' }, 'Manager')
    expect((await loadEstimateReview(orderId)).readiness.ready).toBe(true)
  })

  it('legacy "Ozone" lines (no identity) always bill as Ozone Treatment — never the retired combined record', async () => {
    const { orderId, estimateId } = await order()
    const [row] = await db.insert(jobServices).values({ jobEstimateId: estimateId, title: 'Ozone', source: 'promoted', sortOrder: 0 }).returning()
    await setServicePrice(estimateId, row.id, 8000, 'Manager')
    expect((await getEstimateView(orderId)).review!.ready).toBe(true)
    expect((await payload(orderId)).payload.lines).toEqual([{ itemId: '24', description: 'Ozone treatment.', amountCents: 8000 }])
  })

  it('a legacy name that matches two services ("Ceramic Coating") is reviewed instead of guessing the warranty length', async () => {
    const { orderId, estimateId } = await order()
    const [row] = await db.insert(jobServices).values({ jobEstimateId: estimateId, title: 'Ceramic Coating', source: 'promoted', sortOrder: 0 }).returning()
    await setServicePrice(estimateId, row.id, 80000, 'Manager')
    const v = await getEstimateView(orderId)
    expect(v.services[0]).toMatchObject({ matchState: 'choose', chooseReason: 'name' })
    expect(v.review!.issues.map((i) => i.code)).toEqual(['name_choice'])
    expect((await createRetailQBInvoice({ orderId, actor: 'Manager' })).error).toMatch(/matches more than one service/)
    await selectServiceMatch(orderId, row.id, { catalogId: CAT.ceramic_coating_3yr }, 'Manager')
    expect((await loadEstimateReview(orderId)).readiness.ready).toBe(true)
    expect((await payload(orderId)).payload.lines[0]).toMatchObject({ itemId: '70', description: expect.stringMatching(/3 years/) })
  })
})

describe('special-order parts + installation labor review', () => {

  it('a part bills under the existing general parts item with its real description; cost ≠ price; labor review blocks invoicing', async () => {
    const { orderId } = await order()
    await addEstimatePart(orderId, mirror, 'Manager')
    const v = await getEstimateView(orderId)
    expect(v.services).toEqual([])   // parts are listed separately, not as services
    expect(v.parts![0]).toMatchObject({ supply: 'shop', laborStatus: 'needs_review', unitCostCents: 18000, sellPriceCents: 26500, lineCents: 26500,
      invoiceText: 'Driver-side mirror assembly — Fits: 2019 Ford F-150 — Part #: FL3Z-17683' })
    expect(v.review).toMatchObject({ ready: false, issues: [expect.objectContaining({ code: 'part_labor', message: '1 part needs labor review' })] })
    const { payload: p } = await payload(orderId)
    expect(p.lines).toEqual([{ itemId: '1010000001', description: 'Driver-side mirror assembly — Fits: 2019 Ford F-150 — Part #: FL3Z-17683', amountCents: 26500 }])
    expect((await createRetailQBInvoice({ orderId, actor: 'Manager' })).error).toMatch(/1 part needs labor review/)
  })

  it('painting the mirror does NOT cover installing it; add installation labor explicitly (existing catalog service, entered price)', async () => {
    const { orderId, estimateId } = await order()
    const part = await addEstimatePart(orderId, mirror, 'Manager')
    const paint = await addService(estimateId, 'Painting / Refinishing', { catalogId: CAT.paint_refinish, detail: 'driver-side mirror assembly', actor: 'Manager' })
    await setServicePrice(estimateId, paint.id, 15000, 'Manager')
    expect((await loadEstimateReview(orderId)).readiness.ready).toBe(false)   // paint line present, still unresolved
    await decidePartLabor(orderId, part.id, { action: 'add_labor', cents: 7500 }, 'Manager', 'manager')
    const v = await getEstimateView(orderId)
    const install = v.services.find((s) => s.catalogId === CAT.installation_labor)!
    expect(install).toMatchObject({ title: 'Installation Labor', priceCents: 7500, detail: 'Driver-side mirror assembly', description: 'Installation Labor — Driver-side mirror assembly' })
    expect(v.parts![0]).toMatchObject({ laborStatus: 'labor_added', laborServiceId: install.id })
    expect(v.review!.ready).toBe(true)
    // Example from the brief: part + painting + installation = three distinct invoice lines.
    const { payload: p, draft } = await payload(orderId)
    // Part (general Part item) + painting (existing "Paint" #57) + installation (existing "Install" #73).
    expect(p.lines.map((l) => [l.itemId, l.amountCents])).toEqual([['1010000001', 26500], ['57', 15000], ['73', 7500]])
    expect(p.totalCents).toBe(draft.totalCents)
  })

  it('one labor line can cover several parts (explicit links, no duplicate labor); removing it re-opens both', async () => {
    const { orderId } = await order()
    const left = await addEstimatePart(orderId, mirror, 'Manager')
    const right = await addEstimatePart(orderId, { ...mirror, description: 'Passenger-side mirror assembly', partNumber: 'FL3Z-17682' }, 'Manager')
    await decidePartLabor(orderId, left.id, { action: 'add_labor', cents: 12000, detail: 'both mirror assemblies' }, 'Manager', 'manager')
    const installId = (await getEstimateView(orderId)).parts!.find((p) => p.id === left.id)!.laborServiceId!
    await decidePartLabor(orderId, right.id, { action: 'included', serviceId: installId }, 'Manager', 'manager')
    let v = await getEstimateView(orderId)
    expect(v.services.filter((s) => s.catalogId === CAT.installation_labor)).toHaveLength(1)
    expect(v.parts!.map((p) => p.laborStatus)).toEqual(['labor_added', 'included'])
    await removeEstimateService(orderId, installId, 'Manager')
    v = await getEstimateView(orderId)
    expect(v.parts!.map((p) => p.laborStatus)).toEqual(['needs_review', 'needs_review'])
    expect(v.review!.issues[0].message).toBe('2 parts need labor review')
    expect(await events(orderId, 'part_labor_reopened')).toHaveLength(2)
  })

  it('re-matching the covering line to different work re-opens the review', async () => {
    const { orderId, estimateId } = await order()
    const part = await addEstimatePart(orderId, mirror, 'Manager')
    const other = await addService(estimateId, 'Exterior Wash', { catalogId: CAT.exterior_wash, actor: 'Manager' })
    await decidePartLabor(orderId, part.id, { action: 'included', serviceId: other.id }, 'Manager', 'manager')
    expect((await loadEstimateReview(orderId)).readiness.ready).toBe(true)
    await setServiceDetail(orderId, other.id, 'roof only', 'Manager')          // a detail edit does not reopen
    expect((await loadEstimateReview(orderId)).readiness.ready).toBe(true)
    await selectServiceMatch(orderId, other.id, { catalogId: CAT.clay_bar }, 'Manager')
    expect((await loadEstimateReview(orderId)).parts[0].laborStatus).toBe('needs_review')
  })

  it('a part cannot cover itself; part-only is explicit; waivers are manager-only with a reason (audited)', async () => {
    const { orderId } = await order()
    const part = await addEstimatePart(orderId, mirror, 'Manager')
    const [row] = await db.select().from(jobParts).where(eq(jobParts.id, part.id))
    await expect(decidePartLabor(orderId, part.id, { action: 'included', serviceId: row.jobServiceId! }, 'Manager', 'manager')).rejects.toThrow(/Choose a labor line/)
    await expect(decidePartLabor(orderId, part.id, { action: 'waive', reason: 'goodwill' }, 'Tony', 'employee')).rejects.toThrow(/Only a manager/)
    await expect(decidePartLabor(orderId, part.id, { action: 'waive', reason: ' ' }, 'Manager', 'manager')).rejects.toThrow(/reason/)
    await decidePartLabor(orderId, part.id, { action: 'waive', reason: 'Warranty comeback' }, 'Manager', 'manager')
    expect((await getEstimateView(orderId)).parts![0]).toMatchObject({ laborStatus: 'waived', laborNote: 'Warranty comeback' })
    await decidePartLabor(orderId, part.id, { action: 'part_only' }, 'Manager', 'manager')
    expect((await loadEstimateReview(orderId)).readiness.ready).toBe(true)
    expect((await events(orderId, 'part_labor_review')).map((e) => e.status)).toEqual(['waived', 'part_only'])
  })

  it('customer-supplied part: no parts charge, but labor still reviewed', async () => {
    const { orderId } = await order()
    await addEstimatePart(orderId, { description: 'Customer-supplied tonneau cover', supply: 'customer', sellPriceCents: 99999 }, 'Manager')
    const v = await getEstimateView(orderId)
    expect(v.parts![0]).toMatchObject({ supply: 'customer', sellPriceCents: null, serviceId: null, laborStatus: 'needs_review' })
    expect(v.workTotalCents).toBe(0)
  })

  it('tires: supply + install bills tires and installation separately; extras only when ticked; quantity confirmed', async () => {
    const { orderId } = await order()
    await expect(addTireWork(orderId, { mode: 'both', quantity: 0 }, 'Manager', 'manager')).rejects.toThrow(/how many/i)
    await addTireWork(orderId, { mode: 'both', quantity: 4, size: '275/65R18', tireUnitCents: 18900, installCents: 10000, extras: { mount: true, balance: true } }, 'Manager', 'manager')
    const v = await getEstimateView(orderId)
    expect(v.parts![0]).toMatchObject({ description: 'Tires 275/65R18', quantity: 4, lineCents: 75600, laborStatus: 'labor_added' })
    expect(v.services[0]).toMatchObject({ catalogId: CAT.installation_labor, priceCents: 10000, detail: '4 tires, including mounting, balancing' })
    expect(v.review!.ready).toBe(true)
    const { payload: p } = await payload(orderId)
    expect(p.lines.map((l) => [l.itemId, l.amountCents])).toEqual([['1010000001', 75600], ['73', 10000]])
    expect(JSON.stringify(p.lines)).not.toMatch(/disposal/)
  })

  it('tires: supply-only is part-only; install customer tires has no tire charge', async () => {
    const a = await order()
    await addTireWork(a.orderId, { mode: 'supply', quantity: 2, tireUnitCents: 15000 }, 'Manager', 'manager')
    expect((await getEstimateView(a.orderId)).parts![0].laborStatus).toBe('part_only')
    const b = await order()
    await addTireWork(b.orderId, { mode: 'install_customer', quantity: 4, installCents: 8000 }, 'Manager', 'manager')
    const v = await getEstimateView(b.orderId)
    expect(v.parts![0]).toMatchObject({ supply: 'customer', lineCents: null })
    expect(v.workTotalCents).toBe(8000)
  })

  it('removing a part line is durable across reopen; the procurement record is cancelled (not deleted)', async () => {
    const { orderId } = await order()
    const part = await addEstimatePart(orderId, mirror, 'Manager')
    await removeEstimatePart(orderId, part.id, 'Manager')
    for (let i = 0; i < 2; i++) await prepareEstimateView(orderId, 'Manager')
    const v = await getEstimateView(orderId)
    expect(v.parts).toEqual([])
    expect((await db.select().from(jobParts).where(eq(jobParts.id, part.id)))[0].status).toBe('cancelled')
  })

  it('editing a part changes only the fields sent', async () => {
    const { orderId } = await order()
    const part = await addEstimatePart(orderId, mirror, 'Manager')
    await updateEstimatePart(orderId, part.id, { fitment: '2019 Ford F-150 XLT' }, 'Manager')
    const p = (await getEstimateView(orderId)).parts![0]
    expect(p).toMatchObject({ sellPriceCents: 26500, quantity: 1, unitCostCents: 18000, fitment: '2019 Ford F-150 XLT' })
  })

  it('Job-detail "bill part" puts each part on its own line, so two parts both reach QuickBooks and the totals match', async () => {
    const { orderId } = await order()
    const a = await addPart({ serviceOrderId: orderId, description: 'Wiper blade', quantity: 2, unitCostCents: 900, sellPriceCents: 2500 })
    const b = await addPart({ serviceOrderId: orderId, description: 'Cabin filter', sellPriceCents: 4000 })
    expect((await billPart(a.id, 'Manager')).ok).toBe(true)
    expect((await billPart(b.id, 'Manager')).ok).toBe(true)
    const { payload: p, draft } = await payload(orderId)
    expect(p.lines.map((l) => l.amountCents)).toEqual([5000, 4000])
    expect(p.totalCents).toBe(draft.totalCents)
  })
})

describe('the actual outgoing QuickBooks invoice (create)', () => {
  it('sends the reviewed lines with existing items only — no item created, non-taxable, total == Pitt Stop total', async () => {
    const { orderId, estimateId } = await order()
    const shampoo = await addService(estimateId, 'Seat Shampoo', { catalogId: CAT.seat_shampoo, detail: 'passenger seat', matchMethod: 'suggestion', actor: 'Manager' })
    await setServicePrice(estimateId, shampoo.id, 6000, 'Manager')
    const part = await addEstimatePart(orderId, mirror, 'Manager')
    await decidePartLabor(orderId, part.id, { action: 'add_labor', cents: 7500 }, 'Manager', 'manager')
    const res = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(res).toMatchObject({ ok: true, status: 'created', totalCents: 40000 })
    expect(qb.posts.map((p) => p.path)).toEqual(['/invoice'])
    const body = qb.posts[0].body as { Line: Array<{ Description: string; Amount: number; SalesItemLineDetail: { ItemRef: { value: string }; TaxCodeRef: { value: string } } }> }
    expect(body.Line.map((l) => [l.SalesItemLineDetail.ItemRef.value, l.Description, l.Amount, l.SalesItemLineDetail.TaxCodeRef.value])).toEqual([
      // Existing items (Clean seats #23, Part, Install #73) — never generic Labor — and the line text is the
      // service name + area, NOT the item's historical "Clean rear seats" wording.
      ['23', 'Seat Shampoo — passenger seat', 60, 'NON'],
      ['1010000001', 'Driver-side mirror assembly — Fits: 2019 Ford F-150 — Part #: FL3Z-17683', 265, 'NON'],
      ['73', 'Installation Labor — Driver-side mirror assembly', 75, 'NON'],
    ])
  })
})

describe('job completion is never gated by these reviews', () => {
  it('a Job with an unresolved part still completes, with no QB/AI call', async () => {
    const { orderId } = await order()
    await addEstimatePart(orderId, mirror, 'Manager')
    expect((await loadEstimateReview(orderId)).readiness.ready).toBe(false)
    const r = await transitionOrder({ orderId, newStatus: 'ready', employeeName: 'Tony', completedBy: 'Tony' })
    expect(r.ok).toBe(true)
    expect(qb.posts).toEqual([])
  })
})

describe('historical invoiced jobs are not blocked', () => {
  it('legacy duct wording is clear; legacy generic odor wording blocks a NEW invoice but never a sync of an existing one', async () => {
    const a = await order(['Clean air duct system'])
    expect((await loadEstimateReview(a.orderId)).readiness.ready).toBe(true)
    const b = await order(['Smoke odor removal'])
    const [row] = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, b.estimateId))
    await setServicePrice(b.estimateId, row.id, 20000, 'Manager')
    expect((await loadEstimateReview(b.orderId)).readiness.issues.map((i) => i.code)).toEqual(['odor_choice'])
    // Simulate an invoice created before this release, then a sync: not blocked by the odor wording.
    await db.update(schema.jobEstimates).set({ qbInvoiceId: 'INV-OLD', qbInvoiceNumber: '100800', qbStatus: 'created' }).where(eq(schema.jobEstimates.id, b.estimateId))
    const { syncRetailQBInvoice } = await import('@/apps/quickbooks/retail-invoice-service')
    const r = await syncRetailQBInvoice({ orderId: b.orderId, actor: 'Manager' })
    expect(r.block).not.toBe('estimate_review')
  })
})
