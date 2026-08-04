/** Pure helpers for adding services to a Work Board order (display-only list). */

/** Case-insensitive match against the existing list. */
export function isDuplicateService(existing: string[], name: string): boolean {
  const n = name.trim().toLowerCase()
  return existing.some((s) => s.trim().toLowerCase() === n)
}

/** Split requested services into brand-new vs. already-present (case-insensitive),
 *  trimming and dropping blanks. Used to guard accidental duplicate adds. */
export function partitionServices(existing: string[], requested: string[]): { fresh: string[]; duplicates: string[] } {
  const fresh: string[] = []
  const duplicates: string[] = []
  const seen = existing.map((s) => s.trim().toLowerCase())
  for (const raw of requested) {
    const name = raw.trim()
    if (!name) continue
    if (seen.includes(name.toLowerCase())) duplicates.push(name)
    else { fresh.push(name); seen.push(name.toLowerCase()) }  // also dedupe within the same request
  }
  return { fresh, duplicates }
}
