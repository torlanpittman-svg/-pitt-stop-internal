/**
 * Service-entry INTERPRETATION — deterministic core (pure, no I/O).
 *
 * Employees type fast and sloppy ("shamp pass seat", "paint dr mirr assy", "air ducts + ozone",
 * "car smells bad"). This module turns the raw entry into a PROPOSAL the user confirms:
 *   1. corrects language (shorthand + near-miss typos) without changing meaning,
 *   2. resolves established, unambiguous matches (exact catalog name, approved alternate name,
 *      the owner's odor-package definition) for a one-tap add,
 *   3. otherwise offers a small set of REAL catalog candidates (keyword evidence; the AI pass in
 *      service-interpret-ai.ts adds semantic candidates), or asks one short question,
 *   4. separates the work (catalog identity) from the job-specific AREA/component ("passenger seat",
 *      "driver-side mirror assembly") and flags entries that describe a physical PART.
 *
 * It never decides price, quantity, tax, or included work — those stay with the catalog/pricing
 * engine and the user. Every candidate is an id from the eligible catalog passed in.
 */
import { normalizeServiceKey } from './catalog-identity'

export type ServiceRole = 'odor_duct' | 'odor_ozone' | 'odor_complete' | 'installation'

export interface InterpretCatalogItem {
  id: string
  slug: string
  name: string
  /** Approved alternate names (service_aliases). */
  aliases: string[]
  role: ServiceRole | null
}

export type CandidateVia = 'exact' | 'alias' | 'rule' | 'keyword' | 'ai'
export interface Candidate { catalogId: string; via: CandidateVia }

export type InterpretIntent = 'service' | 'part' | 'part_and_service' | 'odor' | 'tires' | 'unknown'

export interface Interpretation {
  /** The original entry, verbatim (traceability). */
  entry: string
  /** The corrected wording (shorthand expanded, near-miss typos fixed). */
  corrected: string
  status: 'resolved' | 'choose' | 'none'
  intent: InterpretIntent
  /** Most likely first. 'resolved' → exactly one. Never more than MAX_CANDIDATES. */
  candidates: Candidate[]
  /** Job-specific location/component taken from the entry ("passenger seat"), or null. */
  area: string | null
  /** When the entry describes a physical part: its description from the entry's own words. */
  part: { description: string } | null
  /** One short question when the scope is genuinely unclear. */
  question: string | null
  source: CandidateVia | 'none'
}

export const MAX_CANDIDATES = 4

// ── Language correction ───────────────────────────────────────────────────────────────────────
/** Shop shorthand → word. Only unambiguous expansions; anything doubtful is left for the AI. */
export const SHORTHAND: Record<string, string> = {
  shamp: 'shampoo', shampo: 'shampoo', shmp: 'shampoo', shampooo: 'shampoo',
  pass: 'passenger', pas: 'passenger', psgr: 'passenger', psngr: 'passenger', passngr: 'passenger', pssngr: 'passenger',
  dr: 'driver', drv: 'driver', drvr: 'driver', driv: 'driver', drivers: 'driver',
  mirr: 'mirror', mir: 'mirror', mirrs: 'mirrors', mirors: 'mirrors', miror: 'mirror',
  assy: 'assembly', asy: 'assembly', assmbly: 'assembly', assem: 'assembly', asmbly: 'assembly',
  int: 'interior', intr: 'interior', inter: 'interior',
  ext: 'exterior', extr: 'exterior',
  det: 'detail', dtl: 'detail', detl: 'detail',
  hl: 'headlight', hdlt: 'headlight', hdlght: 'headlight', hdlts: 'headlights', hls: 'headlights',
  eng: 'engine', vac: 'vacuum', cab: 'cabin', filt: 'filter', fltr: 'filter',
  frt: 'front', fr: 'front', rr: 'rear', lt: 'left', lh: 'left', rt: 'right', rh: 'right',
  pnt: 'paint', wx: 'wax', pol: 'polish', polsh: 'polish', cer: 'ceramic', odr: 'odor', odour: 'odor',
  oz: 'ozone', ozn: 'ozone', ozon: 'ozone', ducts: 'duct', smel: 'smell', smll: 'smell',
  wndw: 'window', bmpr: 'bumper', hdlnr: 'headliner', leath: 'leather', lthr: 'leather',
  cond: 'conditioner', condtnr: 'conditioner', uphol: 'upholstery', uph: 'upholstery', upholst: 'upholstery',
  carp: 'carpet', refin: 'refinish', repl: 'replace', rplc: 'replace', inst: 'install', instl: 'install',
  sani: 'sanitize', wsh: 'wash', w: 'with', undr: 'under', hedlite: 'headlight', hedlites: 'headlights', hdlites: 'headlights', lites: 'lights', tx: 'treatment', trtmt: 'treatment', treat: 'treatment',
}

/** Words the corrector may snap a near-miss typo onto (plus every catalog name/alias token). */
const DOMAIN_WORDS = [
  'shampoo', 'passenger', 'driver', 'mirror', 'mirrors', 'assembly', 'interior', 'exterior', 'detail', 'headlight',
  'headlights', 'engine', 'vacuum', 'cabin', 'filter', 'front', 'rear', 'left', 'right', 'paint', 'wax', 'polish',
  'ceramic', 'odor', 'ozone', 'duct', 'smell', 'smells', 'window', 'bumper', 'headliner', 'leather', 'conditioner',
  'upholstery', 'carpet', 'refinish', 'replace', 'install', 'sanitize', 'treatment', 'seat', 'seats', 'cleaning',
  'clean', 'wash', 'restoration', 'restore', 'touch', 'scratch', 'scratches', 'tire', 'tires', 'stain', 'stains',
  'steam', 'smoke', 'mildew', 'fender', 'door', 'hood', 'trunk', 'console', 'dashboard', 'compound', 'clay',
]

/** Ordinary words that must never be "corrected" into a shop word ("real good" ≠ "rear hood"). */
const COMMON_WORDS = new Set(['real', 'good', 'bad', 'wipe', 'down', 'out', 'get', 'back', 'inside', 'outside', 'like', 'make', 'more', 'need', 'just', 'very', 'also',
  'take', 'work', 'done', 'some', 'help', 'look', 'nice', 'gone', 'over', 'under', 'thru', 'through', 'whole', 'entire', 'again', 'other', 'there', 'their', 'stuff',
  'thing', 'things', 'little', 'lot', 'lots', 'full', 'half', 'quick', 'light', 'lights', 'heavy', 'dirty', 'clean', 'new', 'old', 'remove', 'rest', 'side', 'sides'])

const STOP = new Set(['a', 'an', 'the', 'and', 'with', 'of', 'on', 'for', 'to', 'in', 'my', 'car', 'vehicle', 'please', 'needs', 'need', 'do', 'it', 'is', 'bad', 'really', 'very', 'some'])

/** Optimal-string-alignment distance (Damerau-Levenshtein with adjacent transposition). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/** Lowercase, split symbols that mean "and", strip other punctuation, collapse spaces. */
export function tokenize(raw: string): string[] {
  return (raw ?? '').toLowerCase()
    .replace(/w\//g, ' with ')
    .replace(/[+&/]/g, ' and ')
    .replace(/'s\b/g, '')
    .replace(/[^a-z0-9\- ]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/).filter(Boolean)
}

const stem = (t: string) => {
  if (t.length > 4 && /(ch|sh|x|ss)es$/.test(t)) return t.slice(0, -2)   // scratches → scratch
  return t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t
}

/** Expand shorthand, then snap near-miss typos to a known word (unique best match only). */
export function correctTokens(tokens: string[], vocabulary: Iterable<string>): string[] {
  const vocab = new Set<string>([...DOMAIN_WORDS, ...AREA_WORDS, ...PART_NOUNS, ...ODOR_WORDS, ...SERVICE_VERBS, ...PART_SIGNALS, ...vocabulary])
  const vocabList = [...vocab].filter((w) => w.length >= 4)
  return tokens.map((t) => {
    if (SHORTHAND[t]) return SHORTHAND[t]
    // Only clearly misspelled longer words are snapped; short and ordinary words are left alone.
    if (vocab.has(t) || t.length < 5 || COMMON_WORDS.has(t) || /\d/.test(t)) return t
    const max = t.length >= 7 ? 2 : 1
    let best: string | null = null, bestD = Infinity, tie = false
    for (const w of vocabList) {
      if (Math.abs(w.length - t.length) > max) continue
      const dist = editDistance(t, w)
      if (dist < bestD) { best = w; bestD = dist; tie = false } else if (dist === bestD && w !== best) tie = true
    }
    return best && bestD <= max && !tie ? best : t
  }).flatMap((t) => t.split(' '))
}

/** Catalog vocabulary (name + alias tokens) used for typo snapping. */
export function catalogVocabulary(items: InterpretCatalogItem[]): string[] {
  const out = new Set<string>()
  for (const i of items) for (const s of [i.name, ...i.aliases]) for (const t of tokenize(s)) if (t.length >= 4) out.add(t)
  return [...out]
}

// ── Domain signals ────────────────────────────────────────────────────────────────────────────
const ODOR_WORDS = new Set(['odor', 'smell', 'stink', 'stinky', 'stinks', 'deodorize', 'musty', 'mildew', 'smelly'])
const SERVICE_VERBS = new Set(['paint', 'painted', 'painting', 'refinish', 'repaint', 'respray', 'spray', 'sand', 'fix', 'wipe', 'shine',
  // condition words describe work ON the component (restore it), not a replacement part
  'foggy', 'cloudy', 'hazy', 'yellow', 'yellowed', 'oxidized', 'faded', 'dull', 'dirty', 'stained', 'clean', 'cleaning', 'shampoo', 'polish', 'wax', 'repair', 'restore', 'restoration',
  'detail', 'wash', 'steam', 'sanitize', 'dye', 'buff', 'compound', 'touch', 'condition', 'conditioner', 'vacuum', 'install', 'installation', 'remove', 'removal'])
const PART_NOUNS = new Set(['mirror', 'assembly', 'bumper', 'grille', 'grill', 'emblem', 'windshield', 'glass', 'wiper', 'blade', 'cushion',
  'sensor', 'fender', 'handle', 'molding', 'moulding', 'taillight', 'lamp', 'battery', 'tire', 'wheel', 'mat', 'cover', 'headlight', 'visor', 'latch'])
const PART_SIGNALS = new Set(['assembly', 'replace', 'replacement', 'new', 'oem', 'part', 'aftermarket'])
/** Location/component words that form the job-specific AREA (never the service itself). */
const AREA_WORDS = new Set(['driver', 'passenger', 'front', 'rear', 'back', 'left', 'right', 'side', 'seat', 'seats', 'mirror', 'mirrors', 'assembly',
  'door', 'doors', 'hood', 'bumper', 'fender', 'headliner', 'trunk', 'cargo', 'row', 'second', 'third', 'console', 'dash', 'dashboard', 'panel',
  'quarter', 'roof', 'wheel', 'wheels', 'cover', 'covers', 'handle', 'window', 'windows', 'carpet', 'carpets', 'mat', 'mats', 'cushion', 'bottom', 'top', 'cap', 'caps'])
/** Connector words an AREA may add without being in the entry ("driver-side"). */
const AREA_CONNECTORS = new Set(['side', 'the', 'of', 'and', 'a'])
const SIDE_COMPONENTS = new Set(['mirror', 'mirrors', 'door', 'doors', 'fender', 'headlight', 'window', 'quarter', 'panel', 'handle', 'bumper'])

/** Build the area phrase: the longest run of location/component words, with "driver-side" phrasing. */
export function extractArea(tokens: string[]): string | null {
  let best: string[] = [], cur: string[] = []
  for (const t of [...tokens, '§']) {
    if (AREA_WORDS.has(t)) cur.push(t)
    else { if (cur.length > best.length) best = cur; cur = [] }
  }
  // An area needs a location or component beyond a lone "side"/"assembly".
  if (best.length === 0 || best.every((t) => t === 'side' || t === 'assembly')) return null
  const out: string[] = []
  for (let i = 0; i < best.length; i++) {
    const t = best[i], next = best[i + 1]
    if ((t === 'driver' || t === 'passenger') && next === 'side') { out.push(`${t}-side`); i++; continue }
    if ((t === 'driver' || t === 'passenger') && next && SIDE_COMPONENTS.has(next)) { out.push(`${t}-side`); continue }
    out.push(t)
  }
  return out.join(' ')
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * Is an AI-proposed phrase grounded in the employee's own (corrected) words? Every token must appear
 * in the corrected entry (stem-insensitive) or be a harmless connector. Blocks invented parts/areas.
 */
export function isGrounded(phrase: string | null | undefined, correctedTokens: string[]): boolean {
  if (!phrase || !phrase.trim()) return false
  const have = new Set(correctedTokens.map(stem))
  return tokenize(phrase).every((t) => have.has(stem(t)) || AREA_CONNECTORS.has(t))
}

// ── Keyword candidates (evidence-based, used when no established match exists) ───────────────
/** Extra matching words per catalog slug (what employees call the work). Names/aliases always count. */
export const SLUG_HINTS: Record<string, string[]> = {
  seat_shampoo: ['shampoo', 'seat', 'upholstery', 'fabric', 'stain', 'cloth', 'steam'],
  paint_refinish: ['paint', 'refinish', 'repaint', 'respray', 'painting', 'spray'],
  paint_touch_up: ['touch', 'chip', 'chips', 'touchup'],
  installation_labor: ['install', 'installation', 'mount', 'reinstall'],
  leather_conditioner: ['leather', 'condition', 'conditioner'],
  interior_detail: ['interior', 'inside', 'vacuum'],
  exterior_wash: ['wash', 'rinse', 'exterior'],
  exterior_wax: ['wax'],
  paint_correction_1step: ['polish', 'compound', 'correction', 'swirl', 'scratch', 'oxidation', 'buff'],
  headlight_restoration: ['headlight', 'headlights', 'foggy', 'cloudy', 'lens'],
  engine_bay_clean: ['engine', 'motor', 'bay', 'under'],
  cabin_air_filter_replacement: ['cabin', 'filter'],
  headliner_cleaning: ['headliner'],
  clay_bar: ['clay'],
  air_duct_cleaning: ['duct', 'vent', 'vents'],
  odor_ozone: ['ozone'],
}

const GENERIC_ITEM_WORDS = new Set(['detail', 'treatment', 'cleaning', 'clean', 'service', 'replacement', 'labor', 'year', '1', '3', 'step'])

export function keywordCandidates(tokens: string[], items: InterpretCatalogItem[]): string[] {
  const have = new Set(tokens.filter((t) => !STOP.has(t)).map(stem))
  const scored: Array<{ id: string; score: number }> = []
  for (const item of items) {
    const words = new Set<string>()
    for (const s of [item.name, ...item.aliases]) for (const t of tokenize(s)) if (!GENERIC_ITEM_WORDS.has(t) && !STOP.has(t)) words.add(stem(t))
    for (const h of SLUG_HINTS[item.slug] ?? []) words.add(stem(h))
    let score = 0
    for (const w of words) if (have.has(w)) score++
    if (score > 0) scored.push({ id: item.id, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.id)
}

// ── Interpretation ────────────────────────────────────────────────────────────────────────────
function byRole(items: InterpretCatalogItem[], role: ServiceRole): InterpretCatalogItem | undefined {
  return items.find((i) => i.role === role)
}

/** Generic odor wording ("odor treatment", "remove smell") that must NOT be auto-resolved to one option. */
export function isGenericOdorKey(text: string): boolean {
  const toks = tokenize(text).map((t) => SHORTHAND[t] ?? t)
  return toks.some((t) => ODOR_WORDS.has(stem(t)) || ODOR_WORDS.has(t)) && !toks.some((t) => t === 'ozone' || stem(t) === 'duct')
}

/**
 * Odor wording that genuinely needs a treatment choice: smell/odor words without "ozone" — e.g.
 * "Remove smoke odor", "Odor treatment/air duct cleaning" (duct only? or the Complete package?).
 * Duct-only or ozone-only wording is clear and is NOT flagged.
 */
export function odorWordingNeedsChoice(text: string): boolean {
  const toks = tokenize(text).map((t) => SHORTHAND[t] ?? t).map(stem)
  return toks.some((t) => ODOR_WORDS.has(t)) && !toks.includes('ozone')
}

/** Odor-family wording of ANY kind (generic, ozone, ducts) — used to flag unresolved legacy titles. */
export function isOdorFamily(text: string): boolean {
  const toks = tokenize(text).map((t) => SHORTHAND[t] ?? t).map(stem)
  return toks.some((t) => ODOR_WORDS.has(t) || t === 'ozone' || t === 'duct')
}

const isTireEntry = (toks: string[]) => toks.some((t) => stem(t) === 'tire') && !toks.some((t) => ['rotation', 'rotate', 'sensor', 'spare', 'storage', 'pressure'].includes(stem(t)))

export function interpretEntry(entry: string, items: InterpretCatalogItem[]): Interpretation {
  const raw = (entry ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const rawTokens = tokenize(raw)
  const tokens = correctTokens(rawTokens, catalogVocabulary(items))
  const corrected = tokens.join(' ')
  const stems = tokens.map(stem)
  const base = { entry: raw, corrected, area: extractArea(tokens), part: null as Interpretation['part'], question: null as string | null }
  const done = (o: Omit<Interpretation, 'entry' | 'corrected' | 'area' | 'part' | 'question'> & Partial<Interpretation>): Interpretation =>
    ({ ...base, ...o, candidates: o.candidates.slice(0, MAX_CANDIDATES) })
  if (!raw) return done({ status: 'none', intent: 'unknown', candidates: [], source: 'none' })

  // 1) Established matches — exact catalog name, then approved alternate name (raw or corrected).
  const keys = [...new Set([normalizeServiceKey(raw), normalizeServiceKey(corrected)])]
  const genericOdor = isGenericOdorKey(raw)
  for (const key of keys) {
    const named = items.filter((i) => normalizeServiceKey(i.name) === key)
    if (named.length === 1) return done({ status: 'resolved', intent: 'service', candidates: [{ catalogId: named[0].id, via: 'exact' }], source: 'exact', area: null })
    if (genericOdor) break   // "Odor Treatment" is an approved QB name for ozone, but the owner wants a choice
    const aliased = [...new Set(items.filter((i) => i.aliases.some((a) => normalizeServiceKey(a) === key)).map((i) => i.id))]
    if (aliased.length === 1) return done({ status: 'resolved', intent: 'service', candidates: [{ catalogId: aliased[0], via: 'alias' }], source: 'alias', area: null })
    if (aliased.length > 1) return done({ status: 'choose', intent: 'service', candidates: aliased.map((id) => ({ catalogId: id, via: 'alias' as const })), source: 'alias', question: 'This name is used for more than one service. Which one?' })
  }

  // 2) Odor rules — the owner's definitions (duct only / ozone only / both = Complete package).
  const duct = byRole(items, 'odor_duct'), ozone = byRole(items, 'odor_ozone'), complete = byRole(items, 'odor_complete')
  const hasDuct = stems.includes('duct'), hasOzone = stems.includes('ozone'), hasOdor = stems.some((t) => ODOR_WORDS.has(t))
  if (hasDuct || hasOzone || hasOdor) {
    const c = (i: InterpretCatalogItem | undefined, via: CandidateVia) => (i ? [{ catalogId: i.id, via }] : [])
    if (hasDuct && hasOzone && complete) return done({ status: 'resolved', intent: 'odor', candidates: [...c(complete, 'rule'), ...c(duct, 'rule'), ...c(ozone, 'rule')].slice(0, 1), source: 'rule', area: null })
    if (hasDuct && !hasOzone && !hasOdor && duct) return done({ status: 'resolved', intent: 'odor', candidates: c(duct, 'rule'), source: 'rule', area: null })
    if (hasOzone && !hasDuct && !hasOdor && ozone) return done({ status: 'resolved', intent: 'odor', candidates: c(ozone, 'rule'), source: 'rule', area: null })
    const order = hasDuct ? [complete, duct, ozone] : hasOzone ? [ozone, complete, duct] : [complete, ozone, duct]
    const candidates = order.flatMap((i) => c(i, 'rule'))
    if (candidates.length) return done({ status: 'choose', intent: 'odor', candidates, source: 'rule', area: null, question: 'Which odor treatment is this?' })
  }

  // 3) Tires — clarify supply vs. install and quantity (handled by the tire flow).
  if (isTireEntry(tokens)) {
    const install = byRole(items, 'installation')
    return done({ status: 'choose', intent: 'tires', candidates: install ? [{ catalogId: install.id, via: 'rule' }] : [], source: 'rule', area: null,
      question: 'Are we supplying the tires, installing customer-supplied tires, or both? How many?' })
  }

  // 4) Part vs service: a part noun with no work verb is a physical part (labor review follows).
  const hasVerb = tokens.some((t) => SERVICE_VERBS.has(t) && t !== 'install' && t !== 'installation')
  const hasPartNoun = stems.some((t) => PART_NOUNS.has(t))
  const hasPartSignal = tokens.some((t) => PART_SIGNALS.has(t))
  const areaText = base.area
  let intent: InterpretIntent = 'service'
  let part: Interpretation['part'] = null
  if (hasPartNoun && !hasVerb) {
    intent = 'part'
    const words = tokens.filter((t) => !STOP.has(t) && !['replace', 'replacement', 'new', 'part', 'install', 'installation'].includes(t))
    const desc = extractArea(words) ?? words.join(' ')
    part = desc ? { description: capitalize(desc) } : null
  } else if (hasPartNoun && hasVerb && tokens.includes('replace')) {
    intent = 'part_and_service'
    part = areaText ? { description: capitalize(areaText) } : null
  }
  void hasPartSignal

  const ids = keywordCandidates(tokens, items)
  const candidates = ids.map((id) => ({ catalogId: id, via: 'keyword' as const }))
  if (intent === 'part') {
    // A part needs no catalog service; offer installation as a related choice, never automatically.
    const install = byRole(items, 'installation')
    return done({ status: 'choose', intent, part, candidates: install ? [{ catalogId: install.id, via: 'rule' }] : [], source: 'rule',
      question: 'This looks like a part. Add it as a part (then review installation labor)?' })
  }
  if (candidates.length === 0) return done({ status: 'none', intent: intent === 'service' ? 'unknown' : intent, part, candidates: [], source: 'none' })
  return done({ status: 'choose', intent, part, candidates, source: 'keyword' })
}
