/**
 * Test support (not a test file): a production-shaped retail catalog — real slugs, names, aliases,
 * QuickBooks refs, and mapping states copied from the live catalog on 2026-10-16 — with the REAL
 * migration 0052 applied on top, plus the matching live QuickBooks item list. Used by the service
 * matching / parts / shortcut integration tests so they exercise the same data shapes as production.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import type * as schema from '@/drizzle/schema'
import { serviceCatalog, serviceAliases, servicePriceTiers } from '@/drizzle/schema'

type Db = PgliteDatabase<typeof schema>

export const LIVE_QB_ITEMS = [
  { Id: '2', Name: 'Mini Detail', Active: true, Type: 'Service' },
  { Id: '3', Name: 'Complete Detail', Active: true, Type: 'Service' },
  { Id: '4', Name: 'Headlights', Active: true, Type: 'Service' },
  { Id: '6', Name: 'Exterior Wash', Active: true, Type: 'Service' },
  { Id: '8', Name: 'Interior Detail', Active: true, Type: 'Service' },
  { Id: '22', Name: 'Parts', Active: true, Type: 'Service' },
  { Id: '23', Name: 'Clean seats', Active: true, Type: 'Service' },
  { Id: '24', Name: 'Ozone', Active: true, Type: 'Service' },
  { Id: '35', Name: 'Paint touch up', Active: true, Type: 'Service' },
  { Id: '37', Name: 'Engine bay', Active: true, Type: 'Service' },
  { Id: '53', Name: 'Labor', Active: true, Type: 'Service' },
  { Id: '57', Name: 'Paint', Active: true, Type: 'Service' },
  { Id: '58', Name: 'Paint correction', Active: true, Type: 'Service' },
  { Id: '66', Name: 'Leather Conditioner', Active: true, Type: 'Service' },
  { Id: '67', Name: 'Clay bar', Active: true, Type: 'Service' },
  { Id: '68', Name: 'Odor Treatment', Active: true, Type: 'Service' },
  { Id: '69', Name: 'Exterior Wax', Active: true, Type: 'Service' },
  { Id: '70', Name: 'Ceramic Coating', Active: true, Type: 'Service' },
  { Id: '73', Name: 'Install', Active: true, Type: 'Service' },
  { Id: '76', Name: 'Air duct', Active: true, Type: 'Service' },
  { Id: '88', Name: 'Cabin air filter', Active: true, Type: 'Service' },
  { Id: '1010000001', Name: 'Part', Active: true, Type: 'NonInventory' },
  { Id: '1010000002', Name: 'Tire', Active: true, Type: 'NonInventory' },
]

type Row = { slug: string; name: string; kind?: string; price?: number | null; ref?: string | null; status?: string; sync?: boolean; desc?: string | null; source?: string; aliases?: string[]; tiers?: boolean; sort: number }
const BASE: Row[] = [
  { slug: 'complete_detail', name: 'Complete Detail', kind: 'package', ref: '3', aliases: ['Complete Detail', 'C/P Complete Detail', 'Complete Detail/ Sanitize'], tiers: true, sort: 10 },
  { slug: 'interior_detail', name: 'Interior Detail', kind: 'package', ref: '8', desc: 'Thorough vacuuming and steam cleaning of carpets and upholstery, leather cleaning and conditioning, streak-free window cleaning, conditioning of plastics and vinyl, detailed cleaning of vents, buttons, and consoles, and odor removal.', aliases: ['Interior Detail'], tiers: true, sort: 20 },
  { slug: 'mini_detail', name: 'Mini Detail', kind: 'package', price: 15000, ref: '2', desc: 'Hand wash exterior, wheels, tires, wheel well, windows, mirrors. Vacuum and wipe down.', aliases: ['Mini Detail'], sort: 30 },
  { slug: 'paint_correction_1step', name: 'Paint Correction / Polish (1-step)', kind: 'package', price: 65000, ref: '58', desc: 'Polish vehicle to reduce surface imperfections and scratches while enhancing gloss and overall appearance.', aliases: ['Paint correction', 'Compound/Polish', 'Compound/Sealant', 'Clay/Seal', 'Polish'], sort: 40 },
  { slug: 'ceramic_coating_1yr', name: 'Ceramic Coating — 1-Year', kind: 'package', price: 80000, ref: '70', desc: 'Ceramic coating, approximately 1 year of protection.', aliases: ['Ceramic Coating'], sort: 50 },
  { slug: 'ceramic_coating_3yr', name: 'Ceramic Coating — 3-Year', kind: 'package', price: 200000, ref: '70', desc: 'Ceramic coating, approximately 3 years of protection.', aliases: ['Ceramic Coating'], sort: 60 },
  { slug: 'headliner_cleaning', name: 'Headliner Cleaning', kind: 'package', price: 25000, ref: '28', desc: 'Steam clean the headliner to help remove stains and improve appearance.', aliases: ['Clean Headliner'], sort: 70 },
  { slug: 'exterior_wash', name: 'Exterior Wash', kind: 'package', price: 10000, ref: '6', desc: 'Exterior hand wash and rinse to remove dirt, debris, and contaminants.', aliases: ['Exterior Wash'], source: 'owner', sort: 90 },
  { slug: 'dealer_complete_detail_standard', name: 'Dealer Complete Detail — Standard', kind: 'package', price: 20000, ref: '3', source: 'dealer_rules', aliases: ['Complete Detail'], sort: 100 },
  { slug: 'odor_ozone', name: 'Odor / Ozone Treatment', price: 30000, ref: '24', desc: 'Ozone treatment to help neutralize persistent odors such as smoke, pet, and mildew odors, with steam cleaning of applicable fabrics to sanitize and freshen the vehicle.', aliases: ['Ozone', 'Ozone Treatment', 'Odor Treatment'], sort: 130 },
  { slug: 'headlight_restoration', name: 'Headlight Restoration', price: 15000, ref: '4', desc: 'Sand and polish headlights to improve clarity and restore appearance.', aliases: ['Headlights'], sort: 140 },
  { slug: 'engine_bay_clean', name: 'Engine Bay / Motor Clean', price: 7500, ref: '37', desc: 'Professional cleaning of engine-bay components.', aliases: ['Engine bay', 'Clean Motor'], sort: 150 },
  { slug: 'cabin_air_filter_replacement', name: 'Cabin Air Filter Replacement', status: 'mapping_review', sync: false, source: 'owner', sort: 160 },
  { slug: 'air_duct_cleaning', name: 'Air Duct Cleaning', status: 'mapping_review', sync: false, source: 'owner', sort: 170 },
  { slug: 'paint_touch_up', name: 'Paint Touch-Up', status: 'mapping_review', sync: false, source: 'owner', sort: 180 },
  { slug: 'clay_bar', name: 'Clay Bar', price: 20000, ref: '67', desc: "Clay bar treatment to remove bonded contaminants from the vehicle's exterior surface.", aliases: ['Clay bar'], sort: 190 },
  { slug: 'leather_conditioner', name: 'Leather Conditioner', price: 5000, ref: '66', desc: 'Apply leather conditioner to seats and applicable leather trim.', aliases: ['Leather Conditioner'], sort: 200 },
  { slug: 'exterior_wax', name: 'Exterior Wax', ref: '69', desc: 'Apply exterior wax and polish to enhance gloss and add a layer of surface protection.', aliases: ['Exterior Wax', 'Wax'], sort: 220 },
]

export const MIGRATION_0052 = readFileSync(path.join(process.cwd(), 'drizzle/migrations/manual/0052_service_matching_parts_labor.sql'), 'utf8')

export const MIGRATION_0053 = readFileSync(path.join(process.cwd(), 'drizzle/migrations/manual/0053_catalog_mappings_ozone_only.sql'), 'utf8')

export const MIGRATION_0056 = readFileSync(path.join(process.cwd(), 'drizzle/migrations/manual/0056_odor_three_separate_services.sql'), 'utf8')

export const MIGRATION_0057 = readFileSync(path.join(process.cwd(), 'drizzle/migrations/manual/0057_odor_ozone_descriptions.sql'), 'utf8')

const execSql = (db: Db, text: string) => (db as unknown as { $client: { exec: (sql: string) => Promise<unknown> } }).$client.exec(text)

/** Run the real migration file (idempotent) against the PGlite database. */
export async function runMigration0052(db: Db): Promise<void> {
  await execSql(db, MIGRATION_0052)
}
/** Run the real 0053 catalog follow-up (idempotent, precondition-guarded). */
export async function runMigration0053(db: Db): Promise<void> {
  await execSql(db, MIGRATION_0053)
}
/** Run the real 0056 odor follow-up: three separate services, package retired (idempotent). */
export async function runMigration0056(db: Db): Promise<void> {
  await execSql(db, MIGRATION_0056)
}
/** Run the real 0057 description update (owner-approved Odor/Ozone wording; idempotent, guarded). */
export async function runMigration0057(db: Db): Promise<void> {
  await execSql(db, MIGRATION_0057)
}

/** Insert the production-shaped base catalog, then apply migrations 0052, 0053, 0056 and 0057 (stopping at
 *  `upTo`) — i.e. the catalog exactly as production has it. Returns slug → id. */
export async function seedProductionCatalog(db: Db, opts: { upTo?: 52 | 53 | 56 | 57 } = {}): Promise<Record<string, string>> {
  for (const r of BASE) {
    const [c] = await db.insert(serviceCatalog).values({
      slug: r.slug, name: r.name, kind: r.kind ?? 'addon', quickEntry: true, hasSize: !!r.tiers, defaultPriceCents: r.tiers ? null : r.price ?? null,
      sortOrder: r.sort, source: r.source ?? 'seed_v1', qbItemRef: r.ref ?? null, qbItemStatus: r.status ?? 'existing', qbSyncEnabled: r.sync ?? true, qbDescription: r.desc ?? null,
    }).returning()
    for (const a of r.aliases ?? []) await db.insert(serviceAliases).values({ catalogId: c.id, alias: a })
    if (r.tiers) await db.insert(servicePriceTiers).values({ catalogId: c.id, size: 'Car', startPriceCents: 25000 })
  }
  await runMigration0052(db)
  if ((opts.upTo ?? 57) >= 53) await runMigration0053(db)
  if ((opts.upTo ?? 57) >= 56) await runMigration0056(db)
  if ((opts.upTo ?? 57) >= 57) await runMigration0057(db)
  const all = await db.select({ id: serviceCatalog.id, slug: serviceCatalog.slug }).from(serviceCatalog)
  return Object.fromEntries(all.map((c) => [c.slug, c.id]))
}

export const CLEAR_TABLES = ['service_shortcuts', 'service_catalog_events', 'job_parts', 'job_line_items', 'job_services', 'job_estimates', 'estimate_intakes', 'quick_entry_jobs',
  'service_order_events', 'service_orders', 'vehicles', 'service_aliases', 'service_price_tiers', 'service_catalog']
