/**
 * Quick Entry natural-language interpreter — DETERMINISTIC core (pure, no I/O).
 *
 * Handles the parts that must never be guessed: the explicit work price (digits,
 * $650, or spelled "six hundred fifty") and exact catalog/alias service matches.
 * Anything it can't match confidently is returned as `unmatched` for a constrained
 * AI pass (semantic match + note classification) in interpret-ai.ts. The AI can never
 * invent a price — price is owned entirely here.
 */

export interface CatalogService { catalogId: string; title: string; terms: string[] } // terms = normalized name + aliases
export interface RecognizedService { title: string; catalogId: string | null; source: 'catalog' | 'alias' | 'semantic' | 'custom' }

export function norm(s: string): string {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

/** Strict spelled-number parser: returns a number ONLY if every token is a number word
 *  (e.g. "six hundred fifty" → 650). Any other word → null, so service names that happen
 *  to contain "one"/"two" (e.g. "one step polish") are never mistaken for a price. */
export function wordsToNumber(text: string): number | null {
  const tokens = norm(text).split(' ').filter(Boolean)
  if (tokens.length === 0) return null
  let current = 0, result = 0, found = false
  for (const tok of tokens) {
    if (tok === 'and') continue
    if (tok in SMALL) { current += SMALL[tok]; found = true }
    else if (tok === 'hundred') { current = (current || 1) * 100; found = true }
    else if (tok === 'thousand') { result += (current || 1) * 1000; current = 0; found = true }
    else if (tok === 'million') { result += (current || 1) * 1_000_000; current = 0; found = true }
    else return null
  }
  return found ? result + current : null
}

/** A phrase that IS a price → cents; else null. Accepts "$650", "650", "650.00",
 *  "$1,250", or a pure spelled number. Range-limited to sane shop prices. */
export function priceFromToken(phrase: string): number | null {
  const t = (phrase ?? '').trim()
  const m = t.match(/^\$?\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/)
  let cents: number | null = null
  if (m) {
    const dollars = parseInt(m[1].replace(/,/g, ''), 10)
    const frac = m[2] ? parseInt(m[2].padEnd(2, '0').slice(0, 2), 10) : 0
    cents = dollars * 100 + frac
  } else {
    const w = wordsToNumber(t)
    if (w != null && w > 0) cents = w * 100
  }
  if (cents == null) return null
  return cents >= 100 && cents <= 100_000_00 ? cents : null   // $1 – $100,000
}

function matchService(phrase: string, services: CatalogService[]): RecognizedService | null {
  const p = norm(phrase)
  if (!p) return null
  for (const s of services) {
    if (s.terms.includes(p)) return { title: s.title, catalogId: s.catalogId, source: p === norm(s.title) ? 'catalog' : 'alias' }
  }
  return null
}

export interface DeterministicResult {
  priceCents: number | null
  recognized: RecognizedService[]
  unmatched: string[]
}

/** Split on commas / newlines / semicolons / " and ", extract the price token, and
 *  exact/alias-match the rest. Leftovers go to the AI pass. */
export function deterministicInterpret(text: string, services: CatalogService[]): DeterministicResult {
  const phrases = (text ?? '').split(/[,\n;]|\s+and\s+/i).map((s) => s.trim()).filter(Boolean)
  let priceCents: number | null = null
  const recognized: RecognizedService[] = []
  const unmatched: string[] = []
  const seen = new Set<string>()   // dedup recognized by normalized title

  for (const phrase of phrases) {
    const price = priceFromToken(phrase)
    if (price != null) { priceCents = price; continue }   // last stated price wins
    const m = matchService(phrase, services)
    if (m) { const k = norm(m.title); if (!seen.has(k)) { seen.add(k); recognized.push(m) } }
    else unmatched.push(phrase.slice(0, 120))
  }

  // Fallback: a $-number anywhere (e.g. mid-sentence) if no delimited price was found.
  if (priceCents == null) {
    const d = (text ?? '').match(/\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/)
    if (d) priceCents = priceFromToken(d[0].replace(/\s/g, ''))
  }

  return { priceCents, recognized, unmatched }
}
