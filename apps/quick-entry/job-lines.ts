/** Pure helpers for the Quick Entry line list (billable total excludes $0 tech notes). */
export interface JobLine {
  key: string; catalogId: string | null; kind: 'package' | 'addon' | 'custom'
  name: string; size?: string | null; condition?: string | null; priceCents: number
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
