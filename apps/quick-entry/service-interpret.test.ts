/**
 * Interpretation of rushed employee entry — deterministic core + AI merge/validation.
 * Catalog = the production-shaped retail catalog (names/aliases/roles as live on 2026-10-16).
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
  C('odor_ozone', 'Odor / Ozone Treatment', ['Ozone', 'Ozone Treatment', 'Odor Treatment'], 'odor_ozone'),
  C('headlight_restoration', 'Headlight Restoration', ['Headlights']),
  C('engine_bay_clean', 'Engine Bay / Motor Clean', ['Engine bay', 'Clean Motor']),
  C('cabin_air_filter_replacement', 'Cabin Air Filter Replacement'),
  C('air_duct_cleaning', 'Air Duct Cleaning', [], 'odor_duct'),
  C('paint_touch_up', 'Paint Touch-Up'),
  C('clay_bar', 'Clay Bar', ['Clay bar']),
  C('leather_conditioner', 'Leather Conditioner'),
  C('exterior_wax', 'Exterior Wax', ['Exterior Wax', 'Wax']),
  C('complete_odor_treatment', 'Complete Odor Treatment', [], 'odor_complete'),
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
  it('"air ducts + ozone" → Complete Odor Treatment by the approved package definition', () => {
    const r = interpretEntry('air ducts + ozone', CATALOG)
    expect(r.status).toBe('resolved')
    expect(r.candidates).toEqual([{ catalogId: id('complete_odor_treatment'), via: 'rule' }])
  })
  it('"car smells bad" → odor request; asks which treatment (all three options)', () => {
    const r = interpretEntry('car smells bad', CATALOG)
    expect(r.intent).toBe('odor')
    expect(r.status).toBe('choose')
    expect(r.question).toMatch(/which odor treatment/i)
    expect(r.candidates.map((c) => c.catalogId).sort()).toEqual([id('air_duct_cleaning'), id('complete_odor_treatment'), id('odor_ozone')].sort())
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
  it('air duct only / ozone only follow the owner definitions', () => {
    expect(interpretEntry('clean the ducts', CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: id('air_duct_cleaning') }] })
    expect(interpretEntry('Ozone Treatment', CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: id('odor_ozone') }] })
  })
})

describe('ambiguity and no match', () => {
  it('an alternate name shared by two services asks which one', () => {
    const r = interpretEntry('ceramic coating', CATALOG)
    expect(r.status).toBe('choose')
    expect(r.candidates.map((c) => c.catalogId).sort()).toEqual([id('ceramic_coating_1yr'), id('ceramic_coating_3yr')].sort())
  })
  it('generic "Odor Treatment" is NOT auto-resolved to ozone even though QuickBooks uses that name', () => {
    const r = interpretEntry('Odor Treatment', CATALOG)
    expect(r.status).toBe('choose')
    expect(r.intent).toBe('odor')
    expect(isGenericOdorKey('odor treatment')).toBe(true)
    expect(isGenericOdorKey('ozone treatment')).toBe(false)
  })
  it('"odor treatment/air duct cleaning" (Mizell wording) offers the package first, then the separate options', () => {
    const r = interpretEntry('Odor treatment/air duct cleaning', CATALOG)
    expect(r.status).toBe('choose')
    expect(r.candidates[0].catalogId).toBe(id('complete_odor_treatment'))
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
  it('only genuinely ambiguous odor wording needs a treatment choice (duct-only / ozone wording is clear)', () => {
    for (const t of ['Remove Smoke Odor', 'Odor treatment/air duct cleaning', 'car smells bad', 'Odor Treatment']) expect(odorWordingNeedsChoice(t)).toBe(true)
    for (const t of ['Clean air duct system', 'Air duct system cleaning', 'Clean air duct system to remove mold', 'Ozone', 'Ozone odor treatment', 'Interior detail']) expect(odorWordingNeedsChoice(t)).toBe(false)
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
    const det = interpretEntry('air ducts + ozone', CATALOG)
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
