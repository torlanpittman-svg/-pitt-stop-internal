/**
 * Service classifier. Maps free-text service labels (service_orders.services, job line-item
 * names, service_catalog names, Quick Entry "Other" text) onto the marketing taxonomy in
 * types.ts. Deterministic + keyword-based (no AI) so segmentation and attribution are stable
 * and testable. We never invent a service that was not performed — unknown text → 'other'.
 */
import type { ServiceCategory } from './types'

// Order matters: ceramic is checked before correction because "ceramic" wins when both appear.
const RULES: Array<{ category: ServiceCategory; patterns: RegExp[] }> = [
  {
    category: 'ceramic',
    patterns: [/\bceramic\b/i, /\bcoating\b/i, /\bgraphene\b/i, /\bceramic\s*coat/i],
  },
  {
    category: 'paint_correction',
    patterns: [/\bpaint\s*correction\b/i, /\bcorrection\b/i, /\bpolish/i, /\bbuff/i, /\bswirl/i, /\boxidation\b/i, /\bcompound/i, /\bcut\s*and\s*polish\b/i, /\bwet\s*sand/i],
  },
  {
    category: 'interior',
    patterns: [/\binterior\b/i, /\bupholstery\b/i, /\bshampoo\b/i, /\bodor\b/i, /\bozone\b/i, /\bheadliner\b/i, /\bcarpet\b/i, /\bstain\b/i, /\bseats?\b/i, /\bleather\b/i, /\bpet\s*hair\b/i],
  },
  {
    category: 'general',
    patterns: [/\bdetail\b/i, /\bwash\b/i, /\bwax\b/i, /\bexterior\b/i, /\bclay\b/i, /\bfull\s*detail\b/i, /\bmaintenance\b/i],
  },
]

/** Classify a single free-text label. Returns null when nothing matches (caller decides fallback). */
export function classifyServiceLabel(label: string | null | undefined): ServiceCategory | null {
  if (!label) return null
  const text = label.trim()
  if (!text) return null
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) return rule.category
  }
  return null
}

/**
 * Classify every category present across a set of labels (a job can carry several services).
 * Returns a de-duplicated, priority-ordered list. Empty → the caller treats it as 'other'.
 */
export function classifyServices(labels: Array<string | null | undefined>): ServiceCategory[] {
  const found = new Set<ServiceCategory>()
  for (const label of labels) {
    const c = classifyServiceLabel(label)
    if (c) found.add(c)
  }
  // Priority order for display/segmentation.
  const order: ServiceCategory[] = ['ceramic', 'paint_correction', 'interior', 'general']
  return order.filter((c) => found.has(c))
}

/** True when any label indicates the given premium category. */
export function hasServiceCategory(labels: Array<string | null | undefined>, category: ServiceCategory): boolean {
  return classifyServices(labels).includes(category)
}

/** The single "headline" category for a job — highest-priority match, else 'other'. */
export function primaryServiceCategory(labels: Array<string | null | undefined>): ServiceCategory {
  return classifyServices(labels)[0] ?? 'other'
}
