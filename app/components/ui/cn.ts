/**
 * Tiny className combiner — joins truthy class fragments with a single space.
 * A dependency-free stand-in for clsx (we intentionally add no npm package).
 * Later fragments win only by convention; this does NOT dedupe conflicting
 * Tailwind utilities, so put overrides last and keep variant maps disjoint.
 */
export type ClassValue = string | number | false | null | undefined

export function cn(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ')
}
