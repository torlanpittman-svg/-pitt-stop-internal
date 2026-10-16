/**
 * Catalog IDENTITY resolution — which service_catalog row a free-text service label refers to.
 *
 * This is the single, PURE (name + alias) matching policy, separate from live-QB-item mapping.
 * `apps/workflow/estimate-db` stamps `job_services.catalog_id` with this at insert/rename so a
 * service keeps a STABLE catalog identity even after its label is edited; `apps/quickbooks/
 * retail-item-map` reuses the SAME normalizer + key index for its live-item mapping so there is
 * exactly one matching policy (not a parallel resolver). No QB calls, no live-item validation,
 * no qb_sync_enabled gating happen here — those stay at payload-build time in retail-item-map.
 *
 * Only NON-archived catalog rows are matchable: an archived item must never be (re)acquired by a
 * label edit. Matching is case/spacing-insensitive against the catalog name and every alias.
 */
import { getDb } from '@/platform/db'
import { isNull } from 'drizzle-orm'
import { serviceCatalog, serviceAliases } from './schema'
import { isGenericOdorKey } from './service-interpret'

/** Normalize a service label for matching: trim, collapse inner whitespace, lowercase. */
export const normalizeServiceKey = (s?: string | null): string =>
  (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Build a normalized name/alias → catalogId index over the given rows, preserving the established
 * retail mapper's precedence: a catalog NAME always beats an alias (an exact canonical name like
 * "Complete Detail" wins even when another catalog carries it as an alias), and an alias only fills
 * a key that no name (or earlier alias) already claimed. Among duplicate catalog names the last one
 * seen wins, matching the original mapper. Callers pass only the rows eligible to match (e.g.
 * non-archived).
 */
export function buildCatalogKeyIndex(
  cats: ReadonlyArray<{ id: string; name: string }>,
  aliases: ReadonlyArray<{ catalogId: string; alias: string }>,
): Map<string, string> {
  const byKey = new Map<string, string>()
  const known = new Set(cats.map((c) => c.id))
  // Names first (last writer wins) so a canonical name always outranks any alias.
  for (const c of cats) { const k = normalizeServiceKey(c.name); if (k) byKey.set(k, c.id) }
  // Aliases only fill keys no name (or earlier alias) already claimed (first alias writer wins).
  for (const a of aliases) {
    if (!known.has(a.catalogId)) continue
    const k = normalizeServiceKey(a.alias)
    if (k && !byKey.has(k)) byKey.set(k, a.catalogId)
  }
  return byKey
}

/**
 * Resolve a set of service titles to their catalog ids, keyed by the NORMALIZED title. Titles
 * with no (non-archived) catalog match are omitted — they are genuinely custom (Labor fallback).
 */
export async function resolveCatalogIds(titles: string[]): Promise<Map<string, string>> {
  // Generic odor wording ("Odor Treatment", "remove smell") is deliberately NOT auto-stamped: under
  // the owner's definitions it could mean duct cleaning, ozone, or the Complete package, so the
  // estimate asks which one (apps/workflow/estimate-review). Specific names still resolve.
  const wanted = new Set(titles.map(normalizeServiceKey).filter((k) => k && !isGenericOdorKey(k)))
  if (wanted.size === 0) return new Map()
  const db = getDb()
  const [cats, aliases] = await Promise.all([
    db.select({ id: serviceCatalog.id, name: serviceCatalog.name }).from(serviceCatalog).where(isNull(serviceCatalog.archivedAt)),
    db.select({ catalogId: serviceAliases.catalogId, alias: serviceAliases.alias }).from(serviceAliases),
  ])
  const index = buildCatalogKeyIndex(cats, aliases)
  const out = new Map<string, string>()
  for (const key of wanted) { const id = index.get(key); if (id) out.set(key, id) }
  return out
}

/** Resolve a single service title to its catalog id, or null when it is genuinely custom. */
export async function resolveCatalogId(title: string): Promise<string | null> {
  const key = normalizeServiceKey(title)
  if (!key) return null
  return (await resolveCatalogIds([title])).get(key) ?? null
}
