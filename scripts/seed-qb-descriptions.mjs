/**
 * Phase 1b — seed managed canonical retail service descriptions (owner-approved verbatim).
 * Idempotent. Seeds ONLY the approved services; does NOT touch Complete Detail (dealer item)
 * and reverts Floor Mats out of the standard retail mapping. Writes to service_catalog only.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v }
const sql = neon(process.env.DATABASE_URL)

// Owner-approved canonical descriptions, matched to catalog rows by name predicate.
const SEED = [
  { test: n => n === 'Interior Detail', desc: 'Thorough vacuuming and steam cleaning of carpets and upholstery, leather cleaning and conditioning, streak-free window cleaning, conditioning of plastics and vinyl, detailed cleaning of vents, buttons, and consoles, and odor removal.' },
  { test: n => n.includes('Exterior Wash'), desc: 'Exterior hand wash and rinse to remove dirt, debris, and contaminants. Includes cleaning of wheels, tires, and wheel wells, followed by thorough drying for a clean finish.' },
  { test: n => n === 'Mini Detail', desc: 'Hand wash exterior, wheels, tires, wheel well, windows, mirrors. Vacuum and wipe down.' },
  { test: n => n.includes('Paint Correction') || n.includes('Polish'), desc: 'Polish vehicle to reduce surface imperfections and scratches while enhancing gloss and overall appearance.' },
  { test: n => n === 'Clay Bar', desc: "Clay bar treatment to remove bonded contaminants from the vehicle's exterior surface." },
  { test: n => n === 'Leather Conditioner', desc: 'Apply leather conditioner to seats and applicable leather trim.' },
  { test: n => n.includes('Ozone') || n.includes('Odor'), desc: 'Ozone treatment to help neutralize persistent odors such as smoke, pet, and mildew odors, with steam cleaning of applicable fabrics to sanitize and freshen the vehicle.' },
  { test: n => n.includes('Engine Bay') || n.includes('Motor Clean'), desc: 'Professional cleaning of engine-bay components to remove dirt, grease, oil, and debris. Includes application of appropriate cleaning agents, careful rinsing, and drying of accessible surfaces.' },
  { test: n => n.includes('Headliner Replacement'), desc: 'Removal of old headliner material, preparation of the roof surface, installation of new headliner material, and reassembly of applicable trim for proper fit and finish.' },
  { test: n => n.includes('Headliner Cleaning'), desc: 'Steam clean the headliner to help remove stains and improve appearance.' },
  { test: n => n.includes('Headlight Restoration'), desc: 'Sand and polish headlights to improve clarity and restore appearance.' },
  { test: n => n.includes('Ceramic') && n.includes('1-Year'), desc: 'Application of a high-quality ceramic coating to exterior surfaces for enhanced protection and shine. Includes surface preparation, coating application, and curing. Designed to provide approximately 1 year of protection with proper maintenance.' },
  { test: n => n.includes('Ceramic') && n.includes('3-Year'), desc: 'Application of a high-quality ceramic coating to exterior surfaces for enhanced protection and shine. Includes surface preparation, coating application, and curing. Designed to provide approximately 3 years of protection with proper maintenance.' },
  { test: n => n === 'Exterior Wax', desc: 'Apply exterior wax and polish to enhance gloss and add a layer of surface protection.' },
]

const cats = await sql.query("SELECT id, name FROM service_catalog WHERE archived_at IS NULL")
console.log('=== seeding qb_description ===')
let seeded = 0
for (const c of cats) {
  const rule = SEED.find(r => r.test(c.name)); if (!rule) continue
  await sql.query("UPDATE service_catalog SET qb_description=$2 WHERE id=$1", [c.id, rule.desc])
  console.log(`  ✓ ${c.name}`); seeded++
}
// Revert Floor Mats out of the standard retail mapping (owner instruction). No description.
const fm = await sql.query("UPDATE service_catalog SET qb_sync_enabled=false, qb_item_status='mapping_review' WHERE name ILIKE '%Floor Mats%' AND archived_at IS NULL RETURNING name, qb_item_ref, qb_sync_enabled, qb_item_status")
console.log('\n=== Floor Mats reverted (not standard retail mapping) ===')
for (const r of fm) console.log(`  ${r.name}: ref=${r.qb_item_ref} sync=${r.qb_sync_enabled} status=${r.qb_item_status} (→ Labor fallback in retail)`)
console.log('\n=== Complete Detail (untouched — dealer item, no retail description) ===')
const cd = await sql.query("SELECT name, qb_item_ref, qb_sync_enabled, qb_description FROM service_catalog WHERE name='Complete Detail'")
for (const r of cd) console.log(`  ${r.name}: ref=${r.qb_item_ref} sync=${r.qb_sync_enabled} desc=${r.qb_description ?? 'null'}`)
console.log(`\nSeeded ${seeded} descriptions. DONE.`)
