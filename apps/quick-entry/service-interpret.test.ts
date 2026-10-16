/**
 * Interpretation of rushed employee entry — deterministic core + AI merge/validation.
 * Catalog = the ELIGIBLE production retail catalog after 0056 (the owner's final odor definition: three
 * separate services — Ozone Treatment, Air Duct Cleaning, Odor Treatment; no package). Retired rows
 * ("Odor / Ozone Treatment", "Complete Odor Treatment") are never offered for matching.
 */
import { describe, it, expect, vi } from 'vitest'
import { odorWordingNeedsChoice, interpretEntry, correctTokens, tokenize, extractArea, isGrounded, isGenericOdorKey, editDistance, type InterpretCatalogItem } from './service-interpret'
import { parseAiResponse, mergeAiInterpretation, aiInterpret, type AiCatalogEntry } from './service-interpret-ai'

const C = (slug: string, name: string, aliases: string[] = [], role: InterpretCatalogItem['role'] = null): InterpretCatalogItem => ({ id: `id-${slug}`, slug, name, aliases, role })
const CATALOG: InterpretCatalogItem[] = [
  C('complete_detail', 'Complete Detail', ['Complete Detail', 'C/P Complete Detail']),
  C('interior_detail', 'Interior Detail', ['Interior Detail']),
  C('mini_detail', 'Mini Detail'),
  C('paint_correction_1step', 'Paint Correction / Polish (1-step)', ['Paint correction', 'Compound/Polish', 'Polish']),
  C('ceramic_coating_1yr', 'Ceramic Coating — 1-Year', ['Ceramic Coating']),
  C('ceramic_coating_3yr', 'Ceramic Coating — 3-Year', ['Ceramic Coating']),
  C('headliner_cleaning', 'Headliner Cleaning', ['Clean Headliner']),
  C('exterior_wash', 'Exterior Wash'),
  C('ozone_treatment', 'Ozone Treatment', ['Ozone'], 'odor_ozone'),
  C('odor_treatment', 'Odor Treatment', [], 'odor_treatment'),
  C('headlight_restoration', 'Headlight Restoration', ['Headlights']),
  C('engine_bay_clean', 'Engine Bay / Motor Clean', ['Engine bay', 'Clean Motor']),
  C('cabin_air_filter_replacement', 'Cabin Air Filter Replacement'),
  C('air_duct_cleaning', 'Air Duct Cleaning', [], 'odor_duct'),
  C('paint_touch_up', 'Paint Touch-Up'),
  C('clay_bar', 'Clay Bar', ['Clay bar']),
  C('leather_conditioner', 'Leather Conditioner'),
  C('exterior_wax', 'Exterior Wax', ['Exterior Wax', 'Wax']),
  C('installation_labor', 'Installation Labor', [], 'installation'),
  C('seat_shampoo', 'Seat Shampoo'),
  C('paint_refinish', 'Painting / Refinishing'),
]
const id = (slug: string) => `id-${slug}`
const first = (entry: string) => interpretEntry(entry, CATALOG).candidates[0]?.catalogId

describe('owner examples (rushed shorthand)', () => {
  it('"shamp pass seat" → seat shampoo, area kept as "passenger seat"', () => {
    const r = interpretEntry('shamp pass seat', CATALOG)
    expect(r.corrected).toBe('shampoo passenger seat')
    expect(r.candidates[0].catalogId).toBe(id('seat_shampoo'))
    expect(r.area).toBe('passenger seat')
    expect(r.status).toBe('choose')         // a suggestion, not an established match → one-tap confirm
    expect(r.intent).toBe('service')
  })
  it('"paint dr mirr assy" → painting/refinishing with "driver-side mirror assembly" as the component (not a part)', () => {
    const r = interpretEntry('paint dr mirr assy', CATALOG)
    expect(r.candidates.map((c) => c.catalogId)).toContain(id('paint_refinish'))
    expect(r.area).toBe('driver-side mirror assembly')
    expect(r.intent).toBe('service')
    expect(r.part).toBeNull()
  })
  it('"dr side mirror assy" → a likely physical part (labor review follows)', () => {
    const r = interpretEntry('dr side mirror assy', CATALOG)
    expect(r.intent).toBe('part')
    expect(r.part?.description).toBe('Driver-side mirror assembly')
    expect(r.candidates[0]?.catalogId).toBe(id('installation_labor'))   // offered, never auto-added
  })
  it('"air ducts + ozone" names two separate services → asks which this line is (never one combined line)', () => {
    const r = interpretEntry('air ducts + ozone', CATALOG)
    expect(r.status).toBe('choose')
    expect(r.question).toMatch(/more than one service.*its own line/i)
    expect(r.candidates.map((c) => c.catalogId)).toEqual([id('ozone_treatment'), id('air_duct_cleaning')])
  })
  it('"car smells bad" → odor request; asks which service, Odor Treatment first (three separate options)', () => {
    const r = interpretEntry('car smells bad', CATALOG)
    expect(r.intent).toBe('odor')
    expect(r.status).toBe('choose')
    expect(r.question).toMatch(/which odor service/i)
    expect(r.candidates.map((c) => c.catalogId)).toEqual([id('odor_treatment'), id('ozone_treatment'), id('air_duct_cleaning')])
  })
})

describe('established matches resolve in one step', () => {
  it('exact catalog name (case/spacing-insensitive)', () => {
    const r = interpretEntry('  interior   DETAIL ', CATALOG)
    expect(r).toMatchObject({ status: 'resolved', source: 'exact' })
    expect(r.candidates[0].catalogId).toBe(id('interior_detail'))
  })
  it('approved alternate name', () => {
    expect(interpretEntry('Wax', CATALOG)).toMatchObject({ status: 'resolved', source: 'alias' })
    expect(first('Polish')).toBe(id('paint_correction_1step'))
    expect(first('clean motor')).toBe(id('engine_bay_clean'))
  })
  it('typo-heavy entries are corrected first, then resolved exactly', () => {
    expect(interpretEntry('interor detial', CATALOG)).toMatchObject({ status: 'resolved', corrected: 'interior detail' })
    expect(interpretEntry('int det', CATALOG)).toMatchObject({ status: 'resolved', corrected: 'interior detail' })
    expect(interpretEntry('exteror wsh', CATALOG).candidates[0]?.catalogId).toBe(id('exterior_wash'))
    expect(interpretEntry('hedlight restoraton', CATALOG)).toMatchObject({ status: 'resolved' })
  })
  it('the three odor services each resolve directly by name', () => {
    expect(interpretEntry('Ozone Treatment', CATALOG)).toMatchObject({ status: 'resolved', source: 'exact', candidates: [{ catalogId: id('ozone_treatment') }] })
    expect(interpretEntry('air duct cleaning', CATALOG)).toMatchObject({ status: 'resolved', source: 'exact', candidates: [{ catalogId: id('air_duct_cleaning') }] })
    expect(interpretEntry('odor treatment', CATALOG)).toMatchObject({ status: 'resolved', source: 'exact', candidates: [{ catalogId: id('odor_treatment') }] })
  })
  it('rushed/typo odor entries resolve to the right single service', () => {
    expect(interpretEntry('odr tx', CATALOG)).toMatchObject({ status: 'resolved', corrected: 'odor treatment', candidates: [{ catalogId: id('odor_treatment') }] })
    expect(interpretEntry('odor treatmnt', CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: id('odor_treatment') }] })
    expect(interpretEntry('ozone tretment', CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: id('ozone_treatment') }] })
    expect(interpretEntry('oz', CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: id('ozone_treatment') }] })
    expect(interpretEntry('Ozone', CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: id('ozone_treatment') }] })
    expect(interpretEntry('clean the ducts', CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: id('air_duct_cleaning') }] })
    expect(interpretEntry('air duct cleanng', CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: id('air_duct_cleaning') }] })
  })
  it('selecting one odor service never brings another along (always exactly one candidate when resolved)', () => {
    for (const e of ['odor treatment', 'Ozone Treatment', 'air duct cleaning', 'oz', 'clean the ducts']) expect(interpretEntry(e, CATALOG).candidates).toHaveLength(1)
  })
})

describe('ambiguity and no match', () => {
  it('an alternate name shared by two services asks which one', () => {
    const r = interpretEntry('ceramic coating', CATALOG)
    expect(r.status).toBe('choose')
    expect(r.candidates.map((c) => c.catalogId).sort()).toEqual([id('ceramic_coating_1yr'), id('ceramic_coating_3yr')].sort())
  })
  it('old aliases of the retired combined record never decide odor wording', () => {
    // "Odor Treatment" used to be an alias of the retired "Odor / Ozone Treatment"; with that row in the
    // list (as if it were eligible) the exact Odor Treatment name still wins and the alias is ignored.
    const withRetired = [...CATALOG, C('odor_ozone', 'Odor / Ozone Treatment', ['Ozone Treatment', 'Odor Treatment'], 'odor_ozone')]
    expect(interpretEntry('Odor Treatment', withRetired).candidates).toEqual([{ catalogId: id('odor_treatment'), via: 'exact' }])
    expect(isGenericOdorKey('odor treatment')).toBe(true)
    expect(isGenericOdorKey('ozone treatment')).toBe(false)
  })
  it('"odor treatment/air duct cleaning" (Mizell wording) names two services → asks, offering exactly those two', () => {
    const r = interpretEntry('Odor treatment/air duct cleaning', CATALOG)
    expect(r.status).toBe('choose')
    expect(r.candidates.map((c) => c.catalogId)).toEqual([id('odor_treatment'), id('air_duct_cleaning')])
  })
  it('all three named together → asks, offering all three (each becomes its own line)', () => {
    const r = interpretEntry('odor tx w/ ozone and duct cleaning', CATALOG)
    expect(r.status).toBe('choose')
    expect(r.candidates.map((c) => c.catalogId).sort()).toEqual([id('odor_treatment'), id('ozone_treatment'), id('air_duct_cleaning')].sort())
  })
  it('tires → clarify supply vs install and quantity', () => {
    const r = interpretEntry('replace tires', CATALOG)
    expect(r.intent).toBe('tires')
    expect(r.question).toMatch(/supplying.*installing customer-supplied.*both.*how many/i)
  })
  it('no plausible service → none (custom-service review flow)', () => {
    const r = interpretEntry('xyzzy frobnicate', CATALOG)
    expect(r.status).toBe('none')
    expect(r.candidates).toEqual([])
  })
  it('saved legacy lines (no identity) needing review: generic odor wording or more than one service named', () => {
    for (const t of ['Remove Smoke Odor', 'Odor treatment/air duct cleaning', 'car smells bad', 'Odor Treatment', 'Ozone odor treatment', 'Odor / Ozone', 'air ducts + ozone']) expect(odorWordingNeedsChoice(t)).toBe(true)
    for (const t of ['Clean air duct system', 'Air duct system cleaning', 'Clean air duct system to remove mold', 'Ozone', 'Ozone treatment', 'Interior detail']) expect(odorWordingNeedsChoice(t)).toBe(false)
  })
  it('the original entry is preserved verbatim', () => {
    expect(interpretEntry('shamp pass seat!!', CATALOG).entry).toBe('shamp pass seat!!')
  })
})

describe('sloppy real-world wording (found in the live AI check)', () => {
  it('ordinary words are not "corrected" into shop words', () => {
    expect(interpretEntry('detail inside real good', CATALOG).corrected).toBe('detail inside real good')
    expect(interpretEntry('wipe down leathr seets n condtion', CATALOG).corrected).toBe('wipe down leather seats n condition')
  })
  it('a work verb on a component is a service, not a part', () => {
    const r = interpretEntry('respray rear bumper', CATALOG)
    expect(r.intent).toBe('service')
    expect(r.candidates[0].catalogId).toBe(id('paint_refinish'))
    expect(r.area).toBe('rear bumper')
  })
  it('plural typos stem correctly ("scrches" → scratches → polish)', () => {
    expect(interpretEntry('buff out scrches on hood', CATALOG).candidates[0]?.catalogId).toBe(id('paint_correction_1step'))
  })
  it('common shorthand: "foggy hedlites", "clean undr hood"', () => {
    expect(interpretEntry('foggy hedlites', CATALOG).candidates[0]?.catalogId).toBe(id('headlight_restoration'))
    expect(interpretEntry('clean undr hood', CATALOG)).toMatchObject({ corrected: 'clean under hood', candidates: [{ catalogId: id('engine_bay_clean') }] })
  })
})

describe('language helpers', () => {
  it('editDistance handles transpositions', () => { expect(editDistance('detial', 'detail')).toBe(1) })
  it('does not snap a short or numeric token', () => { expect(correctTokens(['4', 'pcs'], [])).toEqual(['4', 'pcs']) })
  it('area phrasing', () => {
    expect(extractArea(tokenize('shampoo driver seat'))).toBe('driver seat')
    expect(extractArea(tokenize('paint passenger mirror cover'))).toBe('passenger-side mirror cover')
    expect(extractArea(tokenize('interior detail'))).toBeNull()
  })
  it('grounding rejects invented words', () => {
    const toks = tokenize('shampoo passenger seat')
    expect(isGrounded('passenger seat', toks)).toBe(true)
    expect(isGrounded('passenger-side seat', toks)).toBe(true)          // connector allowed
    expect(isGrounded('passenger seat and carpets', toks)).toBe(false)  // "carpets" invented
  })
})

describe('AI pass — validated, grounded, fails soft', () => {
  const LIST: AiCatalogEntry[] = CATALOG.map((item) => ({ item, description: null }))
  const idx = (slug: string) => CATALOG.findIndex((c) => c.slug === slug) + 1

  it('accepts only real list numbers; ignores prices/extra keys; drops ungrounded area', () => {
    const out = parseAiResponse(JSON.stringify({ intent: 'service', choices: [idx('seat_shampoo'), 999, 'abc', idx('interior_detail')], area: 'rear seats and trunk', price: 9999, description: 'Deluxe shampoo with free wax' }), LIST, tokenize('shampoo the back seat'))
    expect(out).toMatchObject({ status: 'used', catalogIds: [id('seat_shampoo'), id('interior_detail')], area: null })
    expect(JSON.stringify(out)).not.toMatch(/9999|Deluxe/)
  })
  it('invalid JSON → failed (caller keeps the entry + manual selection)', () => {
    expect(parseAiResponse('not json', LIST, [])).toMatchObject({ status: 'failed' })
  })
  it('merge: AI candidates first, still a confirmation (never auto-resolved), area from grounded AI', () => {
    const det = interpretEntry('get stains out of pass seat', CATALOG)
    const merged = mergeAiInterpretation(det, { status: 'used', catalogIds: [id('seat_shampoo')], intent: 'service', area: 'passenger seat', partDescription: null, question: null }, new Set(CATALOG.map((c) => c.id)))
    expect(merged.status).toBe('choose')
    expect(merged.candidates[0]).toEqual({ catalogId: id('seat_shampoo'), via: 'ai' })
    expect(merged.area).toBe('passenger seat')
  })
  it('merge never overrides an established match or the odor rules', () => {
    const det = interpretEntry('car smells bad', CATALOG)
    const merged = mergeAiInterpretation(det, { status: 'used', catalogIds: [id('interior_detail')], intent: 'service', area: null, partDescription: null, question: null }, new Set(CATALOG.map((c) => c.id)))
    expect(merged).toBe(det)
  })
  it('merge ignores AI ids that are not eligible catalog items', () => {
    const det = interpretEntry('xyzzy', CATALOG)
    const merged = mergeAiInterpretation(det, { status: 'used', catalogIds: ['id-made-up'], intent: 'service', area: null, partDescription: null, question: null }, new Set(CATALOG.map((c) => c.id)))
    expect(merged.status).toBe('none')
  })
  it('aiInterpret: no key → unavailable; client error/timeout → failed; never throws', async () => {
    const prev = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    expect(await aiInterpret('x', 'x', LIST)).toMatchObject({ status: 'unavailable' })
    const broken = { chat: { completions: { create: vi.fn().mockRejectedValue(new Error('Request timed out.')) } } }
    expect(await aiInterpret('x', 'x', LIST, broken as never)).toMatchObject({ status: 'failed', reason: 'Request timed out.' })
    if (prev) process.env.OPENAI_API_KEY = prev
  })
  it('aiInterpret sends only the entry + catalog names (no prices) and parses a good reply', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ intent: 'service', choices: [idx('seat_shampoo')], area: 'passenger seat' }) } }] })
    const out = await aiInterpret('shamp pass seat', 'shampoo passenger seat', LIST, { chat: { completions: { create } } } as never)
    expect(out).toMatchObject({ status: 'used', catalogIds: [id('seat_shampoo')], area: 'passenger seat' })
    const sent = JSON.stringify(create.mock.calls[0][0])
    expect(sent).toContain('Seat Shampoo')
    expect(sent).not.toMatch(/\$\d/)
  })
})
