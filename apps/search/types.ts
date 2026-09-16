/**
 * Global operational search — shared types.
 *
 * ONE coherent search service (apps/search) queries the CANONICAL operational records already in Pitt
 * Stop OS — it never creates parallel customer/vehicle/job/service tables. Categories map to existing
 * tables; every navigable result routes to an EXISTING detail page (no duplicate screens):
 *   customers      → customers directory (apps/directory)         (contact card; tap-to-call)
 *   vehicles       → workflow.vehicles (+ inventory / linked job)  → /orders/[id] or /auto-sales/[id]
 *   jobs           → workflow.service_orders                       → /orders/[id]
 *   auto_sales     → auto_sales.inventory_vehicles                 → /auto-sales/[id]
 *   receipts       → auto_sales.vehicle_documents  (MANAGER-only)  → /auto-sales/[id]
 *   checks         → checks.checks                 (MANAGER-only)  → /checks/[id]
 *
 * Authorization is enforced SERVER-SIDE by role scope (see authz.ts): ordinary employees never receive
 * the manager-only financial categories (receipts, checks). No secrets/credentials/PII beyond the
 * minimal display fields are ever placed on a result.
 */

export type SearchCategory =
  | 'customers'
  | 'vehicles'
  | 'jobs'
  | 'auto_sales'
  | 'receipts'
  | 'checks'

/** All categories, in display order. */
export const CATEGORY_ORDER: SearchCategory[] = [
  'customers',
  'vehicles',
  'jobs',
  'auto_sales',
  'receipts',
  'checks',
]

export const CATEGORY_LABEL: Record<SearchCategory, string> = {
  customers:  'Customers',
  vehicles:   'Vehicles',
  jobs:       'Jobs',
  auto_sales: 'Auto Sales',
  receipts:   'Receipts',
  checks:     'Checks',
}

/** Manager-only (financial) categories. Ordinary employees never receive these. */
export const MANAGER_ONLY_CATEGORIES: ReadonlySet<SearchCategory> = new Set(['receipts', 'checks'])

/** A single search hit. Ranking + limits are applied to these. `tier` is match strength (0 best). */
export interface SearchResult {
  category: SearchCategory
  id: string
  /** Canonical destination page, or null when the record has no standalone page (customer contact card). */
  href: string | null
  title: string
  subtitle: string
  /** Optional extra context line (e.g. VIN ····1234 · status). */
  meta?: string
  /** Small status/type chip. */
  badge?: string
  /** Tap-to-call number (customers) — never a nav link. */
  phone?: string
  /** Match tier: 0 exact · 1 prefix · 2 partial. Lower ranks first. */
  tier: number
  /** Deterministic secondary sort key (recency ISO or label); higher sorts first within a tier. */
  sortKey?: string
}

export interface SearchResponse {
  ok: true
  query: string
  /** Results grouped by category, already ranked + capped. */
  groups: Array<{ category: SearchCategory; label: string; results: SearchResult[] }>
  total: number
  truncated: boolean
}

/** Per-category and overall result caps — protect against unbounded result sizes. */
export const PER_CATEGORY_LIMIT = 8
export const OVERALL_LIMIT = 30

/** Query length guards. Broad text needs >= MIN; anything over MAX is rejected as abusive/malformed. */
export const MIN_QUERY_LENGTH = 2
export const MAX_QUERY_LENGTH = 100
