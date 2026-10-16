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
import { and, eq, isNull } from 'drizzle-orm'
import { serviceCatalog, serviceAliases } from './schema'
import { isGenericOdorKey } from './service-interpret'

/** Normalize a service label for matching: trim, collapse inner whitespace, lowercase. */
export const normalizeServiceKey = (s?: string | null): string =>
  (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Build a normalized name/alias → catalogId index. Deterministic — the database's row order can never
 * decide a match. Precedence, highest first:
 *   1. the NAME of an active row      2. the NAME of a retired (inactive, non-archived) row
 *   3. an ALIAS of an active row      4. an ALIAS of a retired row
 * A key already claimed by a higher tier is never re-claimed. Within one tier, a key that two or more
 * rows claim is AMBIGUOUS: it resolves to nothing (and is reported) so the line is reviewed instead of
 * guessed — e.g. "Ceramic Coating" as an alias of both the 1-year and 3-year rows. So "Ozone" (alias of
 * the active Ozone Treatment and of the retired "Odor / Ozone Treatment") always means Ozone Treatment.
 * `active` defaults to true (callers that pass only eligible rows need not set it).
 */
export function buildCatalogKeyIndexDetailed(
  cats: ReadonlyArray<{ id: string; name: string; active?: boolean | null }>,
  aliases: ReadonlyArray<{ catalogId: string; alias: string }>,
): { index: Map<string, string>; ambiguous: Set<string> } {
  const index = new Map<string, string>()
  const ambiguous = new Set<string>()
  const activeById = new Map(cats.map((c) => [c.id, c.active !== false]))
  const tiers: Array<Array<{ key: string; id: string }>> = [
    cats.filter((c) => c.active !== false).map((c) => ({ key: normalizeServiceKey(c.name), id: c.id })),
    cats.filter((c) => c.active === false).map((c) => ({ key: normalizeServiceKey(c.name), id: c.id })),
    aliases.filter((a) => activeById.get(a.catalogId) === true).map((a) => ({ key: normalizeServiceKey(a.alias), id: a.catalogId })),
    aliases.filter((a) => activeById.get(a.catalogId) === false).map((a) => ({ key: normalizeServiceKey(a.alias), id: a.catalogId })),
  ]
  for (const tier of tiers) {
    const claims = new Map<string, Set<string>>()
    for (const { key, id } of tier) if (key && !index.has(key) && !ambiguous.has(key)) (claims.get(key) ?? claims.set(key, new Set()).get(key)!).add(id)
    for (const [key, ids] of claims) {
      if (ids.size === 1) index.set(key, [...ids][0])
      else ambiguous.add(key)
    }
  }
  return { index, ambiguous }
}

/** The name/alias → catalogId index (see buildCatalogKeyIndexDetailed for the precedence rules). */
export function buildCatalogKeyIndex(
  cats: ReadonlyArray<{ id: string; name: string; active?: boolean | null }>,
  aliases: ReadonlyArray<{ catalogId: string; alias: string }>,
): Map<string, string> {
  return buildCatalogKeyIndexDetailed(cats, aliases).index
}

/** Normalized labels that name more than one live (non-archived) catalog service at the same precedence
 *  — a line saved with such a label and no catalog identity must be reviewed, never guessed. */
export async function ambiguousServiceKeys(): Promise<Set<string>> {
  const db = getDb()
  const [cats, aliases] = await Promise.all([
    db.select({ id: serviceCatalog.id, name: serviceCatalog.name, active: serviceCatalog.active }).from(serviceCatalog).where(isNull(serviceCatalog.archivedAt)),
    db.select({ catalogId: serviceAliases.catalogId, alias: serviceAliases.alias }).from(serviceAliases),
  ])
  return buildCatalogKeyIndexDetailed(cats, aliases).ambiguous
}

/**
 * Resolve a set of service titles to their catalog ids, keyed by the NORMALIZED title. Titles
 * with no (non-archived) catalog match are omitted — they are genuinely custom (Labor fallback).
 * Only ACTIVE rows are stamped onto new lines: a row retired from new picks (e.g. the legacy combined
 * "Odor / Ozone Treatment", 0053) keeps its existing lines but never acquires new ones by label.
 */
export async function resolveCatalogIds(titles: string[]): Promise<Map<string, string>> {
  // Generic odor wording ("Odor Treatment", "remove smell") is deliberately NOT auto-stamped: under
  // the owner's definitions it could mean duct cleaning, ozone, or the Complete package, so the
  // estimate asks which one (apps/workflow/estimate-review). Specific names still resolve.
  const wanted = new Set(titles.map(normalizeServiceKey).filter((k) => k && !isGenericOdorKey(k)))
  if (wanted.size === 0) return new Map()
  const db = getDb()
  const [cats, aliases] = await Promise.all([
    db.select({ id: serviceCatalog.id, name: serviceCatalog.name }).from(serviceCatalog).where(and(isNull(serviceCatalog.archivedAt), eq(serviceCatalog.active, true))),
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
