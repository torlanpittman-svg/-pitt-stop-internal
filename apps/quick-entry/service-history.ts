/**
 * Retail service history — the smart-"Other" knowledge base, grounded ONLY in real Pitt Stop work.
 *
 * Matching is deliberately simple + reliable for the current small dataset: normalize text, then score
 * candidates by CHARACTER-TRIGRAM similarity (handles word order + suffix variance without a brittle
 * stemmer) combined with normalized-token overlap. No AI, no pg_trgm, no giant hard-coded catalog. A
 * tiny data-evidenced alias map only fills gaps that trigram+token provably miss (each alias is proven
 * by a test). Prices come from the matched family's actual historical prices (median, outlier-resistant)
 * with EVIDENCE-AWARE sample sizing — one prior price is offered as a weak, clearly-labeled suggestion;
 * zero priced history yields NO price. The pure functions here are unit-tested; the DB read is elsewhere.
 */

// ── Normalization ──
const STOP = new Set(['the', 'and', 'for', 'with', 'a', 'an', 'of', 'to', 'on', 'my', 'our'])
export function normalizeService(name: string): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}
export function tokens(name: string): string[] {
  return normalizeService(name).split(' ').filter((t) => t.length >= 2 && !STOP.has(t))
}

// Small, data-evidenced alias map: normalized token → canonical family token. Only entries proven
// necessary by tests (trigram+token alone can't unify these). NOT a service catalog — just synonyms.
const TOKEN_ALIASES: Record<string, string> = {
  conditioner: 'condition', conditioning: 'condition', conditioned: 'condition',
  headlights: 'headlight', headlamp: 'headlight', headlamps: 'headlight',
  restoration: 'restore', restored: 'restore', restore: 'restore',
  shampooed: 'shampoo', shampooing: 'shampoo',
  odors: 'odor', smells: 'odor', smell: 'odor',
}
/** Canonical token-set signature: alias-map tokens, sorted + de-duped. Order-independent. */
export function familyKey(name: string): string {
  const canon = tokens(name).map((t) => TOKEN_ALIASES[t] ?? t)
  return [...new Set(canon)].sort().join(' ')
}

// ── Character trigram similarity (Dice coefficient) ──
function trigrams(s: string): Set<string> {
  const t = `  ${normalizeService(s).replace(/ /g, '')} `
  const g = new Set<string>()
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3))
  return g
}
export function trigramSim(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}
function tokenOverlap(a: string, b: string): number {
  const A = new Set(tokens(a).map((t) => TOKEN_ALIASES[t] ?? t))
  const B = new Set(tokens(b).map((t) => TOKEN_ALIASES[t] ?? t))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / Math.max(A.size, B.size)
}
/** Blended similarity in [0,1]. Family-key equality is a strong signal; else trigram + token blend. */
export function serviceSimilarity(a: string, b: string): number {
  if (familyKey(a) && familyKey(a) === familyKey(b)) return 1
  return Math.max(0.6 * trigramSim(a, b) + 0.4 * tokenOverlap(a, b), tokenOverlap(a, b) >= 1 ? 0.85 : 0)
}

// ── Robust price (outlier-resistant) ──
export function robustPrice(cents: number[]): number | null {
  const xs = cents.filter((c) => Number.isFinite(c) && c > 0).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2) // median
}

// ── Search ──
export interface HistoryEntry { name: string; priceCents: number | null }  // one historical service occurrence
export interface ServiceMatch {
  display: string              // representative historical name for the family
  familyKey: string
  score: number                // best similarity to the query
  suggestedPriceCents: number | null
  sampleSize: number           // # of PRICED occurrences backing the suggestion
  occurrences: number          // total occurrences (priced + name-only)
  confidence: 'strong' | 'weak' | 'none'   // 'none' = matched by name but no price
  evidenceLabel: string        // e.g. "Usually $75 · based on 8 jobs" / "Previously charged $75 once"
}

const MATCH_THRESHOLD = 0.34   // tuned + covered by tests for the owner's variant sets

function money(c: number): string { return `$${(c / 100).toFixed(2).replace(/\.00$/, '')}` }

function evidenceLabel(price: number | null, sample: number): string {
  if (price == null || sample === 0) return 'No previous price on record'
  if (sample === 1) return `Previously charged ${money(price)} once`
  if (sample === 2) return `Usually around ${money(price)} · based on 2 jobs`
  return `Usually ${money(price)} · based on ${sample} jobs`
}

/**
 * Rank historical service families against the employee's typed query. Groups history by family key,
 * scores each family by its best member similarity, and returns the top matches with a robust price +
 * evidence-aware label. Pure — the caller passes the (cached) retail-only history.
 */
export function searchServiceHistory(query: string, history: HistoryEntry[], limit = 3): ServiceMatch[] {
  const q = normalizeService(query)
  if (q.length < 2) return []

  // Group history into families.
  type Fam = { names: Map<string, number>; prices: number[]; count: number }
  const fams = new Map<string, Fam>()
  for (const h of history) {
    const key = familyKey(h.name)
    if (!key) continue
    const f: Fam = fams.get(key) ?? { names: new Map<string, number>(), prices: [], count: 0 }
    f.names.set(h.name, (f.names.get(h.name) ?? 0) + 1)
    f.count++
    if (h.priceCents != null && h.priceCents > 0) f.prices.push(h.priceCents)
    fams.set(key, f)
  }

  const out: ServiceMatch[] = []
  for (const [key, f] of fams) {
    // Best similarity between the query and any surface name in this family.
    let best = serviceSimilarity(q, key)
    for (const name of f.names.keys()) best = Math.max(best, serviceSimilarity(q, name))
    if (best < MATCH_THRESHOLD) continue
    const display = [...f.names.entries()].sort((a, b) => b[1] - a[1])[0][0]  // most common surface name
    const price = robustPrice(f.prices)
    const sample = f.prices.length
    out.push({
      display, familyKey: key, score: best, suggestedPriceCents: price, sampleSize: sample, occurrences: f.count,
      confidence: price == null ? 'none' : sample >= 3 ? 'strong' : 'weak',
      evidenceLabel: evidenceLabel(price, sample),
    })
  }
  return out.sort((a, b) => b.score - a.score || b.sampleSize - a.sampleSize).slice(0, limit)
}
