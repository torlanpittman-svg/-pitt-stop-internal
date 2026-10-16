/**
 * LIVE check of the service-entry AI path (OpenAI) against the production-shaped catalog.
 * Read-only: no database, no QuickBooks. Sends only the entry text and catalog names/descriptions.
 * Run: OPENAI_API_KEY=… node_modules/.bin/tsx scripts/eval-service-ai.ts
 */
import { interpretEntry, type InterpretCatalogItem } from '@/apps/quick-entry/service-interpret'
import { aiInterpret, mergeAiInterpretation } from '@/apps/quick-entry/service-interpret-ai'

const C = (slug: string, name: string, description: string | null, aliases: string[] = [], role: InterpretCatalogItem['role'] = null) => ({ item: { id: slug, slug, name, aliases, role }, description })
const CAT = [
  C('complete_detail', 'Complete Detail', null, ['Complete Detail']),
  C('interior_detail', 'Interior Detail', 'Thorough vacuuming and steam cleaning of carpets and upholstery, leather cleaning and conditioning, window cleaning, plastics, vents, odor removal.', ['Interior Detail']),
  C('mini_detail', 'Mini Detail', 'Hand wash exterior, wheels, tires, windows. Vacuum and wipe down.'),
  C('paint_correction_1step', 'Paint Correction / Polish (1-step)', 'Polish vehicle to reduce surface imperfections and scratches.', ['Paint correction', 'Polish']),
  C('headliner_cleaning', 'Headliner Cleaning', 'Steam clean the headliner to help remove stains.', ['Clean Headliner']),
  C('exterior_wash', 'Exterior Wash', 'Exterior hand wash and rinse.'),
  C('odor_ozone', 'Odor / Ozone Treatment', 'Ozone treatment to help neutralize persistent odors, with steam cleaning of applicable fabrics.', ['Ozone', 'Ozone Treatment', 'Odor Treatment'], 'odor_ozone'),
  C('headlight_restoration', 'Headlight Restoration', 'Sand and polish headlights to improve clarity.', ['Headlights']),
  C('engine_bay_clean', 'Engine Bay / Motor Clean', 'Professional cleaning of engine-bay components.', ['Engine bay', 'Clean Motor']),
  C('cabin_air_filter_replacement', 'Cabin Air Filter Replacement', null),
  C('air_duct_cleaning', 'Air Duct Cleaning', null, [], 'odor_duct'),
  C('paint_touch_up', 'Paint Touch-Up', null),
  C('clay_bar', 'Clay Bar', 'Clay bar treatment to remove bonded contaminants.'),
  C('leather_conditioner', 'Leather Conditioner', 'Apply leather conditioner to seats and applicable leather trim.'),
  C('exterior_wax', 'Exterior Wax', 'Apply exterior wax and polish.', ['Exterior Wax', 'Wax']),
  C('complete_odor_treatment', 'Complete Odor Treatment', 'Complete odor treatment, including air duct cleaning and ozone treatment.', [], 'odor_complete'),
  C('installation_labor', 'Installation Labor', null, [], 'installation'),
  C('seat_shampoo', 'Seat Shampoo', null),
  C('paint_refinish', 'Painting / Refinishing', null),
]
const ENTRIES = ['shamp pass seat', 'paint dr mirr assy', 'dr side mirror assy', 'air ducts + ozone', 'car smells bad', 'get the coffee stain out of the back seat',
  'buff out scrches on hood', 'wipe down leathr seets n condtion', 'clean undr hood', 'respray rear bumper', 'foggy hedlites', 'new cabin filtr', 'detail inside real good']

;(async () => {
  const items = CAT.map((c) => c.item)
  for (const e of ENTRIES) {
    const det = interpretEntry(e, items)
    let final = det, ai = 'skipped'
    if (det.status !== 'resolved' && det.intent !== 'odor' && det.intent !== 'tires') {
      const t0 = Date.now()
      const out = await aiInterpret(det.entry, det.corrected, CAT)
      ai = `${out.status} ${Date.now() - t0}ms${out.status !== 'used' ? ` (${out.reason})` : ` ai=[${out.catalogIds.join(',')}] intent=${out.intent} area=${out.area ?? '-'} part=${out.partDescription ?? '-'}`}`
      final = mergeAiInterpretation(det, out, new Set(items.map((i) => i.id)))
    }
    console.log(`\n"${e}" → read as "${det.corrected}"\n  final: ${final.status}/${final.intent} [${final.candidates.map((c) => `${c.catalogId}(${c.via})`).join(', ')}] area=${final.area ?? '-'} part=${final.part?.description ?? '-'}${final.question ? ` Q="${final.question}"` : ''}\n  ai: ${ai}`)
  }
})()
