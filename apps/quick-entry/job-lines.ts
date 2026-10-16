/** Pure helpers for the Quick Entry line list (billable total excludes $0 tech notes). */
export interface JobLine {
  key: string; catalogId: string | null; kind: 'package' | 'addon' | 'custom'
  name: string; size?: string | null; condition?: string | null; priceCents: number
  /** What the employee actually typed (kept; never shown on the invoice). */
  entryText?: string | null
  /** Job-specific area/component ("passenger seat"), separate from the service identity. */
  detail?: string | null
  matchMethod?: string | null
  /** Confirmed physical part and who supplies it (the name is the part description). */
  partSupply?: 'shop' | 'customer' | null
  tires?: { mode: 'supply' | 'install_customer' | 'both'; quantity: number } | null
  /** An open question for this line (which service / part or service / tire scope). */
  pending?: PendingChoice | null
  /** The real catalog options the interpreter offered — lets the employee correct a match. */
  alts?: InterpCandidate[]
}

// ── Rushed-entry interpretation → reviewable lines (pure; the screen just renders these) ───────────
export interface InterpCandidate { catalogId: string; name: string; description?: string; role?: string | null }
export interface InterpEntry {
  entry: string; corrected: string; status: 'resolved' | 'choose' | 'none'; intent: string
  area: string | null; part: { description: string } | null; question: string | null; source: string; ai?: string
  candidates: InterpCandidate[]
}
export interface PendingChoice { intent: string; question: string | null; candidates: InterpCandidate[]; part: { description: string } | null }

const METHOD: Record<string, string> = { exact: 'exact', alias: 'alias', rule: 'rule', keyword: 'suggestion', ai: 'suggestion' }
const key = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * New lines for interpreted entries. An established, unambiguous match is added directly (fast); an
 * odor / tire / part / several-options entry is added AS TYPED with a short question to answer; an
 * unrecognized entry is added as typed. Nothing typed is dropped, no price is set, and an entry that
 * duplicates a line already selected is skipped.
 */
export function linesFromEntries(entries: InterpEntry[], existing: JobLine[], nextKey: () => string): JobLine[] {
  const out: JobLine[] = []
  const seen = new Set(existing.map((l) => `${l.catalogId ?? key(l.name)}|${key(l.detail)}`))
  for (const e of entries) {
    const raw = (e.entry ?? '').trim()
    if (!raw) continue
    const base = { key: nextKey(), priceCents: 0, entryText: raw, detail: e.area ?? null, size: null, condition: null }
    const top = e.candidates[0]
    let line: JobLine
    if (e.status === 'resolved' && top && e.intent !== 'part' && e.intent !== 'tires') {
      line = { ...base, catalogId: top.catalogId, kind: 'package', name: top.name, matchMethod: METHOD[e.source] ?? 'suggestion', alts: e.candidates }
    } else if (e.intent === 'part' || e.intent === 'tires' || e.intent === 'odor' || e.candidates.length > 0) {
      line = { ...base, catalogId: null, kind: 'custom', name: raw, alts: e.candidates,
        pending: { intent: e.intent, question: e.question, candidates: e.intent === 'part' || e.intent === 'tires' ? [] : e.candidates, part: e.part } }
    } else {
      line = { ...base, catalogId: null, kind: 'custom', name: raw }
    }
    const k = `${line.catalogId ?? key(line.name)}|${key(line.detail)}`
    if (seen.has(k)) continue
    seen.add(k); out.push(line)
  }
  return out
}

/** The employee picked one of the offered real catalog services. */
export function chooseCandidate(l: JobLine, c: InterpCandidate): JobLine {
  return { ...l, catalogId: c.catalogId, kind: 'package', name: c.name, matchMethod: l.pending?.intent === 'odor' ? 'rule' : 'suggestion', pending: null, partSupply: null, tires: null }
}
/** Keep the employee's own wording. Deliberately NOT a confirmed one-off: the manager's estimate review
 *  still asks about odor / part wording, so a quick tap can't skip those checks. */
export function keepAsTyped(l: JobLine): JobLine {
  return { ...l, catalogId: null, kind: 'custom', name: l.entryText || l.name, matchMethod: null, pending: null, partSupply: null, tires: null }
}
/** Confirmed physical part (special order or the customer's) — its installation labor gets reviewed. */
export function choosePart(l: JobLine, supply: 'shop' | 'customer'): JobLine {
  return { ...l, catalogId: null, kind: 'custom', name: l.pending?.part?.description || l.entryText || l.name, partSupply: supply, matchMethod: null, pending: null, tires: null }
}
const TIRE_TEXT = { supply: 'we supply', install_customer: 'install customer’s tires', both: 'we supply + install' } as const
/** "Replace tires" clarified: who supplies them, and how many (1–12). */
export function chooseTires(l: JobLine, mode: 'supply' | 'install_customer' | 'both', quantity: number): JobLine | null {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) return null
  return { ...l, catalogId: null, kind: 'custom', name: `${quantity} ${quantity === 1 ? 'tire' : 'tires'} — ${TIRE_TEXT[mode]}`, tires: { mode, quantity }, partSupply: null, matchMethod: null, pending: null }
}
/** Re-open the choice to correct a match (same real options as before). */
export function reopenChoice(l: JobLine): JobLine {
  return { ...l, pending: { intent: 'service', question: 'Pick the right service, or keep what was typed.', candidates: l.alts ?? [], part: null } }
}

export function jobTotalCents(lines: JobLine[]): number {
  return lines.reduce((s, l) => s + (Number.isFinite(l.priceCents) ? l.priceCents : 0), 0)
}

/** Dollar string ($X.XX) from cents. */
export function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/** Human size/condition suffix for a line label. */
export function tierLabel(size?: string | null, condition?: string | null): string {
  const s = (size ?? '').replace(/_/g, ' ')
  const c = condition ?? ''
  return [s, c].filter(Boolean).join(' · ')
}

/** Selected service labels for the Work Board card: standard package names plus
 *  the custom "Other" text. Trims and drops blanks (e.g. an empty Other line). */
export function serviceLabels(lines: Pick<JobLine, 'name'>[]): string[] {
  return lines.map((l) => l.name.trim()).filter(Boolean)
}
