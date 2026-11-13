/**
 * "Counted once" — PURE. Every record that describes a purchase (a receipt, a bank/card purchase, a written
 * check, a QuickBooks entry, a sales-inventory cost line) is a node. A confirmed match is an edge. Each
 * connected group is ONE purchase and is counted once, however many sources show it.
 *
 * This is a reconciliation view, not the books: it only merges what a person has confirmed (plus exact
 * identities such as a check and the QuickBooks entry that check itself created). Records that are really the
 * same purchase but have NOT been matched yet still appear as separate purchases — that is why the result
 * always reports how much of it is single-source.
 */
export type PurchaseSource = 'receipt' | 'bank_txn' | 'check' | 'qb_purchase' | 'vehicle_event'
export interface PurchaseNode { key: string; source: PurchaseSource; id: string; amountCents: number; date: string | null; label: string }
export interface PurchaseEdge { a: string; b: string }
export const nodeKey = (source: PurchaseSource, id: string) => `${source}:${id}`

// Which record's amount represents the purchase when several agree it is one purchase: what actually left the
// bank, then the books, then our own paper.
const PRECEDENCE: PurchaseSource[] = ['bank_txn', 'qb_purchase', 'check', 'receipt', 'vehicle_event']

export interface PurchaseGroup {
  members: PurchaseNode[]
  sources: PurchaseSource[]
  amountCents: number              // counted ONCE (the highest-precedence member's amount)
  date: string | null
  label: string
  amountsDisagree: boolean         // members differ by more than $0.50 / 1% — a discrepancy to look at
}
export interface CountedOnce {
  groups: PurchaseGroup[]
  countedOnceCents: number         // Σ group amounts — each purchase once
  naiveSumCents: number            // Σ every record in every source (what adding the sources together would give)
  duplicateCents: number           // naive − counted once = what confirmed matches keep from being double counted
  multiSourceCount: number         // purchases seen in ≥ 2 sources (confirmed)
  singleSourceCount: number        // purchases seen in exactly one source (unmatched or genuinely only there)
  singleSourceBySource: Record<PurchaseSource, { count: number; cents: number }>
  disagreeCount: number
}

export function countOnce(nodes: readonly PurchaseNode[], edges: readonly PurchaseEdge[]): CountedOnce {
  const parent = new Map<string, string>(nodes.map((n) => [n.key, n.key]))
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r) as string; parent.set(k, r); return r }
  for (const e of edges) if (parent.has(e.a) && parent.has(e.b)) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb) }
  const buckets = new Map<string, PurchaseNode[]>()
  for (const n of nodes) { const r = find(n.key); (buckets.get(r) ?? buckets.set(r, []).get(r)!).push(n) }
  const empty = () => ({ count: 0, cents: 0 })
  const singleSourceBySource: CountedOnce['singleSourceBySource'] = { receipt: empty(), bank_txn: empty(), check: empty(), qb_purchase: empty(), vehicle_event: empty() }
  const groups: PurchaseGroup[] = []
  for (const members of buckets.values()) {
    const rep = members.slice().sort((x, y) => PRECEDENCE.indexOf(x.source) - PRECEDENCE.indexOf(y.source))[0]
    const amounts = members.map((m) => m.amountCents)
    const spread = Math.max(...amounts) - Math.min(...amounts)
    const sources = [...new Set(members.map((m) => m.source))]
    groups.push({ members, sources, amountCents: rep.amountCents, date: rep.date, label: rep.label, amountsDisagree: spread > Math.max(50, Math.round(rep.amountCents * 0.01)) })
    if (sources.length === 1 && members.length === 1) { singleSourceBySource[rep.source].count++; singleSourceBySource[rep.source].cents += rep.amountCents }
  }
  groups.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  const countedOnceCents = groups.reduce((s, g) => s + g.amountCents, 0)
  const naiveSumCents = nodes.reduce((s, n) => s + n.amountCents, 0)
  const multi = groups.filter((g) => g.members.length > 1).length
  return {
    groups, countedOnceCents, naiveSumCents, duplicateCents: naiveSumCents - countedOnceCents,
    multiSourceCount: multi, singleSourceCount: groups.length - multi, singleSourceBySource,
    disagreeCount: groups.filter((g) => g.amountsDisagree).length,
  }
}
