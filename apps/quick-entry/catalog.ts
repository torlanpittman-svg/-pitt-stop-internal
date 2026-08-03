/**
 * Quick Entry catalog — pure helpers (no I/O), unit-testable.
 * Price resolution + seed integrity checks. Prices are in cents.
 */
import type { SeedItem } from './seed-data'

export function centsToDollars(c: number | null | undefined): string {
  return c == null ? '—' : `$${(c / 100).toFixed(2)}`
}

interface TierLike { size: string; condition: string; startPriceCents: number }

/** Pick the tier price for a size/condition ('' = none). Null if no match. */
export function pickTierPrice(tiers: TierLike[], size = '', condition = ''): number | null {
  const t = tiers.find((t) => t.size === (size || '') && t.condition === (condition || ''))
  return t ? t.startPriceCents : null
}

/** Starting price for an item: a matching tier for size/condition items, else the flat default. */
export function resolveStartPriceCents(
  item: { defaultPriceCents: number | null; hasSize?: boolean; hasCondition?: boolean },
  tiers: TierLike[],
  size = '',
  condition = '',
): number | null {
  if (item.hasSize || item.hasCondition) return pickTierPrice(tiers, size, condition)
  return item.defaultPriceCents
}

// ── Display / partition helpers (used by the read-only admin view) ──────────
export interface CatalogLike {
  kind: string; source?: string | null; quickEntry?: boolean
  defaultPriceCents: number | null; hasSize?: boolean; hasCondition?: boolean
}
export function isDealerPackage(i: { source?: string | null }): boolean {
  return i.source === 'dealer_rules'
}
export function partitionCatalog<T extends CatalogLike>(items: T[]): {
  retailPackages: T[]; dealerPackages: T[]; quickAddons: T[]; customAddons: T[]
} {
  return {
    retailPackages: items.filter((i) => i.kind === 'package' && !isDealerPackage(i)),
    dealerPackages: items.filter((i) => isDealerPackage(i)),
    quickAddons:    items.filter((i) => i.kind === 'addon' && i.quickEntry),
    customAddons:   items.filter((i) => i.kind === 'addon' && !i.quickEntry),
  }
}
/** Human label for a card's starting price: "from $X" for tiered, else the flat price. */
export function startingPriceLabel(
  i: { defaultPriceCents: number | null; hasSize?: boolean; hasCondition?: boolean },
  tiers: { startPriceCents: number }[],
): string {
  if (i.hasSize || i.hasCondition) {
    if (!tiers.length) return '—'
    return `from ${centsToDollars(Math.min(...tiers.map((t) => t.startPriceCents)))}`
  }
  return centsToDollars(i.defaultPriceCents)
}

export interface SeedIssue { slug: string; issue: string }

/** Structural checks the seed must satisfy (drives the regression test). */
export function validateCatalogSeed(items: SeedItem[]): SeedIssue[] {
  const issues: SeedIssue[] = []
  const slugs = new Set<string>()
  for (const it of items) {
    if (slugs.has(it.slug)) issues.push({ slug: it.slug, issue: 'duplicate slug' })
    slugs.add(it.slug)
    const tiered = Boolean(it.hasSize || it.hasCondition)
    if (tiered && (!it.tiers || it.tiers.length === 0)) issues.push({ slug: it.slug, issue: 'tiered item missing tiers' })
    if (tiered && it.defaultPriceCents != null) issues.push({ slug: it.slug, issue: 'tiered item must not have a flat default price' })
    if (!tiered && it.defaultPriceCents == null && !it.reviewFlag) issues.push({ slug: it.slug, issue: 'flat item missing default price (and not review-flagged)' })
    if (it.qbItemStatus === 'new_create_at_golive' && it.qbSyncEnabled) issues.push({ slug: it.slug, issue: 'new QB item must have sync disabled' })
    if (it.qbItemStatus === 'mapping_review' && it.qbSyncEnabled) issues.push({ slug: it.slug, issue: 'mapping-review item must have sync disabled' })
    for (const t of it.tiers ?? []) if (t.startPriceCents <= 0) issues.push({ slug: it.slug, issue: `tier ${t.size}/${t.condition} price must be > 0` })
  }
  return issues
}
